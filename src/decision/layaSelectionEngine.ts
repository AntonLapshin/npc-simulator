// Laya-backed SelectionEngine: runs the static intent cascade, then a
// final choice over the concrete suggestions plus "none fit". Low
// confidence or a "none fit" winner delegates to the injected chat fallback.

import type { SelectionEngine } from "../intelligence/types.js";
import type { SelectionResult, World } from "../types.js";
import type { Intent, LayaAnswer } from "./decisionTypes.js";
import { buildIntentState } from "./decisionState.js";
import { SELECTION_CASCADE } from "./diagrams.js";
import { runDiagram } from "./diagramRunner.js";
import { LayaClient } from "./layaClient.js";
import { answerConfidence, argmaxOption } from "./utils/runnerUtils.js";

/** Winner id meaning "no suggestion fits — let the chat model invent one". */
export const NONE_FIT_OPTION = "none fit";

export type LayaSelectionEngineDeps = {
  client: LayaClient;
  /** Confidence floor for the Laya pick; below it we delegate. */
  confidenceThreshold?: number;
  /** Slim-state builder (overridable for tests). */
  buildState?: (world: World, actorId: string) => string;
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.55;

function intentFromCascade(decisions: Record<string, LayaAnswer>): Intent {
  const kindRaw = decisions["intent_kind"];
  const kind =
    kindRaw?.type === "choice" &&
    ["speak", "move", "interact", "gesture", "wait"].includes(kindRaw.winner)
      ? (kindRaw.winner as Intent["kind"])
      : "wait";
  const intent: Intent = { kind };
  const addressee = decisions["addressee"];
  const destination = decisions["destination"];
  const targetObject = decisions["target_object"];
  if (kind === "speak" && addressee?.type === "choice") {
    intent.targetKind = addressee.winner === "nobody in particular" ? "none" : "actor";
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
  if (manner?.type === "choice" && !intent.manner) intent.manner = manner.winner;
  return intent;
}

export class LayaSelectionEngine implements SelectionEngine {
  private readonly client: LayaClient;
  private readonly fallback: SelectionEngine;
  private readonly confidenceThreshold: number;
  private readonly buildState: (world: World, actorId: string) => string;

  constructor(deps: LayaSelectionEngineDeps, fallback: SelectionEngine) {
    this.client = deps.client;
    this.fallback = fallback;
    this.confidenceThreshold = deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.buildState = deps.buildState ?? buildIntentState;
  }

  async select(
    world: World,
    actorId: string,
    suggestions: string[],
  ): Promise<SelectionResult> {
    const state = this.buildState(world, actorId);

    // Step 1: intent cascade (batched DAG walk).
    let intent: Intent = { kind: "wait" };
    try {
      const run = await runDiagram(
        SELECTION_CASCADE,
        state,
        (s, q) => this.client.decide(s, q),
      );
      intent = intentFromCascade(run.decisions);
    } catch {
      return this.fallback.select(world, actorId, suggestions);
    }

    // Step 2: final choice over suggestions + "none fit" (one Laya call).
    const options = [...suggestions, NONE_FIT_OPTION];
    let winner: string;
    let confidence: number;
    try {
      const answers = await this.client.decide(state, {
        candidate_fit: {
          type: "choice",
          instructions: `Which candidate action best fits ${intent.kind}${intent.manner ? ` (${intent.manner})` : ""}? Pick "none fit" only if every candidate is wrong for the actor right now.`,
          options,
        },
      });
      const answer = answers["candidate_fit"];
      if (!answer || answer.type !== "choice") throw new Error("missing candidate_fit answer");
      winner = argmaxOption(answer.probabilities, options);
      confidence = answerConfidence(answer, options.length);
    } catch {
      return this.fallback.select(world, actorId, suggestions);
    }

    if (winner === NONE_FIT_OPTION || confidence < this.confidenceThreshold) {
      const fb = await this.fallback.select(world, actorId, suggestions);
      return {
        action: fb.action,
        reasoning: `laya: intent=${intent.kind} but candidate "${winner}" @${confidence.toFixed(2)} < threshold; chat fallback: ${fb.reasoning}`,
      };
    }
    return {
      action: winner,
      reasoning: `laya: intent=${intent.kind}${intent.targetKind ? ` target=${intent.targetKind}` : ""}${intent.manner ? ` manner=${intent.manner}` : ""} confidence=${confidence.toFixed(2)}`,
    };
  }
}
