// Laya turn wiring (LAYA_PLAN.md phases 3–4): intent-first cascade, observer
// triage, salience gating, and the advisory patch-plausibility signal.
//
// Layout follows the repo rule: logic lives in small pure functions below
// (testable without I/O); the async shells at the bottom are thin and fail
// OPEN — a Laya outage must never break a turn, it just degrades to the
// chat path. Everything here is behind env flags that default OFF
// (see readLayaRuntimeConfig in src/config.ts).

import type {
  Action,
  ActorPatch,
  ConsequenceResult,
  EngineConfig,
  World,
} from "../types.js";
import type {
  DecisionDiagram,
  Intent,
  LayaAnswer,
  LayaQuestion,
} from "../decision/decisionTypes.js";
import { runDiagram, type DiagramRunResult } from "../decision/diagramRunner.js";
import {
  OBSERVER_TRIAGE_QUESTION,
  SALIENCE_QUESTION,
  SELECTION_CASCADE,
} from "../decision/diagrams.js";
import { buildIntentState, buildRenderabilityState } from "../decision/decisionState.js";
import { LayaClient } from "../decision/layaClient.js";
import { createLayaClient } from "../decision/wiring.js";
import {
  peekDiagramCache,
  planDiagram,
  type ChatComplete,
} from "../decision/questionPlanner.js";
import {
  isLayaIntentFirst,
  readLayaPlausibility,
  readLayaRuntimeConfig,
  readLayaSalienceThreshold,
  type LayaConfig,
  type LayaMode,
} from "../config.js";
import { perceiverIds } from "./validate/narrative.js";
import type { Logger } from "../logging/logger.js";
import { errorMessage } from "../util/errors.js";

export type { ChatComplete };

/** Everything a turn needs to talk to the Laya decision layer. */
export type LayaTurnWiring = {
  client: LayaClient;
  config: LayaConfig;
  /** Salience score (1–5) below which model memory/belief appends are dropped. */
  salienceThreshold: number;
  /** Advisory patch-plausibility scoring on retry feedback. Never enforcing. */
  plausibility: boolean;
  /** Chat completion hook for the dynamic question planner. */
  plannerChatComplete?: ChatComplete;
};

export type LayaWiringEnvOptions = {
  /** Test/embedding seam: use this wiring instead of reading env. */
  injected?: LayaTurnWiring;
  plannerChatComplete?: ChatComplete;
  env?: Record<string, string | undefined>;
};

/**
 * Thin shell: resolve the turn's Laya wiring. Returns undefined when Laya
 * is off (the default) so callers keep the pure chat path.
 */
export function layaWiringFromEnv(
  opts: LayaWiringEnvOptions = {},
): LayaTurnWiring | undefined {
  if (opts.injected !== undefined) return opts.injected;
  const env = opts.env ?? process.env;
  const config = readLayaRuntimeConfig(env);
  if (config.mode === "off") return undefined;
  return {
    client: createLayaClient(config),
    config,
    salienceThreshold: readLayaSalienceThreshold(env),
    plausibility: readLayaPlausibility(env),
    plannerChatComplete: opts.plannerChatComplete,
  };
}

/** Re-export for callers that only need the predicate. */
export { isLayaIntentFirst };

// ---------------------------------------------------------------------------
// Intent derivation (pure)
// ---------------------------------------------------------------------------

const INTENT_KINDS: Intent["kind"][] = [
  "speak",
  "move",
  "interact",
  "gesture",
  "wait",
];

/**
 * Derive an Intent from the static SELECTION_CASCADE decisions
 * (intent_kind -> addressee|destination|target_object -> manner). Pure.
 * Mirrors the cascade reading inside LayaSelectionEngine so the intent-first
 * step and the selection engine agree on what the cascade decided.
 */
