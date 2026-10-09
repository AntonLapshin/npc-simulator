// Pure text predicates for action/narrative analysis.
//
// Phase 1 (renderer architecture): pure functions live in `src/core/` —
// deterministic, no I/O, no argument mutation, no randomness. The verb
// ontologies and masks below were moved verbatim from
// `src/engine/deterministicSemantics.ts` and
// `src/engine/validate/movement.ts`; the old paths remain as re-export
// shims.

/**
 * Exp-6 item 2: canonicalize curly/typographic quote characters to their
 * straight ASCII equivalents before any quote comparison.
 */
const QUOTE_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/[‘’‚‛‹›`´]/g, "'"],
  [/[“”„‟«»]/g, '"'],
];

export function normalizeQuotes(s: string): string {
  let out = s;
  for (const [re, rep] of QUOTE_NORMALIZATIONS) out = out.replace(re, rep);
  return out;
}

/** Double- and single-quoted segments (content length >= 2). Format parsing, not a verb ontology. */
export function parseActionQuotes(text: string): string[] {
  const normalized = normalizeQuotes(text);
  const out: string[] = [];
  const doubleRe = /"([^"]{2,})"/g;
  let m: RegExpExecArray | null;
  while ((m = doubleRe.exec(normalized)) !== null) out.push(m[1]!);
  out.push(...singleQuotedSegments(normalized));
  return out;
}

/**
 * Exp-3 item 6 (S3): single-quoted segment extraction with apostrophe
 * awareness. An interior ' counts as an apostrophe (not a closer) when
 * followed by a letter; the closing ' must not be followed by a letter;
 * bare contractions ("don't", "I'm") never open because the ' isn't
 * quote-led.
 */
const SINGLE_QUOTE_RE = /(^|[\s(\[{,:])'((?:[^']|'(?=[A-Za-z])){4,})'(?![A-Za-z])/g;

export function singleQuotedSegments(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SINGLE_QUOTE_RE)) out.push(m[2]!);
  return out;
}

/**
 * F35: the single canonical "resumed activity" mask. Resuming a task is
 * not relocating ("return/back to typing/work/...")
 */
export function maskResumedActivity(t: string): string {
  let out = t;
  out = out.replace(
    /\breturn\w*\s+to\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?[a-z]+ing\b/gi,
    " ",
  );
  // Item C8 (S4): "return/returns/returned <focus|attention>" (no "to") is
  // resumed activity, not locomotion.
  out = out.replace(
    /\breturn\w*\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?(focus|attention)\b/gi,
    " ",
  );
  const resumedNouns = "(work|tasks?|focus|focusing|attention|laptop|business|dut(y|ies))";
  const det = "(?:(?:the|a|an|his|her|their|my|your|its)\\s+)?";
  out = out.replace(
    new RegExp(`\\breturn\\w*\\s+to\\s+${det}${resumedNouns}\\b`, "gi"),
    " ",
  );
  out = out.replace(
    /\b(?:go\w*|get\w*|come\w*|turn\w*)\s+back\s+to\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?[a-z]+ing\b/gi,
    " ",
  );
  out = out.replace(
    /\bback\s+to\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?[a-z]+ing\b/gi,
    " ",
  );
  out = out.replace(
    new RegExp(`\\b(?:go\\w*|get\\w*|come\\w*|turn\\w*)\\s+back\\s+to\\s+${det}${resumedNouns}\\b`, "gi"),
    " ",
  );
  out = out.replace(new RegExp(`\\bback\\s+to\\s+${det}${resumedNouns}\\b`, "gi"), " ");
  return out;
}

/**
 * Phase 2 (exp-3 item 3): mask non-locomotion clauses (perception /
 * cognition / resumed activity) to clause end.
 */
export function maskNonLocomotion(text: string): string {
  let t = maskResumedActivity(text);
  // Metaphor is not movement ("go the extra mile").
  t = t.replace(/\bgo\s+(?:the\s+)?extra\s+mile\b/gi, " ");
  // Perception/cognition verbs head non-locomotion clauses.
  t = t.replace(
    /\b(look|looks|looking|glance|glances|glancing|ask|asks|asked|asking|sip|sips|sipping|drink|drinks|drinking|drank|review|reviews|reviewing|prepare|prepares|preparing|type|types|typing|typed|think|thinks|thinking|wait|waits|waiting)\b[^,.;]*/gi,
    " ",
  );
  return t;
}

/**
 * Explicit whole-body displacement verbs (Phase 2 / exp-3 item 3).
 * Perception/cognition verbs (look/glance/ask/sip/review/prepare/type/...)
 * are NEVER here — their clauses are masked above.
 *
 * Bare "head" is deliberately excluded (body-part collisions: "shake his
 * head"); headed/heading/head-to-<dir> is matched separately below.
 */
const DISPLACEMENT_VERBS =
  "walk|walks|walking|walked|go|goes|going|went|move|moves|moving|moved|run|runs|running|ran|" +
  "step|steps|stepping|stepped|come|comes|coming|came|approach|approaches|approaching|approached|" +
  "enter|enters|entering|entered|leave|leaves|leaving|follow|follows|following|followed|" +
  "join|joins|joining|joined|return|returns|returning|returned|advance|advances|advancing|" +
  "proceed|proceeds|proceeding|shift|shifts|shifting|slide|slides|sliding|stroll|strolls|strolling|" +
  "hurry|hurries|hurrying|rush|rushes|rushing|rushed|saunter|saunters|sauntering|" +
  "drift|drifts|drifting|sidle|sidles|sidling|dance|dances|dancing|" +
  "roll|rolls|rolling|rolled|slip|slips|slipping|slipped|teleport|teleports|teleporting";

const HEAD_TO_RE =
  /\b(heads?\s+(to|toward|towards|for|into|out|off|over|back|down|up|north|south|east|west|through|across|along)|headed|heading\s+(to|toward|towards|for|into|out|off|over|back))\b/i;

const PROXIMITY_RE =
  /\b(closer|close to|nearer|toward|towards|up to|next to|beside|behind|over to)\b/i;

/**
 * Phase 2 (exp-3 item 3): does the action text carry a
 * destination-or-displacement token? `moves` requires one: an explicit
 * displacement verb (masked for perception/cognition/resumed-activity
 * clauses, body-part "head", and subordinate someone-else clauses) or an
 * explicit proximity phrase. A glance, question, sip, or typing session
 * carries no token.
 *
 * Over-broad by design: an unrecognized real verb simply keeps the merged
 * verdict (status quo) — only the absence of ANY token downgrades.
 */
export function hasDisplacementToken(text: string): boolean {
  let t = text;
  // Body-part "head" is not locomotion ("nodding the head").
  t = t.replace(/\b(his|her|my|your|their|its|the|a|an)\s+heads?\b/gi, " ");
  t = maskNonLocomotion(t);
  // Someone ELSE's motion in a subordinate clause ("as he enters") is not
  // the acting actor moving.
  t = t.replace(/\b(as|while|when)\b[^,.;]*/gi, " ");
  if (HEAD_TO_RE.test(t)) return true;
  if (new RegExp(`\\b(?:${DISPLACEMENT_VERBS})\\b`, "i").test(t)) return true;
  return PROXIMITY_RE.test(t);
}

/**
 * Exp-7 item A7: stationary-work verbs — fine-motor / observational
 * activity that never implies whole-body displacement. A displacement
 * token in the same text still wins (a walk-then-type turn moves);
 * without one, the model's moved=true is ungrounded.
 */
const STATIONARY_WORK_VERBS =
  "type|types|typing|typed|stare|stares|staring|stared|sip|sips|sipping|sipped|" +
  "read|reads|reading|work|works|working|worked|listen|listens|listening|" +
  "watch|watches|watching|scroll|scrolls|scrolling|click|clicks|clicking";

export function hasStationaryWorkToken(text: string): boolean {
  // NB: tested against the RAW text, not the maskNonLocomotion output —
  // the mask strips exactly these verbs, and a spurious hit here is
  // harmless: the grounding downgrade only fires when something already
  // claimed moves=true.
  return new RegExp(`\\b(?:${STATIONARY_WORK_VERBS})\\b`, "i").test(text);
}

/**
 * Explicit speech verbs (Exp-4 item 3, tick 14): explaining, telling,
 * asking, nodding-along etc. count as speech even with no quote marks.
 */
const SPEECH_VERBS =
  "say|says|said|tell|tells|told|speak|speaks|spoke|spoken|talk|talks|talked|" +
  "ask|asks|asked|asking|answer|answers|answered|reply|replies|replied|" +
  "explain|explains|explained|explaining|describe|describes|described|describing|" +
  "mention|mentions|mentioned|mentioning|discuss|discusses|discussed|discussing|" +
  "announce|announces|announced|shout|shouts|shouted|whisper|whispers|whispered|" +
  "call|calls|called|thank|thanks|thanked|thanking|greet|greets|greeted|greeting|" +
  "introduce|introduces|introduced|introducing|brief|briefs|briefed|briefing|" +
  "nod|nods|nodded|nodding|" +
  "hello|hi|hey|speech|exclaim|exclaims|exclaimed|exclaiming";

/**
 * Exp-4 item 3: does the action text carry an explicit speech token? True
 * for any quoted segment or an unquoted speech verb above.
 */
export function hasSpeechToken(text: string): boolean {
  if (parseActionQuotes(text).length > 0) return true;
  // A bare question mark is an utterance even without a verb ("Is this my spot?").
  if (text.includes("?")) return true;
  return new RegExp(`\\b(?:${SPEECH_VERBS})\\b`, "i").test(text);
}

export type DirectionHint = "north" | "south" | "east" | "west";

/**
 * First cardinal direction named in the text ("a few steps east" →
 * "east"). Word-boundary matched; null when no direction is named.
 * Diagonal compounds ("north-east") are out of scope — the first cardinal
 * word wins, which is enough for step tie-breaking.
 */
export function extractDirectionHint(text: string): DirectionHint | null {
  const m = /\b(north|south|east|west)\b/i.exec(text);
  if (!m) return null;
  return m[1]!.toLowerCase() as DirectionHint;
}
