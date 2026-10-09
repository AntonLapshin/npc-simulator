// Engine-owned speech (Phase 2 of the renderer architecture).
//
// The model cannot invent dialogue because the engine dictates the exact
// words: the quote is extracted from the action text at turn start, handed
// to the render call as ground-truth facts, and — belt-and-braces — any
// narrative that fails to carry it verbatim is repaired deterministically
// before validation (no LLM retry burned). This module is the
// business-logic wrapper — sequencing, world reads — over the pure core
// in `src/core/speech.ts`, mirroring `movementExecutor.ts`.

import type { Action, ConsequenceResult, World } from "../types.js";
import {
  extractExactQuote,
  quoteContained,
  reinsertQuote,
} from "../core/speech.js";

export { extractExactQuote, quoteContained, reinsertQuote };

/**
 * Deterministic speech pre-pass: the exact quote from the ACTION text
 * alone (no model output, no judge). Computed once per turn, before the
 * first consequence call, so the render input carries the exact words as
 * facts. Null when the action carries no quoted speech — unquoted speech
 * (greetings, small talk the action didn't specify) is policed by the
 * echo validator + ECHO-BAN, not by this contract.
 */
export function planSpeech(action: Action): string | null {
  return extractExactQuote(action.text);
}

/**
 * Fact lines describing the engine-dictated quote for the consequence
 * (render) input — the verbatim contract: "the narrative MUST contain this
 * exact quote, character-for-character."
 */
export function exactQuoteFacts(
  world: World,
  actorId: string,
  exactQuote: string | null,
): string[] {
  const actor = world.actors.find((a) => a.id === actorId);
  const name = actor?.name ?? actorId;
  if (exactQuote === null) {
    return [
      "EXACT QUOTE: none — this turn's action text carries no quoted speech. " +
        "Compose any dialogue fresh and short, grounded in this turn's action text (ECHO-BAN applies).",
    ];
  }
  return [
    "EXACT QUOTE (engine-owned speech — these exact words are dictated by the engine):",
    `${name} says "${exactQuote}"`,
    "RENDER CONTRACT: the narrative MUST contain this exact quote character-for-character. " +
      "Copy it verbatim — never paraphrase, alter, truncate, or substitute different dialogue, " +
      "and never invent other quoted dialogue.",
  ];
}

export type EngineSpeechResult = {
  result: ConsequenceResult;
  reinserted: boolean;
};

/**
 * Deterministic quote backstop: guarantees the exact quote in the
 * narrative before validation. A narrative missing the quote is repaired
 * via the pure core transform (appended to a clean frame, replacing an
 * invented one); a narrative that already carries it passes through
 * untouched. Returns a clone — the input is never mutated. The
 * `onReinserted` hook lets the caller audit-log each repair (B1 shape:
 * an altered quote is replaced by the action's exact words).
 */
export function applyEngineSpeech(
  result: ConsequenceResult,
  actorId: string,
  exactQuote: string | null,
  world: World,
  onReinserted?: (info: { before: string; after: string }) => void,
): EngineSpeechResult {
  if (exactQuote === null) return { result, reinserted: false };
  if (quoteContained(exactQuote, result.narrative)) {
    return { result, reinserted: false };
  }
  const actor = world.actors.find((a) => a.id === actorId);
  const name = actor?.name ?? actorId;
  const repaired: ConsequenceResult = structuredClone(result);
  repaired.narrative = reinsertQuote(result.narrative, name, exactQuote);
  // Keep the machine-readable declaration consistent with the rendered
  // speech (mirrors the old salvage repair).
  if (repaired.effects) {
    repaired.effects.spoke = true;
    repaired.effects.quotedSpeech = [exactQuote];
  }
  onReinserted?.({ before: result.narrative, after: repaired.narrative });
  return { result: repaired, reinserted: true };
}