export function intentFromCascadeDecisions(
  decisions: Record<string, LayaAnswer>,
): Intent {
  const kindRaw = decisions["intent_kind"];
  const kind =
    kindRaw?.type === "choice" &&
    (INTENT_KINDS as string[]).includes(kindRaw.winner)
      ? (kindRaw.winner as Intent["kind"])
      : "wait";
  const intent: Intent = { kind };
  const addressee = decisions["addressee"];
  const destination = decisions["destination"];
  const targetObject = decisions["target_object"];
  if (kind === "speak" && addressee?.type === "choice") {
    intent.targetKind =
      addressee.winner === "nobody in particular" ? "none" : "actor";
  } else if (kind === "move" && destination?.type === "choice") {
    intent.targetKind =
      destination.winner === "wander aimlessly"
        ? "none"
        : destination.winner === "toward someone"
          ? "actor"
          : "landmark";
  } else if (kind === "interact" && targetObject?.type === "choice") {
    intent.targetKind = "object";
    intent.manner = targetObject.winner;
  }
  const manner = decisions["manner"];
  if (manner?.type === "choice" && intent.manner === undefined) {
    intent.manner = manner.winner;
  }
  return intent;
}

const INTENT_KEYWORDS: Array<{ kind: Intent["kind"]; pattern: RegExp }> = [
  {
    kind: "speak",
    pattern:
      /\b(say|says|said|saying|tell|tells|told|ask|asks|asked|talk|talks|talking|speak|speaks|speaking|shout|shouts|whisper|whispers|greet|greets|answer|answers|reply|replies|announce)\b/i,
  },
  {
    kind: "move",
    pattern:
      /\b(go|goes|going|walk|walks|walking|run|runs|running|move|moves|moving|head|heads|heading|approach|approaches|leave|leaves|leaving|enter|enters|step|steps|stroll|wander|wanders|hurry|march)\b/i,
  },
  {
    kind: "interact",
    pattern:
      /\b(use|uses|using|take|takes|taking|pick|picks|grab|grabs|open|opens|close|closes|examine|examines|inspect|brew|brews|pour|pours|hold|holds|type|types|press|push|pull|lift)\b/i,
  },
  {
    kind: "gesture",
    pattern:
      /\b(nod|nods|wave|waves|smile|smiles|laugh|laughs|shrug|shrugs|gesture|point|points|bow|bows|wink|winks|frown|thumbs)\b/i,
  },
];

/**
 * Best-effort mapping of free-form decision text to an intent kind, for
 * dynamic (planner-generated) diagrams whose nodes are not the static
 * cascade's. Pure.
 */
export function classifyIntentKind(text: string): Intent["kind"] {
  for (const { kind, pattern } of INTENT_KEYWORDS) {
    if (pattern.test(text)) return kind;
  }
  return "wait";
}

function decisionAnswerText(answer: LayaAnswer | undefined): string {
  if (answer === undefined) return "";
  if (answer.type === "choice") return answer.winner;
  if (answer.type === "noul") return answer.pTrue >= 0.5 ? "true" : "false";
  return String(Math.round(answer.expected));
}

/**
 * Derive the turn's Intent from a diagram run. Static cascade runs use the
 * node ids; dynamic diagrams classify the terminal (or last visited)
 * decision's winner text. Pure.
 */
export function intentFromDiagramRun(
  diagram: DecisionDiagram,
  run: Pick<DiagramRunResult, "decisions" | "path">,
): Intent {
  if ("intent_kind" in run.decisions) {
    return intentFromCascadeDecisions(run.decisions);
  }
  const lastId = run.path.length > 0 ? run.path[run.path.length - 1] : diagram.terminal;
  return { kind: classifyIntentKind(decisionAnswerText(run.decisions[lastId])) };
}

// ---------------------------------------------------------------------------
// Observer triage (pure question building / answer parsing / patch filter)
// ---------------------------------------------------------------------------

/** Question key for one observer's triage noul. Pure. */
export function triageQuestionId(actorId: string): string {
  return `triage_${actorId}`;
}

/**
 * One noul per perceiving observer: "would {name} have a notable inner
 * reaction to this event?" — batched into a single decide() call. Pure.
 */
export function buildTriageQuestions(
  observers: Array<{ id: string; name: string }>,
): Record<string, LayaQuestion> {
  const questions: Record<string, LayaQuestion> = {};
  for (const o of observers) {
    questions[triageQuestionId(o.id)] = {
      type: "noul",
      instructions: `Would ${o.name} have a notable inner reaction to this event — surprise, concern, amusement, irritation, curiosity? ${OBSERVER_TRIAGE_QUESTION.instructions}`,
    };
  }
  return questions;
}

