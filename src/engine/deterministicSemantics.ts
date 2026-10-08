// Deterministic semantic resolution (Phase 1 / exp-3 items 1+8).
//
// Ground truth for quotes and destinations comes from the ACTION text
// itself via parsing + roster/landmark lookup — no LLM. The LLM judge and
// the consequence `effects` declaration may propose quotes/ids, but the
// grounding layer (actionSemantics.ts) only keeps them when they agree
// with what this module resolves. A judge that can invent Jeff cannot
// ground a Jeff check.
//
// This module is shared by the offline MockSemanticJudge and the
// production grounding path so both resolve mentions identically.

import type { Action, World } from "../types.js";

/**
 * Exp-6 item 2: canonicalize curly/typographic quote characters to their
 * straight ASCII equivalents before any quote comparison. The tick-7
 * misfire: the action text used ' (U+2019) while the narrative used ' —
 * the grounding gate then dropped a perfectly good quote as "ungrounded".
 * Applied to both sides (action text and narrative) before parsing and
 * before substring comparison, so mixed typography never breaks grounding.
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
  // Exp-6 item 2: normalize first so curly-quoted segments ("...") are
  // found and curly apostrophes (don't) canonicalize before comparison.
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
 * awareness, shared by parseActionQuotes and quotedSegments (speech.ts).
 * Dialogue is often single-quoted after a comma or colon ("say to Anton,
 * 'Feel free…'", "greets her: 'Good morning…'"), and quotes contain
 * apostrophes ("I'm Dana"). The naive [^']+ content class truncates at
 * the first apostrophe and misses comma/colon-led quotes — the tick-20
 * invented quote was invisible to the invented_dialogue gate for exactly
 * this reason. An interior ' counts as an apostrophe (not a closer) when
 * followed by a letter; the closing ' must not be followed by a letter
 * (so the ' in "Tanya's" never closes early); bare contractions
 * ("don't", "I'm") never open because the ' isn't quote-led.
 */
const SINGLE_QUOTE_RE = /(^|[\s(\[{,:])'((?:[^']|'(?=[A-Za-z])){4,})'(?![A-Za-z])/g;

export function singleQuotedSegments(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SINGLE_QUOTE_RE)) out.push(m[2]!);
  return out;
}

/** Locomotion verbs: whole-body displacement (mirrors the LLM judge prompt). */
const LOCOMOTION_VERBS =
  "walk|go|head|move|run|step|come|approach|enter|leave|follow|join|return|advance|proceed|shift|slide|stroll|hurry|rush|saunter|drift|sidle";

