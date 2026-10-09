// PLAN_V2 Phase 1: the intent-call result — one structured LLM answer to
// "what does this actor do next?".
//
// Pure: no I/O, no Date, no randomness. Every function is unit-tested.
// The engine wiring (prompt building, provider calls, retry) lives in
// src/llm/llmIntentEngine.ts.

/** The intent call's contract: one third-person action sentence + the exact quote (or ""). */
export type IntentResult = {
  action: string;
  quote: string;
};

/**
 * Deterministic fallback when the intent call fails its retry (§16.5
 * style): the actor does nothing conspicuous. The engine executes it
 * like any other action — no correction loops, no dead turns.
 */
export const FALLBACK_INTENT: IntentResult = {
  action: "waits and observes the situation.",
  quote: "",
};

/** Max chars for the one-sentence action (a sentence, not a paragraph). */
export const MAX_INTENT_ACTION_CHARS = 600;

/** Max chars for the quoted speech (a spoken line, not a monologue). */
export const MAX_INTENT_QUOTE_CHARS = 600;

export type IntentValidation =
  | { ok: true; value: IntentResult }
  | { ok: false; error: string };

/**
 * Pure validation of a parsed intent payload (the extraCheck for the
 * structured call, and the unit-test surface for the contract). Accepts
 * good payloads; rejects missing/empty/non-string fields and over-long
 * strings with a named reason the repair prompt can echo.
 */
export function validateIntentValue(value: unknown): IntentValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "intent must be a JSON object" };
  }
  const record = value as Record<string, unknown>;
  const { action, quote } = record;
  if (typeof action !== "string" || action.trim().length === 0) {
    return { ok: false, error: "intent.action must be a non-empty string (one third-person sentence)" };
  }
  if (action.length > MAX_INTENT_ACTION_CHARS) {
    return {
      ok: false,
      error: `intent.action is ${action.length} chars — keep it to one sentence (max ${MAX_INTENT_ACTION_CHARS} chars)`,
    };
  }
  if (typeof quote !== "string") {
    return { ok: false, error: 'intent.quote must be a string ("" when the actor says nothing)' };
  }
  if (quote.length > MAX_INTENT_QUOTE_CHARS) {
    return {
      ok: false,
      error: `intent.quote is ${quote.length} chars — quote the exact spoken words (max ${MAX_INTENT_QUOTE_CHARS} chars)`,
    };
  }
  return { ok: true, value: { action: action.trim(), quote } };
}