/**
 * Parse the batched triage answers into observerId -> notable. A missing or
 * malformed answer counts as "not notable". Pure.
 */
export function parseTriageAnswers(
  answers: Record<string, LayaAnswer>,
  observerIds: string[],
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of observerIds) {
    const a = answers[triageQuestionId(id)];
    out[id] = a !== undefined && a.type === "noul" && a.pTrue >= 0.5;
  }
  return out;
}

/**
 * Drop thought/emotion fields from observer patches for triaged-out
 * observers. Patches for directly-addressed observers (addresseeId) are
 * always kept, as are all other patch fields (position, pose, memories —
 * salience gates those separately). Pure.
 */
export function filterObserverPatches(
  patches: ActorPatch[],
  notable: Record<string, boolean>,
  addresseeId: string | undefined,
): ActorPatch[] {
  return patches.map((p) => {
    if (p.actorId === addresseeId || notable[p.actorId] === true) return p;
    if (p.thoughts === undefined && p.emotion === undefined) return p;
    const rest: ActorPatch = { ...p };
    delete rest.thoughts;
    delete rest.emotion;
    return rest;
  });
}

// ---------------------------------------------------------------------------
// Salience (pure)
// ---------------------------------------------------------------------------

/**
 * Map a score answer to its 1-based level (ScoreAnswer.expected is the
 * expected level INDEX, possibly fractional). Undefined for missing or
 * non-score answers. Pure.
 */
export function scoreAnswerToLevel(
  answer: LayaAnswer | undefined,
  levelCount = 5,
): number | undefined {
  if (answer === undefined || answer.type !== "score") return undefined;
  return Math.min(levelCount, Math.max(1, Math.round(answer.expected) + 1));
}

/**
 * Drop model-emitted memoriesAppend/beliefsAppend from every actor patch.
 * The deterministic memory append in patchApplier is the floor: with the
 * model appends gone it kicks in, so the turn still records a memory.
 * Pure.
 */
export function stripModelMemoryAppends(
  result: ConsequenceResult,
): ConsequenceResult {
  let changed = false;
  const actorPatches = result.actorPatches.map((p) => {
    if (p.memoriesAppend === undefined && p.beliefsAppend === undefined) return p;
    changed = true;
    const rest: ActorPatch = { ...p };
    delete rest.memoriesAppend;
    delete rest.beliefsAppend;
    return rest;
  });
  return changed ? { ...result, actorPatches } : result;
}

// ---------------------------------------------------------------------------
// Patch plausibility (pure question building / advisory note)
// ---------------------------------------------------------------------------

/**
 * Human-readable labels for the patches plausibility scores: every actor
 * position patch and every object patch that moves or redescribes.
 * Pure.
 */
export function describePatchesForPlausibility(
  result: ConsequenceResult,
): string[] {
  const labels: string[] = [];
  for (const p of result.actorPatches) {
    if (p.x !== undefined && p.y !== undefined) {
      labels.push(`actor "${p.actorId}" moves to (${p.x}, ${p.y})`);
    }
  }
  for (const p of result.objectPatches) {
    const bits: string[] = [];
    if (p.x !== undefined && p.y !== undefined) bits.push(`moves to (${p.x}, ${p.y})`);
    if (p.description !== undefined) bits.push("description changes");
    if (p.w !== undefined || p.h !== undefined) bits.push("size changes");
    if (bits.length > 0) labels.push(`object "${p.objectId}" ${bits.join(", ")}`);
  }
  return labels;
}

const PLAUSIBILITY_INSTRUCTIONS =
  "How physically plausible is this change — could it really happen this way in the scene? " +
  "1 = impossible (teleporting across the room, conjuring objects from nothing), " +
  "5 = completely ordinary and physically consistent.";

/** One 1–5 score question per patch label, batched into one decide(). Pure. */
export function buildPlausibilityQuestions(
  labels: string[],
): Record<string, LayaQuestion> {
  const questions: Record<string, LayaQuestion> = {};
  labels.forEach((label, i) => {
    questions[`plaus_${i}`] = {
      type: "score",
      instructions: `${PLAUSIBILITY_INSTRUCTIONS} Change: ${label}`,
      levels: ["1", "2", "3", "4", "5"],
    };
  });
  return questions;
}

