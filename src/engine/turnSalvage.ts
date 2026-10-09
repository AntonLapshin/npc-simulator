// Turn-level consequence bookkeeping (Phase 4).
//
// The patch-validation retry loop and every salvage tier are deleted —
// the render contract is prose-only, so there is nothing left to salvage.
// What remains here is small and load-bearing:
// - `isFallbackConsequence`: did this turn fall back to "Nothing changes."?
// - the honest-history note bookkeeping: the liveness floor replaces the
//   render with a deterministic reaction, so the world history records the
//   narrative plus a plain-language note, never the raw action text.

import type { ConsequenceResult } from "../types.js";
import { FALLBACK_CONSEQUENCE } from "../llm/llmConsequenceEngine.js";

/**
 * Exp-4 item 6 / F23: did this turn fall back? The explicit `fallback`
 * flag is checked first; the structural check (canonical fallback
 * narrative) remains as backward compat for results built before the
 * flag existed — so the history entry can be marked as un-applied
 * ("tried … (not done)") instead of asserted as fact.
 */
export function isFallbackConsequence(result: ConsequenceResult): boolean {
  if (result.fallback === true) return true;
  if (result.fallback === false) return false;
  return result.narrative === FALLBACK_CONSEQUENCE.narrative;
}

/**
 * Exp-5 item 2: honest-history notes for liveness turns. The liveness
 * floor replaces the failed render with a deterministic reaction, so the
 * world history must record the NARRATIVE (what happened) plus this note —
 * never the raw action text (the wish). Stored off-object (WeakMap) so the
 * validated payload shape is untouched; runTurn reads it via
 * getHonestHistoryNote() and forwards it to the applier.
 */
const honestHistoryNotes = new WeakMap<ConsequenceResult, string>();

export function getHonestHistoryNote(result: ConsequenceResult): string | undefined {
  return honestHistoryNotes.get(result);
}

/** Attach an honest-history note to a consequence result (used by the liveness floor). */
export function setHonestHistoryNote(result: ConsequenceResult, note: string): void {
  honestHistoryNotes.set(result, note);
}
