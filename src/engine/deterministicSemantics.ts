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

/** Double- and single-quoted segments (content length >= 2). Format parsing, not a verb ontology. */
export function parseActionQuotes(text: string): string[] {
  const out: string[] = [];
  const doubleRe = /"([^"]{2,})"/g;
  let m: RegExpExecArray | null;
  while ((m = doubleRe.exec(text)) !== null) out.push(m[1]!);
  // Single quotes: avoid matching apostrophes inside words (don't, I'm).
  const singleRe = /(^|[\s(\[{])'([^']{4,})'/g;
  while ((m = singleRe.exec(text)) !== null) out.push(m[2]!);
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
 */
export function resolveMentionedActorId(
  world: World,
  actingActorId: string,
  actionText: string,
): string | undefined {
  const lowered = actionText.toLowerCase();
  for (const a of world.actors) {
    if (a.id === actingActorId) continue;
    if (a.id.toLowerCase().length >= 2 && lowered.includes(a.id.toLowerCase())) return a.id;
    if (a.name.toLowerCase().length >= 2 && lowered.includes(a.name.toLowerCase())) return a.id;
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
function objectMentionVariants(obj: { id: string; name: string }): string[] {
  const out = new Set<string>();
  if (obj.id.length >= 3) {
    out.add(obj.id.toLowerCase());
    out.add(obj.id.toLowerCase().replace(/_/g, " "));
  }
  if (obj.name.length >= 3) out.add(obj.name.toLowerCase());
  return [...out];
}

/**
 * Deterministic movement-target landmark: object whose id or name appears
 * in a movement-toward clause, else the generic/possessive fallback below.
 * Generic landmark words map to the first matching object — except with a
 * possessive ("my desk"), which resolves to the acting actor's own object
 * first (anton_desk for anton's "my desk").
 */
export function resolveDestinationObjectId(
  world: World,
  actionText: string,
  actingActorId?: string,
): string | undefined {
  const verbRe = new RegExp(`\\b(?:${LOCOMOTION_VERBS})\\w*\\b`, "i");
  const towardRe = /\btoward[s]?\b|\b(?:over to|up to|next to|beside|behind)\b/i;
  for (const clause of splitClauses(actionText)) {
    if (!verbRe.test(clause) && !towardRe.test(clause)) continue;
    for (const o of world.scene.objects) {
      if (objectMentionVariants(o).some((v) => mentionsVariant(clause, v))) return o.id;
    }
  }
  const possessive = /\bmy\b|\bown\b/i.test(actionText);
  const generic: Array<[RegExp, RegExp]> = [
    [/\bcoffee\b/i, /coffee/i],
    [/\bdesk\b/i, /desk/i],
    [/\bdoor\b/i, /door/i],
    [/\bwall\b/i, /wall/i],
    [/\blaptop\b/i, /laptop/i],
    [/\bchair\b/i, /chair/i],
    [/\bmug\b/i, /mug/i],
  ];
  for (const [wordRe, objRe] of generic) {
    if (wordRe.test(actionText)) {
      const matches = world.scene.objects.filter(
        (o) => objRe.test(o.name) || objRe.test(o.id),
      );
      if (matches.length === 0) continue;
      if (possessive && actingActorId) {
        const actorLower = actingActorId.toLowerCase();
        const actor = world.actors.find((a) => a.id === actingActorId);
        const actorName = actor?.name.toLowerCase() ?? actorLower;
        const owned =
          matches.find((o) => o.id.toLowerCase().startsWith(`${actorLower}_`)) ??
          matches.find((o) => o.id.toLowerCase().includes(actorLower)) ??
          matches.find((o) => o.name.toLowerCase().startsWith(actorName));
        if (owned) return owned.id;
      }
      return matches[0]!.id;
    }
  }
  return undefined;
}

export type DeterministicSemantics = {
  /** Ground-truth quotes parsed from the action text (exact substrings). */
  quotedSpeech: string[];
  destinationActorId?: string;
  destinationObjectId?: string;
  /** First mentioned non-acting actor — the spoken-to candidate. */
  addresseeActorId?: string;
};

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
  let t = text;
  // Resuming a task is not relocating ("return/back to typing/work/...").
  t = t.replace(
    /\breturn\w*\s+to\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?[a-z]+ing\b/gi,
    " ",
  );
  t = t.replace(
    /\breturn\w*\s+to\s+(work|tasks?|focus|focusing|business|dut(y|ies))\b/gi,
    " ",
  );
  t = t.replace(
    /\b(?:go\w*|get\w*|come\w*|turn\w*)\s+back\s+to\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?[a-z]+ing\b/gi,
    " ",
  );
  t = t.replace(
    /\bback\s+to\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?[a-z]+ing\b/gi,
    " ",
  );
  t = t.replace(
    /\b(?:go\w*|get\w*|come\w*|turn\w*)\s+back\s+to\s+(work|tasks?|focus|business|dut(y|ies))\b/gi,
    " ",
  );
  t = t.replace(/\bback\s+to\s+(work|tasks?|focus|business|dut(y|ies))\b/gi, " ");
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
  /\b(head\s+(to|toward|towards|for|into|out|off|over|back|down|up|north|south|east|west|through|across|along)|headed|heading\s+(to|toward|towards|for|into|out|off|over|back))\b/i;

const PROXIMITY_RE =
  /\b(closer|close to|nearer|toward|towards|up to|next to|beside|behind|over to)\b/i;

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
  const destObj = resolveDestinationObjectId(world, action.text, action.actorId);
  if (destObj !== undefined) out.destinationObjectId = destObj;
  const mentioned = resolveMentionedActorId(world, action.actorId, action.text);
  if (mentioned !== undefined) out.addresseeActorId = mentioned;
  return out;
}