/** Split action text into clauses: movement scope never crosses these. */
function splitClauses(text: string): string[] {
  return text
    .split(/[.!?;]+\s*|\s+and\s+|\s+then\s+/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/** All name variants that can mention an actor: id, full name, first token. */
export function actorMentionVariants(
  world: World,
  actorId: string,
): string[] {
  const actor = world.actors.find((a) => a.id === actorId);
  if (!actor) return [];
  const out = new Set<string>();
  if (actor.id.length >= 2) out.add(actor.id.toLowerCase());
  if (actor.name.length >= 2) out.add(actor.name.toLowerCase());
  const first = actor.name.toLowerCase().split(/[^a-z0-9]+/)[0];
  if (first && first.length >= 3) out.add(first);
  return [...out];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsVariant(clause: string, variant: string): boolean {
  return new RegExp(`\\b${escapeRegExp(variant)}\\b`, "i").test(clause);
}

/** True when the text names this actor in any context (id, name, first name). */
export function isActorMentioned(
  world: World,
  text: string,
  actorId: string,
): boolean {
  return actorMentionVariants(world, actorId).some((v) => mentionsVariant(text, v));
}

/**
 * First non-acting actor mentioned anywhere in the text (pronouns not
 * resolved — that stays with the LLM). Used for addressees and contact
 * targets: being greeted/thanked/asked/touched needs a mention, not a
 * movement phrase.
 *
 * F21: word-boundary matching — a bare substring match lets id "dan"
 * match "Dana". Uses actorMentionVariants + mentionsVariant (\b…\b).
 */
export function resolveMentionedActorId(
  world: World,
  actingActorId: string,
  actionText: string,
): string | undefined {
  for (const a of world.actors) {
    if (a.id === actingActorId) continue;
    if (actorMentionVariants(world, a.id).some((v) => mentionsVariant(actionText, v))) {
      return a.id;
    }
  }
  return undefined;
}

/**
 * Movement-toward mention: the actor is named in a clause that also
 * describes locomotion toward them — "walk to Nadia", "come closer to
 * Nadia", "toward Jeff", "stand next to Nadia". A mere greeting addressee
 * ("Thanks Tanya!" while walking to a desk) is NOT a destination.
 * Returns every such actor in mention order.
 */
export function findDestinationMentionedActors(
  world: World,
  actingActorId: string,
  actionText: string,
): string[] {
  const found: string[] = [];
  const others = world.actors.filter((a) => a.id !== actingActorId);
  const verbRe = new RegExp(`\\b(?:${LOCOMOTION_VERBS})\\w*\\b`, "i");
  const towardRe = /\btoward[s]?\b/i;
  const besideRe = /\b(?:over to|up to|next to|beside|behind)\b/i;
  for (const clause of splitClauses(actionText)) {
    const hasLocomotion = verbRe.test(clause) || towardRe.test(clause) || besideRe.test(clause);
    if (!hasLocomotion) continue;
    for (const a of others) {
      if (found.includes(a.id)) continue;
      const variants = actorMentionVariants(world, a.id);
      // "from X" names the origin, never the goal ("walk from Tanya to
      // Dana" heads to Dana) — strip origin phrases before matching.
      let goalClause = clause;
      for (const v of variants) {
        goalClause = goalClause.replace(
          new RegExp(`\\bfrom\\s+(?:the\\s+|his\\s+|her\\s+|my\\s+)?${escapeRegExp(v)}\\b`, "i"),
          " ",
        );
      }
      if (variants.some((v) => mentionsVariant(goalClause, v))) {
        found.push(a.id);
      }
    }
  }
  return found;
}

/**
 * Deterministic movement-target actor: the LAST actor named in a
 * movement-toward clause. Last-wins so "walk from Tanya to Dana" resolves
 * to Dana (the goal), not Tanya (the origin).
 */
export function resolveDestinationActorId(
  world: World,
  actingActorId: string,
  actionText: string,
): string | undefined {
  const found = findDestinationMentionedActors(world, actingActorId, actionText);
  return found.length > 0 ? found[found.length - 1]! : undefined;
}

/** Object name variants: id, de-underscored id, name. */
export function objectMentionVariants(obj: { id: string; name: string }): string[] {
  const out = new Set<string>();
  if (obj.id.length >= 3) {
    out.add(obj.id.toLowerCase());
    out.add(obj.id.toLowerCase().replace(/_/g, " "));
  }
  if (obj.name.length >= 3) out.add(obj.name.toLowerCase());
  return [...out];
}

/** Object mention with plural tolerance ("west-side desks" hits the desks). */
export function mentionsObjectVariant(clause: string, variant: string): boolean {
  if (mentionsVariant(clause, variant)) return true;
  return new RegExp(`\\b${escapeRegExp(variant)}s\\b`, "i").test(clause);
}

/**
 * Generic kind-word → object matchers, shared by destination resolution
 * and manipulated-object detection. A "desk" keyword matches "Desk lamp"
 * and "Anton's desk sign" by NAME — the optional third element (furniture
 * id filter) drops name-only matches when an id matches, since those are
 * a prop and a label, not places to stand (Exp-5 tick 15).
 */
const GENERIC_OBJECT_KEYWORDS: Array<[RegExp, RegExp, RegExp?]> = [
  // Exp-4 tick 7: "grab leftover coffee" means the lounge leftovers
  // (lounge_mug), not the machine fixture — checked before bare coffee.
  [/\bleftover\b/i, /lounge/i],
  [/\blounge\b/i, /lounge/i],
  [/\bcoffee\b/i, /coffee/i],
  [/\bdesks?\b/i, /desk/i, /desk/i],
  [/\bdoors?\b/i, /door/i, /door/i],
  [/\bwalls?\b/i, /wall/i, /wall/i],
  [/\blaptops?\b/i, /laptop/i],
  [/\bchairs?\b/i, /chair/i, /chair|sofa/i],
  [/\bmugs?\b/i, /mug/i],
];

/**
 * Objects matching a generic kind word in `text` ("the laptop" →
 * anton_laptop), ranked for grab mode (props over furniture) when several
 * match. Used by destination resolution and manipulated-object detection.
 */
function matchGenericKindObjects(
  world: World,
  text: string,
  actingActorId?: string,
): { id: string; name: string }[] {
  const ids = new Set<string>();
  const pool: { id: string; name: string; x: number; y: number; w: number; h: number }[] = [];
  for (const [wordRe, objRe, furnitureIdRe] of GENERIC_OBJECT_KEYWORDS) {
    if (!wordRe.test(text)) continue;
    const matches = world.scene.objects.filter(
      (o) => objRe.test(o.name) || objRe.test(o.id),
    );
    const kindMatches =
      furnitureIdRe !== undefined ? matches.filter((o) => furnitureIdRe.test(o.id)) : matches;
    for (const o of kindMatches.length > 0 ? kindMatches : matches) {
      if (!ids.has(o.id)) {
        ids.add(o.id);
        pool.push(o);
      }
    }
  }
  if (pool.length === 0) return [];
  // Grab-mode ranking prefers the manipulated prop (laptop) over the
  // furniture (desk) when a clause names both.
  const ranked = rankDestinationObjects(world, pool, text, actingActorId, "grab");
  const top = pool.find((o) => o.id === ranked);
  return top !== undefined ? [{ id: top.id, name: top.name }] : [];
}

/**
 * Exp-6 item 8: objects the action text MANIPULATES — an object mention
 * (by id/name, or by generic kind word like "the laptop") in a clause
 * carrying a grab/manipulation verb. Distinct from the movement
 * destination: "walk to the desk to set up the laptop" manipulates the
 * laptop, not the desk. Used by the object affordance nudge so the retry
 * feedback can demand the exact object/prop patch up front.
 */
const MANIPULATION_CLAUSE_RE =
  /\b(grab|grabs|grabbing|pick(?:s|ed|ing)?\s+up|pour|pours|pouring|fill|fills|filling|brew|brews|brewing|open|opens|opening|boot|boots|booting|hold|holds|holding|carry|carries|carrying|set\s+up|use|uses|using|sip|sips|sipping|drink|drinks|drinking|sit|sits|sitting|sat)\b/i;

export function findManipulatedObjects(
  world: World,
  actionText: string,
  actingActorId?: string,
): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const add = (o: { id: string; name: string }): void => {
    if (!out.some((e) => e.id === o.id)) out.push({ id: o.id, name: o.name });
  };
  for (const clause of splitClauses(actionText)) {
    if (!MANIPULATION_CLAUSE_RE.test(clause)) continue;
    let explicit = false;
    for (const o of world.scene.objects) {
      if (objectMentionVariants(o).some((v) => mentionsObjectVariant(clause, v))) {
        add(o);
        explicit = true;
      }
    }
    // Bare kind words ("set up the laptop", "pour a coffee") carry no
    // id/name — fall back to the generic kind matchers, grab-ranked.
    if (!explicit) {
      for (const o of matchGenericKindObjects(world, clause, actingActorId)) add(o);
    }
  }
  return out;
}

/**
 * Explicit speech verbs (Exp-4 item 3, tick 14): explaining, telling,
 * asking, nodding-along etc. count as speech even with no quote marks.
 * "Nod and start explaining Anton's first task" speaks — otherwise every
 * explanation is droppable. Greeting verbs stay out of the *unquoted*
 * set only in the sense that quotes still dominate; the token itself is
 * intentionally broad (rendering stays lenient, content strict).
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
 * for any quoted segment (existing ground truth) or an unquoted speech
 * verb above ("explain", "nod and start explaining...", "thank both").
 * Used by the grounding layer to force `speaks=true` so unquoted
 * explanations cannot pass hollow.
 */
export function hasSpeechToken(text: string): boolean {
  if (parseActionQuotes(text).length > 0) return true;
  // A bare question mark is an utterance even without a verb ("Is this my spot?").
  if (text.includes("?")) return true;
  return new RegExp(`\\b(?:${SPEECH_VERBS})\\b`, "i").test(text);
}

/** Object-kind ranking for walk vs grab targets (Exp-4 item 5). */
function objectKindScore(
  o: { id: string; name: string },
  mode: "walk" | "grab",
): number {
  const id = o.id.toLowerCase();
  const name = o.name.toLowerCase();
  const hay = `${id} ${name}`;
  // Fixtures / building fabric are never grab targets; signs are labels,
  // not destinations to stand at.
  const isFixture = /wall|window|door|plant|printer|cooler|cabinet|sofa|table/i.test(hay);
  const isSign = /sign/i.test(hay);
  const isFurniture = /desk|table|chair|sofa|machine/i.test(hay);
  const isProp = /mug|cup|laptop|papers|note|document|lamp/i.test(hay);
  if (mode === "walk") {
    // Walk targets prefer furniture (desks, machines, chairs) over loose
    // props over signs over fixtures. Signs rank after furniture even when
    // their name contains a furniture word ("Anton's desk sign" is a label
    // on a desk, not a place to stand). Props are checked BEFORE furniture:
    // a "Desk lamp" contains the word "desk" but its head noun is a loose
    // prop, not a place to stand (Exp-5 tick 15: anton_lamp won over
    // anton_desk on proximity tiebreak because both scored as furniture).
    if (isSign) return 2;
    if (isProp) return 1;
    if (isFurniture && !isFixture) return 0;
    if (isFixture) return 3;
    return 1;
  }
  // Grab targets ("pour", "pick up", "set up the laptop") prefer props
  // (mugs, laptops) over the fixture that houses them (coffee_machine).
  if (isProp) return 0;
  if (isSign) return 2;
  if (isFixture && !isFurniture) return 3;
  if (/coffee/i.test(hay) && !/mug|cup/i.test(hay)) return 2;
  return 1;
}

/**
 * Ranked object scoring (Exp-4 item 5): ownership ("his"→actor's own
 * objects) beats proximity beats kind. Returns the best candidate id or
 * undefined. `mode` selects walk-target ranking (furniture first) vs
 * grab-target ranking (props first).
 */
export function rankDestinationObjects(
  world: World,
  candidates: { id: string; name: string; x: number; y: number; w: number; h: number }[],
  actionText: string,
  actingActorId: string | undefined,
  mode: "walk" | "grab",
): string | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0]!.id;
  const actor = actingActorId ? world.actors.find((a) => a.id === actingActorId) : undefined;
  const actorLower = (actingActorId ?? "").toLowerCase();
  const actorName = actor?.name.toLowerCase() ?? actorLower;
  // Possessive scope: "my"/"own" scopes to the acting actor's objects;
  // "X's" ("Tanya's", "Dana's desk") scopes to that owner. Exp-6 item 1:
  // "his"/"her"/"their" is third-person — when the text names exactly one
  // other actor it scopes to THEM ("lead Anton toward his desk" →
  // Anton's), not to the acting actor (the old code treated "his" as
  // self-possessive and misranked tanya_desk over anton_desk on tick 7).
  // With zero or several other actors named it falls back to the acting
  // actor (subject-possessive, e.g. "Anton walks to his desk").
  const selfPossessive = /\b(my|own)\b/i.test(actionText);
  const thirdPossessive = /\b(his|her|their)\b/i.test(actionText);
  const otherMentioned = world.actors.filter(
    (a) => a.id !== actingActorId && isActorMentioned(world, actionText, a.id),
  );
  const namedOwner = world.actors.find(
    (a) =>
      a.id !== actingActorId &&
      new RegExp(`\\b${a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[''’]s\\b`, "i").test(actionText),
  );
  // Exp-3 item 7 (S5, tick-24 repro): "Sit down on MY chair at MY new desk
  // …, waiting for HER to show me the test plan" resolved to tanya_desk —
  // the bare object pronoun "her" (not a possessive of "desk") hijacked
  // ownerPrefix because third-person outranked self-possessive. "my"/"own"
  // now wins outright; "his"/"her"/"their" only scopes ownership when
  // grammatically attached to a landmark noun ("his desk"), never as a
  // bare pronoun elsewhere in the sentence.
  const thirdPossessiveAttached =
    /\b(his|her|their)\s+(the\s+)?(desk|chair|table|machine|laptop|mug|cup|papers|sofa|office|cubicle|screen|monitor|notebook|phone)\b/i.test(
      actionText,
    );
  const ownerPrefix = namedOwner
    ? namedOwner.id.toLowerCase()
    : selfPossessive && actorLower
      ? actorLower
      : thirdPossessiveAttached && otherMentioned.length === 1
        ? otherMentioned[0]!.id.toLowerCase()
        : (selfPossessive || thirdPossessive) && actorLower
          ? actorLower
          : undefined;
  // Name-prefix check follows the same owner (fixes the old fallback that
  // compared against the acting actor's name on the third-person path).
  const ownerName =
    namedOwner?.name.toLowerCase() ??
    (thirdPossessiveAttached && otherMentioned.length === 1
      ? otherMentioned[0]!.name.toLowerCase()
      : actorName);
  const scored = candidates.map((o) => {
    const idLower = o.id.toLowerCase();
    const nameLower = o.name.toLowerCase();
    let ownedScore = 1;
    if (ownerPrefix) {
      ownedScore =
        idLower.startsWith(`${ownerPrefix}_`) || nameLower.startsWith(ownerName) ? 0 : 2;
    } else if (actorLower) {
      // No possessive: mildly prefer the actor's own objects over others'
      // (walking to "the desk" from your spawn usually means your desk),
      // but never override an explicit name match handled by the caller.
      ownedScore = idLower.startsWith(`${actorLower}_`) ? 0.5 : 1;
    }
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;
    const dist = actor ? Math.hypot(actor.x - cx, actor.y - cy) : 0;
    return { o, ownedScore, kind: objectKindScore(o, mode), dist };
  });
  scored.sort(
    (a, b) =>
      a.ownedScore - b.ownedScore || a.kind - b.kind || a.dist - b.dist || a.o.id.localeCompare(b.o.id),
  );
  return scored[0]!.o.id;
}

