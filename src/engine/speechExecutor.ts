// Engine-owned speech (Phase 2 of the renderer architecture).
//
// The model cannot invent dialogue because the engine dictates the exact
// words: the quote is extracted from the action text at turn start, handed
// to the render call as ground-truth facts, and — belt-and-braces — any
// narrative that fails to carry it verbatim is repaired deterministically
// before validation (no LLM retry burned). This module is the
// business-logic wrapper — sequencing, world reads — over the pure core
// in `src/core/speech.ts`, mirroring `movementExecutor.ts`.

import type { Action, World } from "../types.js";
import type { ActionSemantics } from "../types.js";
import type { Intent } from "../decision/decisionTypes.js";
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
 *
 * Phase 5: a cascade intent carrying an explicit quote is authoritative
 * (it generated the action text) — the quote flows straight to
 * exactQuote with no text re-parsing.
 */
export function planSpeech(
  action: Action,
  intent?: Intent,
  /**
   * PLAN_V2 Phase 2 (Laya as parser): pre-parsed ActionSemantics from the
   * parse step. The judge extracts quotes deterministically from the same
   * sentence (parseActionQuotes) — when provided, reuse its extraction
   * instead of re-parsing the text. When absent the text parse runs
   * exactly as before (v1, and the fail-open fallback).
   */
  semantics?: Pick<ActionSemantics, "quotedSpeech">,
): string | null {
  if (intent?.quote !== undefined) return intent.quote;
  if (semantics !== undefined) return semantics.quotedSpeech[0] ?? null;
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


