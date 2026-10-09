// Speech and narrative-prose validation checks (extracted from physicalValidator.ts).

import type { Action, ActionSemantics, ValidationError } from "../../types.js";
import { maskResumedActivity, normalizeQuotes } from "../deterministicSemantics.js";
// Phase 2 (renderer architecture): quote parsing lives in the pure core
// (src/core/text.ts). The local implementation was byte-identical to
// parseActionQuotes (same normalize → double-quote {2,} scan →
// apostrophe-aware single-quote scan), so the core parser is used under
// the old name — existing import paths keep working.
import { parseActionQuotes as quotedSegments } from "../../core/text.js";
import { extractExactQuote, quoteContained } from "../../core/speech.js";

export { extractExactQuote, quoteContained, quotedSegments };

/**
 * F35: the canonical "resumed activity" mask lives in
 * deterministicSemantics.ts (shared with maskNonLocomotion) — re-exported
 * here so existing import paths keep working.
 */
export { maskResumedActivity };

/**
 * Placeholder/schema-leak gate (exp-2 item 1, tick 4 repro): a narrative of
 * `"string"`, `"(none)"`, or an echo of the action text means the model
 * emitted schema filler instead of a consequence. Cheap string check that
 * runs on every turn, with or without judged semantics.
 */
const PLACEHOLDER_NARRATIVES = new Set([
  "string", "(none)", "none", "n/a", "na", "no change", "(no change)",
  "no-change", "nothing", "nothing changes", "...", "-", "null", "undefined",
  "(...)", "tbd",
]);