/**
 * Deterministic movement-target landmark: object whose id or name appears
 * in a movement-toward clause, else the generic/possessive fallback below.
 * Exp-4 item 5: every multi-candidate choice is ranked (ownership →
 * kind → proximity) instead of first-keyword-match; walk targets prefer
 * furniture over props/signs ("set up the laptop" no longer resolves to
 * someone else's laptop-sign when a desk walk is meant — the grab/walk
 * mode is picked from the action verbs).
 */
/**
 * Detailed destination-object resolution with provenance.
 *
 * `explicit` is true when the target was named directly in a
 * movement/grab clause ("walk to Anton's desk", "open the laptop") —
 * strong textual evidence. False when it came from the generic
 * keyword/possessive fallback ("his desk" → ownership heuristic) — a
 * guess the consequence model's declaration may legitimately override
 * (Exp-6 item 1: model-declared existing ids outrank keyword-first-match;
 * the resolver stays the fallback for undeclared targets).
 */
export function resolveDestinationObjectIdDetailed(
  world: World,
  actionText: string,
  actingActorId?: string,
): { id: string | undefined; explicit: boolean } {
  const verbRe = new RegExp(`\\b(?:${LOCOMOTION_VERBS})\\w*\\b`, "i");
  const towardRe = /\btoward[s]?\b|\b(?:over to|up to|next to|beside|behind)\b/i;
  const grabRe = /\b(grab|grabs|pick(?:s|ed|ing)?\s+up|pour|pours|fill|fills|brew|open|opens|boot|hold|holds|holding|carry|carries|set\s+up|use|uses|using)\b/i;
  // Exp-5 tick 18: the walk/grab mode is per-CLAUSE, not per-action. "Head
  // toward the west-side desks to set up the laptop" carries both a directed
  // walk ("head toward … desks") and a grab verb ("set up … laptop") — the
  // whole-action grab mode resolved the *walk target* to anton_laptop (a
  // prop) and the good walk then failed "not closer to the laptop". A clause
  // with directed-walk tokens (locomotion verb or toward-phrase) always
  // ranks as a walk target; grab mode applies only to clauses without one
  // ("open the laptop", "pour a coffee").
  const clauseMode = (clause: string): "walk" | "grab" =>
    verbRe.test(clause) || towardRe.test(clause) ? "walk" : "grab";
  const mode: "walk" | "grab" = grabRe.test(actionText) ? "grab" : "walk";
  // Exp-4 tick 15: "the desk with the ANTON sign" names a sign, but the
  // walk target is the furniture. A clause whose only hits are signs while
  // naming furniture falls through to ranked generic resolution.
  const furnitureWordRe = /\b(desks?|tables?|chairs?|sofas?|machines?)\b/i;
  for (const clause of splitClauses(actionText)) {
    if (!verbRe.test(clause) && !towardRe.test(clause) && !grabRe.test(clause)) continue;
    const hits = world.scene.objects.filter((o) =>
      objectMentionVariants(o).some((v) => mentionsObjectVariant(clause, v)),
    );
    if (hits.length > 0) {
      const nonSignHits = hits.filter((o) => !/sign/i.test(`${o.id} ${o.name}`));
      if (nonSignHits.length > 0 || !furnitureWordRe.test(clause)) {
        const pool = nonSignHits.length > 0 ? nonSignHits : hits;
        const ranked = rankDestinationObjects(world, pool, actionText, actingActorId, clauseMode(clause));
        if (ranked) return { id: ranked, explicit: true };
      }
    }
  }
  const possessive = /\bmy\b|\bown\b/i.test(actionText);
  for (const [wordRe, objRe, furnitureIdRe] of GENERIC_OBJECT_KEYWORDS) {
    if (wordRe.test(actionText)) {
      const matches = world.scene.objects.filter(
        (o) => objRe.test(o.name) || objRe.test(o.id),
      );
      if (matches.length === 0) continue;
      const kindMatches =
        furnitureIdRe !== undefined ? matches.filter((o) => furnitureIdRe.test(o.id)) : matches;
      const pool = kindMatches.length > 0 ? kindMatches : matches;
      const isFurnitureKeyword = furnitureIdRe !== undefined;
      const grabMode: "walk" | "grab" =
        isFurnitureKeyword
          ? "walk"
          : /\bcoffee\b/i.test(wordRe.source) && grabRe.test(actionText)
            ? "grab"
            : mode;
      if (possessive && actingActorId) {
        const ranked = rankDestinationObjects(world, pool, actionText, actingActorId, grabMode);
        if (ranked) return { id: ranked, explicit: false };
      }
      const ranked = rankDestinationObjects(world, pool, actionText, actingActorId, grabMode);
      if (ranked) return { id: ranked, explicit: false };
    }
  }
  return { id: undefined, explicit: false };
}