/**
 * Advisory note for retry feedback: one line per patch scored ≤2, e.g.
 * "plausibility 2/5: actor \"dana\" moves to (99, 99)". Undefined when
 * nothing scores low. Advisory ONLY — callers must never invalidate on it.
 * Pure.
 */
export function plausibilityAdvisoryNote(
  scores: Array<{ label: string; level: number }>,
): string | undefined {
  const bad = scores.filter((s) => s.level <= 2);
  if (bad.length === 0) return undefined;
  return (
    "Advisory (Laya patch-plausibility, non-blocking — do not change valid patches just for this):\n" +
    bad.map((s) => `- plausibility ${s.level}/5: ${s.label}`).join("\n")
  );
}

// ---------------------------------------------------------------------------
// Thin async shells (fail open; never throw outward)
// ---------------------------------------------------------------------------

function slimEventText(action: Action, narrative: string): string {
  const text = `Event: ${action.text}\nWhat happened: ${narrative}`
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 900 ? `${text.slice(0, 899)}…` : text;
}

export type ResolveIntentDiagramOptions = {
  mode: LayaMode;
  plannerEnabled: boolean;
  goal: string;
  state: string;
  chatComplete?: ChatComplete;
};

/**
 * Exp-2 S6: how the turn's intent diagram was obtained. Reported on the
 * `planner_diagram_resolved` event so the Phase-5 `layaEvents` histogram
 * can tell "planner ran" from "planner dead".
 */
export type PlannerOutcome =
  /** The planner generated a fresh diagram this turn. */
  | "planned"
  /** The questionPlanner TTL cache served the diagram (no LLM call). */
  | "cache_hit"
  /** Static mode: the planner is never attempted. */
  | "static"
  /** Dynamic mode, but the planner was disabled or had no chat hook. */
  | "skipped"
  /** The planner was attempted and failed; static cascade used. */
  | "fallback";

export type IntentDiagramResolution = {
  diagram: DecisionDiagram;
  outcome: PlannerOutcome;
  /** Human-readable why, carried on the observability event. */
  reason: string;
};

/**
 * Phase 4: in dynamic mode with the planner on, generate the selection
 * diagram per turn (cached by questionPlanner); on ANY planner failure
 * fall back to the static SELECTION_CASCADE. Static mode always uses the
 * static diagram. Reports HOW the diagram was obtained (S6).
 */
export async function resolveIntentDiagramDetailed(
  opts: ResolveIntentDiagramOptions,
): Promise<IntentDiagramResolution> {
  if (
    opts.mode === "dynamic" &&
    opts.plannerEnabled &&
    opts.chatComplete !== undefined
  ) {
    const cached = peekDiagramCache(opts.goal, opts.state);
    try {
      const diagram = await planDiagram(
        opts.goal,
        opts.state,
        opts.chatComplete,
      );
      return cached !== undefined
        ? {
            diagram,
            outcome: "cache_hit",
            reason: "questionPlanner TTL cache hit (no planner LLM call)",
          }
        : {
            diagram,
            outcome: "planned",
            reason: "planner generated a fresh diagram",
          };
    } catch (err) {
      return {
        diagram: SELECTION_CASCADE,
        outcome: "fallback",
        reason: `planner failed (${errorMessage(err)}); using static SELECTION_CASCADE`,
      };
    }
  }
  if (opts.mode !== "dynamic") {
    return {
      diagram: SELECTION_CASCADE,
      outcome: "static",
      reason: `LAYA_MODE=${opts.mode}: the planner only runs in dynamic mode`,
    };
  }
  return {
    diagram: SELECTION_CASCADE,
    outcome: "skipped",
    reason: opts.plannerEnabled
      ? "no planner chat hook wired"
      : "LAYA_PLANNER=0",
  };
}

/**
 * Thin wrapper kept for existing callers/tests that only need the diagram.
 */
export async function resolveIntentDiagram(
  opts: ResolveIntentDiagramOptions,
): Promise<DecisionDiagram> {
  return (await resolveIntentDiagramDetailed(opts)).diagram;
}

export type RunIntentCascadeOptions = {
  mode: LayaMode;
  plannerEnabled: boolean;
  goal: string;
  chatComplete?: ChatComplete;
};