export function stripForCompare(s: string): string {
  return s
    .trim()
    .replace(/^["'(\[]+/, "")
    .replace(/["')\].,;:!?]+$/, "")
    .trim()
    .toLowerCase();
}

export function validateNarrativePlaceholder(
  narrative: string,
  action?: Action,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const stripped = stripForCompare(narrative);
  if (PLACEHOLDER_NARRATIVES.has(stripped)) {
    errors.push({
      code: "narrative.placeholder",
      message: `narrative is a placeholder ("${narrative.slice(0, 80)}"): describe ONLY what the acting actor observably does, grounded in the action text — never emit schema filler`,
    });
    return errors;
  }
  if (action && stripped.length > 0 && stripped === stripForCompare(action.text)) {
    // Exp-2 item 6 (S3): a verbatim quote of a fully-spoken action is
    // correct rendering, not an echo — exempt it so the turn isn't pushed
    // into a paraphrase that speech.dropped_words then rejects (the two
    // gates were jointly unsatisfiable on speech turns, ticks 7/19).
    if (!quotedSpeechEchoedVerbatim(action.text, narrative)) {
      errors.push({
        code: "narrative.echoes_action",
        message: `narrative echoes the action text verbatim instead of describing the outcome: narrate what observably happens as a result of the action`,
      });
    }
  }
  return errors;
}

/**
 * Exp-2 item 6 (S3): fully-spoken actions are exempt from the echo gate.
 * When the action text IS (or carries) the utterance, the narrative
 * quoting it verbatim is correct rendering, not an echo — rejecting it
 * forces a paraphrase that then fails speech.dropped_words. Detect
 * robustly: an action quoted segment that also appears verbatim
 * (quote-canonicalized, case- and whitespace-insensitive) among the
 * narrative's quoted segments. Non-speech turns (no quoted segments in
 * the action text) keep the gate.
 */
export function quotedSpeechEchoedVerbatim(actionText: string, narrative: string): boolean {
  const actionQuotes = quotedSegments(actionText);
  if (actionQuotes.length === 0) return false;
  const narrNorm = new Set(quotedSegments(narrative).map(normLower));
  return actionQuotes.some((q) => narrNorm.has(normLower(q)));
}

/** Double- and single-quoted segments (content length >= 2) — the pure
 * core parser, kept under this name so the validator modules that import
 * it don't change. */

export function normLower(s: string): string {
  // Exp-6 item 2: quote-canonicalized so word comparisons never trip on
  // curly-vs-straight apostrophes (don't vs don't).
  return normalizeQuotes(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Content words (len >= 4) lowercased for overlap checks. */
export function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
}

/** True when two words share a stem (first 4 letters equal). */
export function sameStem(a: string, b: string): boolean {
  return a.slice(0, 4) === b.slice(0, 4);
}

/**
 * Exp-3 item 2 (lenient half): an interrogative quote ("could you show me
 * where my desk is?") survives as a paraphrase when the narrative keeps the
 * question structure — a "?" or an ask-verb (asks for directions) — plus at
 * least one shared content word (the topic, e.g. "desk"). This passes the
 * tick-3 paraphrase ("Anton asks Tanya for directions to his desk") while
 * still failing truncations ("Hi, I'm Anton" keeps no ?/ask verb) and
 * flipped speech ("thanks Anton, looking pleased" has no ask verb).
 */
export function questionPreserved(actionQuote: string, narrative: string): boolean {
  if (!actionQuote.includes("?")) return false;
  const hasQuestionForm = narrative.includes("?") || /\bask\w*|questions?\b/i.test(narrative);
  if (!hasQuestionForm) return false;
  const words = contentWords(actionQuote);
  return words.some((w) => contentWords(narrative).some((nw) => sameStem(w, nw)));
}

/**
 * Item C9 (S5): unquoted verbs that read as the acting actor speaking.
 * This is the speech.no_speech_rendered gate's verb list, defined here
 * so the gate and the utterance detector share one definition and cannot
 * drift. Greet/welcome stay out (they can be rendered non-verbally);
 * ask/? stays with the question gate.
 */
const EXPLANATORY_UTTERANCE_VERBS =
  "explain|explains|explained|explaining|describ(?:e|es|ed|ing)|discuss(?:es|ed|ing)?|brief(?:s|ed|ing)?|present(?:s|ed|ing)?|outlin(?:e|es|ed|ing)";

export const OWN_UTTERANCE_VERBS =
  `say|says|said|tell|tells|told|thank|thanks|thanked|answer|answers|answered|repl(?:y|ies|ied)|` +
  `mention|mentions|mentioned|${EXPLANATORY_UTTERANCE_VERBS}|` +
  `announce|announces|announced|shout|shouts|shouted|whisper|whispers|whispered|talk|talks|talked|` +
  `speak|speaks|spoke|spoken|call|calls|called|call\\s+out`;

/** Reported-speech verb shapes ("what Jeff says next", "as Ana explains"). */
const REPORTED_SPEECH_VERBS =
  "say|says|said|tell|tells|told|ask|asks|asked|answer|answers|answered|explain|explains|explained|" +
  "mention|mentions|mentioned|announce|announces|announced|shout|shouts|shouted|whisper|whispers|whispered|" +
  "talk|talks|talked|speak|speaks|spoke|spoken";

/**
 * Item C9 (S5): mask reported-speech subordinate clauses — someone ELSE's
 * speech the actor perceives — so they never read as the acting actor's
 * own utterance:
 * - "what <name> says/said/tells/..." ("keep an ear open for what Jeff
 *   says next" — the S5 repro);
 * - "while/when/as <name> <speech verb>" ("as Ana explains the layout"
 *   — the actor listens; first-person "as I/we explain" is NOT masked,
 *   the actor is the speaker there).
 * Masked to clause end (commas/semicolons/sentence ends not crossed).
 * Pure.
 */
export function maskReportedSpeech(text: string): string {
  let out = text.replace(
    new RegExp(`\\bwhat\\s+(?:[a-z'-]+\\s+)?(?:${REPORTED_SPEECH_VERBS})\\b[^,.;!?]*`, "gi"),
    " ",
  );
  out = out.replace(
    new RegExp(
      `\\b(?:while|when|as)\\s+(?!(?:i|we)\\b)[A-Za-z][a-z'-]*\\s+(?:${REPORTED_SPEECH_VERBS})\\b[^,.;!?]*`,
      "gi",
    ),
    " ",
  );
  return out;
}

/**
 * Item C9 (S5): the acting actor's OWN utterance detector (pure). True
 * when the action text carries the actor's own words — quoted segments,
 * or an unquoted speech verb outside reported-speech mentions. The
 * speech.no_speech_rendered gate fires only on this (an utterance that
 * was then dropped from the narrative), never on "what Jeff says next"
 * style mentions of someone else's speech.
 */
export function hasOwnUtterance(text: string): boolean {
  if (quotedSegments(text).length > 0) return true;
  return new RegExp(`\\b(?:${OWN_UTTERANCE_VERBS})\\b`, "i").test(maskReportedSpeech(text));
}

/**
 * Phase 2 (renderer architecture): the exact-quote gate. The engine owns
 * speech now — the action text's first quoted segment is ground truth
 * (extractExactQuote, the same extraction the turn pre-pass uses) and the
 * narrative must contain it character-for-character (quote-style
 * canonicalized). Paraphrase is no longer acceptable on quoted turns: the
 * in-loop deterministic backstop (the turn orchestrator's quote repair via
 * the pure core `reinsertQuote`) repairs the narrative before this gate
 * runs, so a failure here means a path that bypassed the backstop
 * produced non-verbatim prose — a B1-shaped invented/paraphrased dialogue
 * that must never become canonical history.
 */
export function validateExactQuote(
  exactQuote: string | null,
  narrative: string,
): ValidationError[] {
  if (exactQuote === null) return [];
  if (quoteContained(exactQuote, narrative)) return [];
  return [
    {
      code: "speech.exact_quote_missing",
      message:
        `narrative MUST contain the action's exact quote character-for-character ("${exactQuote.slice(0, 80)}"): ` +
        `copy the engine-dictated words verbatim — never paraphrase, alter, truncate, or substitute different dialogue`,
    },
  ];
}

/**
 * Phase 4: prose coverage gates restored from the old
 * validateActionVerbCoverage (its patch-checking halves died with the
 * patch channel; these prose halves are pure and stay).
 *
 * - speech.question_dropped: the action asks a question, the narrative
 *   keeps no question mark and no ask-verb.
 * - speech.no_speech_rendered: the action carries the actor's OWN
 *   utterance (quoted or an unquoted speech verb — never someone else's
 *   reported speech), but the narrative renders no speech at all: no
 *   quote and no speech verb of its own.
 */
const EXPLANATORY_VERBS =
  "explain|explains|explained|explaining|describ(?:e|es|ed|ing)|discuss(?:es|ed|ing)?|brief(?:s|ed|ing)?|present(?:s|ed|ing)?|outlin(?:e|es|ed|ing)";

const NARRATIVE_SPEECH_VERBS =
  `say|says|said|tell|tells|told|thank|thanks|thanked|greet|greets|greeted|greeting|` +
  `welcome|welcomes|welcomed|ask|asks|asked|answer|answers|answered|repl(?:y|ies|ied)|` +
  `mentions?|mentioned|${EXPLANATORY_VERBS}|announce|announces|announced|shout|shouts|` +
  `shouted|whisper|whispers|whispered|talk|talks|talked|speak|speaks|spoke|spoken|` +
  `call|calls|called`;

export function validateSpeechCoverage(
  action: Action,
  narrative: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const text = action.text;

  if (/\bask\w*\b|\?/.test(text)) {
    if (!narrative.includes("?") && !/\bask\w*|questions?\b/i.test(narrative)) {
      errors.push({
        code: "speech.question_dropped",
        message: `action asks a question ("${text.slice(0, 80)}") but the narrative keeps no question (no "?" and no ask-verb): preserve the question instead of replacing it (e.g. with thanks)`,
      });
    }
  }

  if (hasOwnUtterance(text) && !/\bask\w*\b|\?/.test(text)) {
    const rendersSpeech =
      narrative.includes("?") ||
      quotedSegments(narrative).length > 0 ||
      new RegExp(`\\b(?:${NARRATIVE_SPEECH_VERBS})\\b`, "i").test(narrative);
    if (!rendersSpeech) {
      errors.push({
        code: "speech.no_speech_rendered",
        message: `action says something ("${text.slice(0, 80)}") but the narrative renders no speech (no quote and no speech verb): preserve what is said instead of replacing it with silent behavior`,
      });
    }
  }

  return errors;
}