/**
 * Deterministic movement-target landmark: object whose id or name appears
 * in a movement-toward clause, else the generic/possessive fallback below.
 * (See resolveDestinationObjectIdDetailed for provenance details.)
 */
export function resolveDestinationObjectId(
  world: World,
  actionText: string,
  actingActorId?: string,
): string | undefined {
  return resolveDestinationObjectIdDetailed(world, actionText, actingActorId).id;
}

/** Stopwords/possessives stripped before fuzzy object-id matching. */
const FUZZY_STOPWORDS = new Set([
  "a", "an", "the", "my", "his", "her", "their", "our", "your", "its",
  "this", "that", "these", "those", "of", "to", "at", "on", "in",
]);

/** Near-synonym head nouns the scene uses interchangeably ("cup"→"mug"). */
const FUZZY_SYNONYMS: Record<string, string> = {
  cup: "mug",
  couch: "sofa",
  settee: "sofa",
  pc: "laptop",
  computer: "laptop",
  telephone: "phone",
};

/**
 * Exp-3 item 7 (S5, A4 — tick-15a repro): fuzzy-match a model-declared
 * object id that names nothing in the scene ("anton's coffee cup" →
 * `coffee_mug`). Tokenizes on non-alphanumerics, strips possessives
 * ("anton's" → "anton") and stopwords, then scores scene objects by
 * shared content tokens — requires ≥2 shared tokens or a head-noun
 * match, and returns undefined when the best score is ambiguous (tied).
 * Pure. Conservative by design: a wrong fuzzy match is worse than a drop.
 */
