// Laya-backed SelectionEngine: runs the static intent cascade, then a
// final choice over the concrete suggestions plus "none fit". Low
// confidence or a "none fit" winner delegates to the injected chat fallback.

import type {
  DelegatingEngine,
  EngineDelegation,
  SelectionEngine,
} from "../intelligence/types.js";
import type { SelectionResult, World } from "../types.js";
import type { Intent } from "./decisionTypes.js";
import { buildIntentState } from "./decisionState.js";
import { runStaticIntentCascade } from "./intentCascade.js";
import { LayaClient } from "./layaClient.js";
import { answerConfidence, argmaxOption } from "./utils/runnerUtils.js";
import { errorMessage } from "../util/errors.js";

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

// Phase 5: the cascade-decision derivation is shared
// (src/decision/intentCascade.ts) — the private copy is deleted.

export class LayaSelectionEngine implements SelectionEngine, DelegatingEngine {
  private readonly client: LayaClient;
  private readonly fallback: SelectionEngine;
  private readonly confidenceThreshold: number;
  private readonly buildState: (world: World, actorId: string) => string;
  private lastDelegationState: EngineDelegation | undefined;

  /**
   * Stage 3 C2/C3: the fallback delegation performed by the last
   * select() call, if any — cause plus whether the fallback burns
   * provider (LLM) calls. Lets the orchestrator count delegated calls in
   * the turn budget and log the cause.
   */
  get lastDelegation(): EngineDelegation | undefined {
    return this.lastDelegationState;
  }

  constructor(deps: LayaSelectionEngineDeps, fallback: SelectionEngine) {
    this.client = deps.client;
    this.fallback = fallback;
    this.confidenceThreshold = deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.buildState = deps.buildState ?? buildIntentState;
  }

  /**
   * Phase 5: when the caller already decided the turn's intent (the
   * orchestrator's intent-first cascade, or the Laya proposal engine's
   * fully-typed intent), pass it here to skip the redundant intent
   * cascade — the candidate_fit choice is flavored by the decided intent
   * instead. Omitted/undefined keeps the existing cascade behavior.
   */
  async select(
    world: World,
    actorId: string,
    suggestions: string[],
    intent?: Intent,
  ): Promise<SelectionResult> {
    const state = this.buildState(world, actorId);
    this.lastDelegationState = undefined;
    // Stage 3 C2/C3: every delegation path records its cause so the
    // orchestrator can count the fallback's provider call and log it.
    const fail = (reason: string): Promise<SelectionResult> => {
      this.lastDelegationState = {
        cause: reason,
        providerBacked: this.fallback.providerBacked === true,
      };
      return this.fallback.select(world, actorId, suggestions);
    };

    // Step 1: intent cascade (batched DAG walk) — skipped when the intent
    // is already decided upstream.
    let decided: Intent = { kind: "wait" };
    try {
      decided = intent ?? (await runStaticIntentCascade(this.client, state));
    } catch (err) {
      return fail(`intent cascade failed (${errorMessage(err)})`);
    }

    // Step 2: final choice over suggestions + "none fit" (one Laya call).
    const options = [...suggestions, NONE_FIT_OPTION];
    let winner: string;
    let confidence: number;
    try {
      const answers = await this.client.decide(state, {
        candidate_fit: {
          type: "choice",
          instructions: `Which candidate action best fits ${decided.kind}${decided.manner ? ` (${decided.manner})` : ""}? Pick "none fit" only if every candidate is wrong for the actor right now.`,
          options,
        },
      });
      const answer = answers["candidate_fit"];
      if (!answer || answer.type !== "choice") throw new Error("missing candidate_fit answer");
      winner = argmaxOption(answer.probabilities, options);
      confidence = answerConfidence(answer, options.length);
    } catch (err) {
      return fail(`candidate_fit choice failed (${errorMessage(err)})`);
    }

    if (winner === NONE_FIT_OPTION || confidence < this.confidenceThreshold) {
      const reason =
        winner === NONE_FIT_OPTION
          ? `candidate_fit picked "${NONE_FIT_OPTION}"`
          : `candidate "${winner}" @${confidence.toFixed(2)} < threshold ${this.confidenceThreshold}`;
      const fb = await fail(
        `intent=${decided.kind} but ${reason}`,
      );
      return {
        action: fb.action,
        reasoning: `laya: intent=${decided.kind} but ${reason}; chat fallback: ${fb.reasoning}`,
      };
    }
    return {
      action: winner,
      reasoning: `laya: intent=${decided.kind}${decided.targetKind ? ` target=${decided.targetKind}` : ""}${decided.manner ? ` manner=${decided.manner}` : ""} confidence=${confidence.toFixed(2)}`,
    };
  }
}
