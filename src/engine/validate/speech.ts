// Speech and narrative-prose validation checks (extracted from physicalValidator.ts).

import type { Action, ActionSemantics, ValidationError } from "../../types.js";
import { maskResumedActivity, normalizeQuotes } from "../deterministicSemantics.js";

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
    errors.push({
      code: "narrative.echoes_action",
      message: `narrative echoes the action text verbatim instead of describing the outcome: narrate what observably happens as a result of the action`,
    });
  }
  return errors;
}

/** Double- and single-quoted segments (content length >= 2). */
export function quotedSegments(text: string): string[] {
  // Exp-6 item 2: normalize curly quotes first so curly-quoted narrative
  // segments ("...") are extracted and compare equal to straight-quoted
  // action text (and vice versa).
  const normalized = normalizeQuotes(text);
  const out: string[] = [];
  const doubleRe = /"([^"]{2,})"/g;
  let m: RegExpExecArray | null;
  while ((m = doubleRe.exec(normalized)) !== null) out.push(m[1]!);
  // Single quotes: avoid matching apostrophes inside words (don't, I'm).
  const singleRe = /(^|[\s(\[{])'([^']{4,})'/g;
  while ((m = singleRe.exec(normalized)) !== null) out.push(m[2]!);
  return out;
}

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

/** Action implies speech even without quotes — judged by Decision AI, never regex. */
export function validateSpeechPreservation(
  semantics: ActionSemantics,
  narrative: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  // Ground truth for uttered words comes from the judge/declaration —
  // never from regex-extracting quotes out of the raw action text.
  // Narrative-side quote parsing stays: it reads structured output
  // (what the model emitted), it does not interpret English meaning.
  const actionQuotes = semantics.quotedSpeech;
  const narrativeQuotes = quotedSegments(narrative);

  // 1. Quoted action words must survive into the narrative (stem overlap —
  // close paraphrase like "Greeting all!" -> "greets all" passes, but a
  // wholly different sentence or a truncation to a greeting fragment fails).
  // Applies to user turns and NPC turns alike: the exact-words rule is not
  // NPC-only. Require at least half of each quote's content words to
  // survive for short quotes (1-3 words: all-but-one may be reworded), and
  // floor(n/2) for longer quotes — so "Hi, I'm Anton,
  // where is my desk?" cannot collapse to just "Hi, I'm Anton", while a
  // 5-word question may keep 2 words plus its question structure (see the
  // interrogative path below).
  for (const q of actionQuotes) {
    const words = contentWords(q);
    if (words.length === 0) continue;
    const kept = words.filter((w) => contentWords(narrative).some((nw) => sameStem(w, nw)));
    const need = words.length <= 3 ? Math.ceil(words.length / 2) : Math.floor(words.length / 2);
    if (kept.length < need && !questionPreserved(q, narrative)) {
      errors.push({
        code: "speech.dropped_words",
        message: `narrative drops the acting actor's exact words ("${q.slice(0, 80)}"): preserve the action's wording — quote or closely paraphrase the FULL utterance, never invent different dialogue or truncate it to a fragment`,
      });
    }
  }

  // 2. Quoted dialogue in the narrative must be grounded in the judged
  // utterances.
  for (const q of narrativeQuotes) {
    const words = contentWords(q);
    if (words.length === 0) continue;
    // Skip tiny interjections ("Hi!", "Oh.") — too short to judge.
    if (normLower(q).length < 8 && words.length <= 1) continue;
    const judgedWords = contentWords(actionQuotes.join(" "));
    const grounded = words.filter((w) => judgedWords.some((aw) => sameStem(w, aw)));
    // Allow short greeting renders when the judge says speech happened
    // but records no exact quote ("Say hello" -> "says 'Hi!'").
    if (grounded.length === 0 && actionQuotes.length === 0 && semantics.speaks) continue;
    // Require at least half the narrative quote's content words to appear
    // in the judged utterances (single-word quotes require the one word).
    const need = words.length <= 1 ? 1 : Math.ceil(words.length / 2);
    if (grounded.length < need) {
      errors.push({
        code: "speech.invented_dialogue",
        message: `narrative invents dialogue ("${q.slice(0, 80)}") not present in the action text: describe ONLY what the acting actor observably does, preserving its exact wording`,
      });
      break; // one dialogue error per turn is enough feedback
    }
  }

  return errors;
}