export function fuzzyMatchObjectId(declared: string, world: World): string | undefined {
  const tokens = declared
    .toLowerCase()
    .replace(/[''’]s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !FUZZY_STOPWORDS.has(t))
    .map((t) => FUZZY_SYNONYMS[t] ?? t);
  if (tokens.length === 0) return undefined;
  const tokenSet = new Set(tokens);
  const scored = world.scene.objects.map((o) => {
    const hay = `${o.id} ${o.name}`.toLowerCase().replace(/_/g, " ");
    const hayTokens = new Set(
      hay
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3)
        .map((t) => FUZZY_SYNONYMS[t] ?? t),
    );
    let shared = 0;
    for (const t of tokenSet) if (hayTokens.has(t)) shared++;
    const headNoun = tokens[tokens.length - 1]!;
    const headMatch = hayTokens.has(headNoun);
    return { o, shared, headMatch, score: shared * 2 + (headMatch ? 1 : 0) };
  });
  scored.sort((a, b) => b.score - a.score || a.o.id.localeCompare(b.o.id));
  const best = scored[0];
  if (!best || best.score === 0) return undefined;
  // Require real evidence: ≥2 shared tokens, or a head-noun match plus at
  // least one more shared token. A lone head-noun ("cup" alone) is too weak.
  if (!(best.shared >= 2 || (best.headMatch && best.shared >= 1 && tokens.length >= 2)))
    return undefined;
  // Ambiguous: tied best score → no match rather than a guess.
  if (scored.length > 1 && scored[1]!.score === best.score) return undefined;
  return best.o.id;
}