/**
 * Phase 3 (intent-first): run the intent cascade (static diagram, or a
 * planned diagram in dynamic mode) and derive the Intent that narrows the
 * proposal prompt. Returns undefined on any failure — the proposal then
 * runs un-narrowed (fail open).
 */
export async function runIntentCascade(
  client: LayaClient,
  world: World,
  actorId: string,
  opts: RunIntentCascadeOptions,
  logger?: Logger,
): Promise<Intent | undefined> {
  try {
    const state = buildIntentState(world, actorId);
    const resolution = await resolveIntentDiagramDetailed({ ...opts, state });
    // Exp-2 S6: one observability event per phase per turn, even when the
    // planner was skipped or fell back — the Phase-5 layaEvents histogram
    // counts module="laya" events and must distinguish "ran silently"
    // from "dead".
    logger?.log({
      module: "laya",
      event: "planner_diagram_resolved",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      input: { mode: opts.mode, plannerEnabled: opts.plannerEnabled },
      output: { outcome: resolution.outcome, reason: resolution.reason },
    });
    const run = await runDiagram(resolution.diagram, state, (s, q) =>
      client.decide(s, q),
    );
    const intent = intentFromDiagramRun(resolution.diagram, run);
    logger?.log({
      module: "laya",
      event: "intent_decided",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      input: { path: run.path, confidence: run.confidence },
      output: { intent },
    });
    return intent;
  } catch {
    return undefined;
  }
}

/**
 * Phase 3: batch ONE decide() with a noul per perceiving observer.
 * Throws on Laya failure — callers fail open (keep every observer patch).
 */
export async function runObserverTriage(
  client: LayaClient,
  eventText: string,
  observers: Array<{ id: string; name: string }>,
): Promise<Record<string, boolean>> {
  const answers = await client.decide(eventText, buildTriageQuestions(observers));
  return parseTriageAnswers(answers, observers.map((o) => o.id));
}

/**
 * Phase 3: one salience score (1–5) for the turn's event. Returns undefined
 * on any failure (fail open — keep model appends).
 */
export async function runSalienceScore(
  client: LayaClient,
  eventText: string,
): Promise<number | undefined> {
  const answers = await client.decide(eventText, { salience: SALIENCE_QUESTION });
  const levelCount = SALIENCE_QUESTION.type === "score" ? SALIENCE_QUESTION.levels.length : 5;
  return scoreAnswerToLevel(answers["salience"], levelCount);
}

/**
 * Phase 4: one batched 1–5 plausibility score per patch label. A missing
 * answer scores neutral (3) so it can never trigger an advisory note.
 * Returns undefined on Laya failure (fail open — no advisory).
 */
export async function runPlausibilityScores(
  client: LayaClient,
  stateText: string,
  labels: string[],
): Promise<Array<{ label: string; level: number }> | undefined> {
  if (labels.length === 0) return [];
  const answers = await client.decide(stateText, buildPlausibilityQuestions(labels));
  return labels.map((label, i) => ({
    label,
    level: scoreAnswerToLevel(answers[`plaus_${i}`], 5) ?? 3,
  }));
}

/**
 * Phase 3 post-hook: observer triage. Perceiving observers with patches get
 * one batched noul; triaged-out observers lose thought/emotion patches.
 * The directly-addressed observer always keeps theirs. Fail open.
 */
