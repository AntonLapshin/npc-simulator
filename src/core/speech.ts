// Pure speech primitives for engine-owned speech (Phase 2 of the renderer
// architecture).
//
// Quotes are verbatim by construction: the engine extracts the exact quote
// from the action text, dictates it to the render call, and repairs any
// deviation deterministically. Everything here is pure — deterministic,
// no I/O, no argument mutation, no LLM, no randomness — so the engine
// (`src/engine/speechExecutor.ts`), the validator, and the salvage tier
// all share the exact same ground truth by construction.

import { normalizeQuotes, parseActionQuotes } from "./text.js";

/**
 * The action text's exact quote: the FIRST quoted segment, or null when
 * the action carries no quoted speech.
 *
 * Multi-quote rule (Phase 2 non-goal: no multi-quote choreography): only
 * the first segment is part of the verbatim contract. Later segments stay
 * subject to the ordinary speech gates (speech.dropped_words etc.) but the
 * engine dictates — and the backstop guarantees — exactly this one.
 */
export function extractExactQuote(actionText: string): string | null {
  const quotes = parseActionQuotes(actionText);
  return quotes.length > 0 ? quotes[0]! : null;
}

/**
 * Quote-style/canonical comparison form: curly quotes canonicalized,
 * whitespace collapsed, case preserved (case is part of the verbatim
 * contract — only quoteContained is byte-exact).
 */
export function normQuote(s: string): string {
  return normalizeQuotes(s).replace(/\s+/g, " ").trim();
}

/**
 * Exact containment: the narrative carries the quote
 * character-for-character. Quote style is canonicalized (curly "..." ==
 * straight "..." — a model may emit either); everything else must match
 * byte-for-byte, including case and punctuation.
 */
export function quoteContained(quote: string, narrative: string): boolean {
  if (quote.length === 0) return false;
  return normalizeQuotes(narrative).includes(normalizeQuotes(quote));
}

/**
 * "Covered" relation for frame-cleanliness: `other` is grounded in the
 * exact quote when the two are equal (quote-canonicalized, case- and
 * whitespace-insensitive) or either contains the other — the same
 * leniency the old salvage repair used to tell an invented frame from a
 * clean one. Case-insensitive on purpose: a capitalized sentence-start
 * ("Is this my spot?") is a clean render of the action's quote, not
 * invented dialogue.
 */
export function quoteCovers(exactQuote: string, other: string): boolean {
  const a = normQuote(exactQuote).toLowerCase();
  const b = normQuote(other).toLowerCase();
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Deterministic quote reinsertion (the exp-3 item 3 repair, made pure).
 * Guarantees the returned narrative contains `quote` verbatim:
 * - already present (quoteContained) → returned unchanged;
 * - otherwise, when the narrative's own quoted segments are all grounded
 *   in the exact quote (a clean frame — e.g. a paraphrase render), the
 *   quote is appended as `<Name> says "<quote>"` and the model's prose is
 *   kept;
 * - when the frame itself invents dialogue (a quoted segment not covered
 *   by the exact quote), the narrative is replaced outright with
 *   `<Name> says "<quote>"` — invented words never survive.
 * Never mutates its inputs.
 */
export function reinsertQuote(
  narrative: string,
  actorName: string,
  quote: string,
): string {
  if (quoteContained(quote, narrative)) return narrative;
  const frame = narrative.trim();
  const frameQuotes = parseActionQuotes(narrative);
  const sentence = `${actorName} says "${quote}"`;
  const cleanFrame =
    frame.length > 0 && frameQuotes.every((q) => quoteCovers(quote, q));
  return cleanFrame ? `${frame} ${sentence}` : sentence;
}