export type DeterministicSemantics = {
  /** Ground-truth quotes parsed from the action text (exact substrings). */
  quotedSpeech: string[];
  destinationActorId?: string;
  destinationObjectId?: string;
  /**
   * Exp-6 item 1: true when destinationObjectId was resolved from a direct
   * name/id mention in a movement clause (strong textual evidence); false
   * when it came from the generic keyword/possessive fallback (a guess the
   * consequence model's declaration may override).
   */
  destinationObjectExplicit?: boolean;
  /** First mentioned non-acting actor — the spoken-to candidate. */
  addresseeActorId?: string;
};

/**
 * F35: the single canonical "resumed activity" mask. Resuming a task is
 * not relocating ("return/back to typing/work/...") and must never read
 * as locomotion or as starting an object interaction. Shared by
 * maskNonLocomotion below and by validate/speech.ts (which imports and
 * re-exports this) — one implementation, no drift.
 */
export function maskResumedActivity(t: string): string {
  let out = t;
  out = out.replace(
    /\breturn\w*\s+to\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?[a-z]+ing\b/gi,
    " ",
  );
  // Item C8 (S4): "return/returns/returned <focus|attention>" (no "to") is
  // resumed activity, not locomotion — "return focus to my laptop" must not
  // read as a displacement token that forces phantom movement.
  out = out.replace(
    /\breturn\w*\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?(focus|attention)\b/gi,
    " ",
  );
  // Item C8 (S4): the "return/back to <noun>" family gains the optional
  // determiner ("return to the task") plus attention/laptop ("return ...
  // to my laptop") — resuming work at the laptop is not relocating to it.
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
 * cognition / resumed activity) to clause end. Canonical allowlist shared
 * by the mock judge and the deterministic moves-grounding below; the LLM
 * judge prompt carries the equivalent rule in prose.
 *
 * Resuming a task is not relocating ("return/back to typing/work/...").
 * Perception/cognition verbs head non-locomotion clauses: looking or
 * glancing anywhere ("look up", "glance over notes"), asking, sipping,
 * reviewing, preparing, typing/thinking/waiting. Masked to clause end so a
 * later movement verb in the SAME clause is not misread either — nuanced
 * mixed clauses belong to the LLM judge.
 */
