import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  ProposalResult,
  SelectionResult,
  World,
} from "../types.js";

export interface ProposalEngine {
  propose(world: World, actorId: string): Promise<ProposalResult>;
}

export interface SelectionEngine {
  select(world: World, actorId: string, suggestions: string[]): Promise<SelectionResult>;
}

export interface ConsequenceEngine {
  /**
   * F28: `opts.signal` carries the turn-deadline AbortSignal. Engines
   * forward it to the provider call so a hung LLM request is actually
   * cancelled on timeout instead of burning tokens in the background.
   * Optional — engines that ignore it still satisfy the interface.
   */
  resolve(
    world: World,
    action: Action,
    feedback?: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ConsequenceResult>;
}

/**
 * Decision-AI judge for free-form action meaning (refactor plan §A).
 * Answers "what did this English sentence *mean*?" — movement intent,
 * addressee resolution, speech intent — so the validator only enforces
 * physics (geometry, schema, turn structure) against the answer.
 */
export interface SemanticJudge {
  classify(world: World, action: Action): Promise<ActionSemantics>;
}
