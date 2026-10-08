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
import { buildIntentState } from "../decision/decisionState.js";
import { LayaClient } from "../decision/layaClient.js";
import { createLayaClient } from "../decision/wiring.js";
import {
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
 * Phase 4: in dynamic mode with the planner on, generate the selection
 * diagram per turn (cached by questionPlanner); on ANY planner failure
 * fall back to the static SELECTION_CASCADE. Static mode always uses the
 * static diagram.
 */
export async function resolveIntentDiagram(
  opts: ResolveIntentDiagramOptions,
): Promise<DecisionDiagram> {
  if (
    opts.mode === "dynamic" &&
    opts.plannerEnabled &&
    opts.chatComplete !== undefined
  ) {
    try {
      return await planDiagram(opts.goal, opts.state, opts.chatComplete);
    } catch {
      return SELECTION_CASCADE;
    }
  }
  return SELECTION_CASCADE;
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
    const diagram = await resolveIntentDiagram({ ...opts, state });
    const run = await runDiagram(diagram, state, (s, q) => client.decide(s, q));
    const intent = intentFromDiagramRun(diagram, run);
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
  if (!hasAppends) return result;
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
  if (score === undefined) return result;
  const gated = score < wiring.salienceThreshold;
  logger.log({
    module: "laya",
    event: "salience_scored",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    output: { score, threshold: wiring.salienceThreshold, gated },
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
 * Phase 4: advisory plausibility note for retry feedback. Scores every
 * object/position patch 1–5 in one batched decide(); scores ≤2 become an
 * advisory note. Returns undefined when there is nothing to score, when
 * nothing scores low, or on any failure — advisory ONLY, never throws.
 */
export async function plausibilityAdvisoryForRetry(
  client: LayaClient,
  action: Action,
  result: ConsequenceResult,
): Promise<string | undefined> {
  try {
    const labels = describePatchesForPlausibility(result);
    if (labels.length === 0) return undefined;
    const scores = await runPlausibilityScores(
      client,
      slimEventText(action, result.narrative),
      labels,
    );
    if (scores === undefined) return undefined;
    return plausibilityAdvisoryNote(scores);
  } catch {
    return undefined;
  }
}
