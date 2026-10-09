// Deterministic (zero-LLM, zero-Laya) decision fallbacks (Phase 5).
//
// Used as the proposal/selection fallback when LLM_DECISION_FALLBACK=0:
// the Laya cascade stays the primary path, and any cascade failure lands
// here instead of burning an LLM call. Deliberately dumb — these are the
// last resort before the turn-level fallback, not a decision strategy.

import type {
  ProposalEngine,
  SelectionEngine,
} from "../intelligence/types.js";
import type { ProposalResult, SelectionResult, World } from "../types.js";

/** Last-resort suggestions when neither Laya nor LLM may decide. */
export const DETERMINISTIC_SUGGESTIONS = [
  "Stay where you are.",
  "Look around.",
  "Do nothing.",
];

/** Deterministic ProposalEngine: fixed suggestion set, no decisions. */
export class DeterministicProposalEngine implements ProposalEngine {
  async propose(world: World, actorId: string): Promise<ProposalResult> {
    void world;
    void actorId;
    return {
      suggestions: [...DETERMINISTIC_SUGGESTIONS],
      reasoning:
        "deterministic fallback: Laya cascade unavailable and LLM_DECISION_FALLBACK=0",
    };
  }
}

/** Deterministic SelectionEngine: first suggestion wins, no decisions. */
export class DeterministicSelectionEngine implements SelectionEngine {
  async select(
    world: World,
    actorId: string,
    suggestions: string[],
  ): Promise<SelectionResult> {
    void world;
    void actorId;
    const action =
      suggestions.length > 0 ? suggestions[0]! : DETERMINISTIC_SUGGESTIONS[0]!;
    return {
      action,
      reasoning:
        "deterministic fallback: first suggestion (Laya unavailable, LLM_DECISION_FALLBACK=0)",
    };
  }
}
