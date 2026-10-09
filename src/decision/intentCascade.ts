// Shared intent-cascade step for the Laya decision layer (Phase 5).
//
// The static SELECTION_CASCADE (intent_kind -> addressee|destination|
// target_object -> manner) is the single kind-decider used by the
// intent-first wiring, the Laya proposal engine, and the Laya selection
// engine — one implementation, no copies. The cascade is STATIC by
// design here: the dynamic question planner burns an LLM call, which is
// incompatible with the zero-LLM decision path (dynamic per-turn
// diagrams remain available to the orchestrator's intent-first step in
// LAYA_MODE=dynamic, which is explicitly opt-in).

import type { Intent, LayaAnswer } from "./decisionTypes.js";
import { SELECTION_CASCADE } from "./diagrams.js";
import { runDiagram } from "./diagramRunner.js";
import type { LayaClient } from "./layaClient.js";

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
 * Moved here from src/engine/layaTurn.ts (Phase 5 consolidation — the
 * LayaSelectionEngine carried an identical private copy).
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

/**
 * Run the static intent cascade against a Laya client and derive the
 * Intent. Throws when Laya is unavailable — callers fail open to their
 * fallback. Thin shell over the pure derivation above.
 */
export async function runStaticIntentCascade(
  client: LayaClient,
  state: string,
): Promise<Intent> {
  const run = await runDiagram(SELECTION_CASCADE, state, (s, q) =>
    client.decide(s, q),
  );
  return intentFromCascadeDecisions(run.decisions);
}