export function maskNonLocomotion(text: string): string {
  // F35: resumed-activity masking is the canonical maskResumedActivity
  // above (shared with validate/speech.ts).
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
 * Explicit whole-body displacement verbs (Phase 2 / exp-3 item 3):
 * walk/go/head/move/approach/`return to <place>` plus the close synonyms
 * the LLM judge prompt already treats as locomotion (run/step/come/enter/
 * leave/follow/join, saunter/drift/sidle/dance over, roll one's chair, slip
 * out, teleport). Perception/cognition verbs (look/glance/ask/sip/review/
 * prepare/type/...) are NEVER here — their clauses are masked above.
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
 * Exp-7 item A7: stationary-work verbs — fine-motor / observational
 * activity that never implies whole-body displacement (exp-7 B7: "typing
 * furiously" / "stare blankly" arrived with moves=true from the model's
 * self-declared effects and died on movement.no_position_change). A
 * displacement token in the same text still wins (a walk-then-type turn
 * moves); without one, the model's moved=true is ungrounded and the
 * grounding layer downgrades it instead of demanding x/y for typing.
 */
const STATIONARY_WORK_VERBS =
  "type|types|typing|typed|stare|stares|staring|stared|sip|sips|sipping|sipped|" +
  "read|reads|reading|work|works|working|worked|listen|listens|listening|" +
  "watch|watches|watching|scroll|scrolls|scrolling|click|clicks|clicking";

export function hasStationaryWorkToken(text: string): boolean {
  // NB: tested against the RAW text, not the maskNonLocomotion output —
  // the mask's perception/cognition clause removal exists to avoid
  // locomotion false positives (the opposite concern), and it strips
  // exactly these verbs. A spurious hit here is harmless: the grounding
  // downgrade only fires when something already claimed moves=true.
  return new RegExp(`\\b(?:${STATIONARY_WORK_VERBS})\\b`, "i").test(text);
}

/**
 * Phase 2 (exp-3 item 3): does the action text carry a
 * destination-or-displacement token? `moves` requires one: an explicit
 * displacement verb (masked for perception/cognition/resumed-activity
 * clauses, body-part "head", and subordinate someone-else clauses) or an
 * explicit proximity phrase. A glance, question, sip, or typing session
 * carries no token — so a `moves=true` verdict on such text is ungrounded
 * and the grounding layer downgrades it (kills forced teleports and
 * ask-question fallbacks in one edit).
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
 * The deterministic judge (Phase 1 role split): quotes and destinations
 * resolved from the action text with parsing + roster/landmark lookup, no
 * LLM. LLM output (moves/speaks/contact flags) is checked against this —
 * never the other way around.
 */
export function resolveDeterministicSemantics(
  world: World,
  action: Action,
): DeterministicSemantics {
  const out: DeterministicSemantics = {
    quotedSpeech: parseActionQuotes(action.text),
  };
  const destActor = resolveDestinationActorId(world, action.actorId, action.text);
  if (destActor !== undefined) out.destinationActorId = destActor;
  const destObj = resolveDestinationObjectIdDetailed(world, action.text, action.actorId);
  if (destObj.id !== undefined) {
    out.destinationObjectId = destObj.id;
    out.destinationObjectExplicit = destObj.explicit;
  }
  const mentioned = resolveMentionedActorId(world, action.actorId, action.text);
  if (mentioned !== undefined) out.addresseeActorId = mentioned;
  return out;
}