export async function triageObserverPatches(
  wiring: LayaTurnWiring,
  world: World,
  action: Action,
  result: ConsequenceResult,
  config: EngineConfig,
  logger: Logger,
): Promise<ConsequenceResult> {
  const perceivers = perceiverIds(world, action.actorId, config);
  const observers = world.actors.filter(
    (a) => a.id !== action.actorId && perceivers.has(a.id),
  );
  if (observers.length === 0) return result;
  const observerPatches = result.actorPatches.filter(
    (p) => p.actorId !== action.actorId,
  );
  if (observerPatches.length === 0) return result;
  let notable: Record<string, boolean>;
  try {
    notable = await runObserverTriage(
      wiring.client,
      slimEventText(action, result.narrative),
      observers,
    );
  } catch (err) {
    logger.log({
      module: "laya",
      event: "triage_failed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { observerIds: observers.map((o) => o.id) },
      error: errorMessage(err),
    });
    return result;
  }
  const addresseeId = result.effects?.addresseeActorId;
  const filtered = filterObserverPatches(observerPatches, notable, addresseeId);
  let droppedFields = 0;
  for (let i = 0; i < observerPatches.length; i++) {
    const before = observerPatches[i]!;
    const after = filtered[i]!;
    if (
      (before.thoughts !== undefined || before.emotion !== undefined) &&
      after.thoughts === undefined &&
      after.emotion === undefined
    ) {
      droppedFields++;
    }
  }
  logger.log({
    module: "laya",
    event: "triage_applied",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    input: { observerIds: observers.map((o) => o.id), notable },
    output: { observerPatches: observerPatches.length, droppedThoughtEmotionPatches: droppedFields },
  });
  return {
    ...result,
    actorPatches: [
      ...result.actorPatches.filter((p) => p.actorId === action.actorId),
      ...filtered,
    ],
  };
}

/**
 * Phase 3 post-hook: salience gate. One 1–5 score for the event; below the
 * threshold the model-emitted memoriesAppend/beliefsAppend are dropped.
 * The deterministic memory append in patchApplier always applies (floor).
 * Fail open.
 *
 * Exp-5 item 13 (S10): memory-precision (harness §3 — entries paraphrasing
 * real turns vs stubs/fiction) is deliberately NOT wired into this gate.
 * The gate scores event WORTHINESS (is this worth remembering?); precision
 * scores prose TRUTHFULNESS — a stub can be salient and a fiction can be
 * salient, so wiring precision in would conflate the axes and drop
 * memorable-but-poorly-worded events. The pollution source is the
 * deterministic narrative→memory append, which is fixed at the source:
 * corrupt narratives never become memories when the S3/S4 prose gates stop
 * them becoming canonical history first.
 */
export async function gateMemoryAppendsOnSalience(
  wiring: LayaTurnWiring,
  world: World,
  action: Action,
  result: ConsequenceResult,
  logger: Logger,
): Promise<ConsequenceResult> {
  const hasAppends = result.actorPatches.some(
    (p) => (p.memoriesAppend?.length ?? 0) > 0 || (p.beliefsAppend?.length ?? 0) > 0,
  );
  // Exp-2 S6: log on EVERY path, including no-ops — a silent no-op and a
  // dead phase look identical in the layaEvents histogram otherwise.
  if (!hasAppends) {
    logger.log({
      module: "laya",
      event: "salience_scored",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      output: {
        scored: false,
        reason: "no model memory/belief appends to gate",
      },
    });
    return result;
  }
  let score: number | undefined;
  try {
    score = await runSalienceScore(
      wiring.client,
      slimEventText(action, result.narrative),
    );
  } catch (err) {
    logger.log({
      module: "laya",
      event: "salience_failed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      error: errorMessage(err),
    });
    return result;
  }
  if (score === undefined) {
    logger.log({
      module: "laya",
      event: "salience_scored",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      output: {
        scored: false,
        reason: "laya returned no score; keeping model appends (fail open)",
      },
    });
    return result;
  }
  const gated = score < wiring.salienceThreshold;
  logger.log({
    module: "laya",
    event: "salience_scored",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    output: { scored: true, score, threshold: wiring.salienceThreshold, gated },
  });
  return gated ? stripModelMemoryAppends(result) : result;
}

/**
 * Phase 3 post-hooks after the consequence resolves (before the world is
 * patched): observer triage, then the salience gate. Each is independently
 * flag-gated; the orchestrator skips fallback consequences entirely.
 */
export async function applyLayaPostHooks(
  wiring: LayaTurnWiring,
  world: World,
  action: Action,
  result: ConsequenceResult,
  config: EngineConfig,
  logger: Logger,
): Promise<ConsequenceResult> {
  let out = result;
  if (wiring.config.toggles.triage) {
    out = await triageObserverPatches(wiring, world, action, out, config, logger);
  }
  if (wiring.config.toggles.salience) {
    out = await gateMemoryAppendsOnSalience(wiring, world, action, out, logger);
  }
  return out;
}

