// Laya turn wiring (LAYA_PLAN.md phases 3–5): intent-first cascade and
// the renderability screen.
//
// Layout follows the repo rule: logic lives in small pure functions below
// (testable without I/O); the async shells at the bottom are thin and fail
// OPEN — a Laya outage must never break a turn, it just degrades to the
// chat path. Everything here is behind env flags that default OFF
// (see readLayaRuntimeConfig in src/config.ts).
//
// Phase 4: the patch-contract post-hooks are deleted (observer triage,
// salience gating, plausibility advisory) — the render contract is prose-
// only, so there are no patches left to triage, gate, or score.

import type {
  Action,
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
import type { Logger } from "../logging/logger.js";
import { errorMessage } from "../util/errors.js";

export type { ChatComplete };

/**
 * Phase 5: the cascade-decision derivation lives in
 * src/decision/intentCascade.ts (single implementation shared with the
 * Laya proposal/selection engines). Imported here for local use and
 * re-exported for existing importers.
 */
import { intentFromCascadeDecisions } from "../decision/intentCascade.js";
export { intentFromCascadeDecisions };

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
// intentFromCascadeDecisions lives in ../decision/intentCascade.ts (Phase 5
// consolidation); the pure keyword classifier below stays here.

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