/**
 * Observability context for the plausibility phase (Exp-2 S6). The phase
 * previously took no logger at all, so it could never appear in the
 * Phase-5 layaEvents histogram — running and dead were indistinguishable.
 */
export type PlausibilityObs = {
  logger: Logger;
  tick: number;
  turnIndex: number;
  /** Retry attempt that triggered the advisory (when run from retry feedback). */
  attempt?: number;
};

/**
 * Phase 4: advisory plausibility note for retry feedback. Scores every
 * object/position patch 1–5 in one batched decide(); scores ≤2 become an
 * advisory note. Returns undefined when there is nothing to score, when
 * nothing scores low, or on any failure — advisory ONLY, never throws.
 *
 * Exp-2 S6: emits one `plausibility_scored` event per invocation (module
 * "laya") whenever `obs` is provided — including every no-op reason — so
 * the histogram can tell "ran" from "dead".
 */
export async function plausibilityAdvisoryForRetry(
  client: LayaClient,
  action: Action,
  result: ConsequenceResult,
  obs?: PlausibilityObs,
): Promise<string | undefined> {
  const emit = (
    output: Record<string, unknown>,
    input?: Record<string, unknown>,
  ): void => {
    if (obs === undefined) return;
    obs.logger.log({
      module: "laya",
      event: "plausibility_scored",
      tick: obs.tick,
      turnIndex: obs.turnIndex,
      actorId: action.actorId,
      input: {
        ...(obs.attempt !== undefined ? { attempt: obs.attempt } : {}),
        ...input,
      },
      output,
    });
  };
  try {
    const labels = describePatchesForPlausibility(result);
    if (labels.length === 0) {
      emit({
        scored: false,
        reason: "no object/position patches to score",
      });
      return undefined;
    }
    const scores = await runPlausibilityScores(
      client,
      slimEventText(action, result.narrative),
      labels,
    );
    if (scores === undefined) {
      emit(
        {
          scored: false,
          reason: "laya failure; no advisory appended (fail open)",
          patchCount: labels.length,
        },
        { patchLabels: labels },
      );
      return undefined;
    }
    const note = plausibilityAdvisoryNote(scores);
    emit(
      {
        scored: true,
        patchCount: labels.length,
        lowScoreCount: scores.filter((s) => s.level <= 2).length,
        advisoryNote: note !== undefined,
      },
      { patchLabels: labels },
    );
    return note;
  } catch {
    emit({
      scored: false,
      reason: "unexpected error; no advisory appended (fail open)",
    });
    return undefined;
  }
}

/**
 * Exp-3 item 6 (S2): the renderability score question. One batched
 * decide() with a single 1–5 score: "could a simulator faithfully turn
 * this action into concrete world changes here?" Fail-open: a missing
 * answer scores neutral (3), Laya failure returns undefined.
 */
export function buildRenderabilityQuestion(actionText: string): LayaQuestion {
  return {
    type: "score",
    instructions:
      "How renderable is this action in the current scene — could a simulator faithfully turn it into concrete world changes? " +
      "1 = impossible (target person/object doesn't exist or is far out of reach; requires teleporting; conjures props from nothing). " +
      "2 = very unlikely (target exists but too far away; pose or props mismatch). " +
      "3 = plausible but needs positioning or props the renderer must invent. " +
      "4 = renderable with minor assumptions. " +
      "5 = directly renderable: target adjacent or present, pose/props already fit. " +
      `Action: ${actionText.slice(0, 400)}`,
    levels: ["1", "2", "3", "4", "5"],
  };
}

/**
 * Exp-3 item 6 (S2): run one renderability score for the chosen action.
 * Returns the 1–5 level, 3 on a missing answer (neutral, fail-open), or
 * undefined when Laya itself fails (fail open — never block the turn on
 * a decision-layer outage). Pure shell around client.decide; never
 * throws outward.
 */
export async function runRenderabilityScore(
  client: LayaClient,
  world: World,
  actorId: string,
  actionText: string,
): Promise<number | undefined> {
  try {
    const state = buildRenderabilityState(world, actorId, actionText);
    const answers = await client.decide(state, {
      renderability: buildRenderabilityQuestion(actionText),
    });
    return scoreAnswerToLevel(answers["renderability"], 5) ?? 3;
  } catch {
    return undefined;
  }
}
