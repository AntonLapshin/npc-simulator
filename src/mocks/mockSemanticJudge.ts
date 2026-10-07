// Deterministic mock SemanticJudge (offline / tests only).
//
// Movement/speech *flag* heuristics (verb lists, masking regexes) live only
// in this mock. Mention/destination *resolution* (which roster id the text
// names) is shared with the production deterministic grounding layer
// (engine/deterministicSemantics.ts) — the mock and the validator resolve
// names identically, so offline runs behave like grounded production runs.
// The production validation path never calls regex on raw text — it
// consumes the ActionSemantics produced here (mock runs) or by the LLM
// judge (real runs).
//
// Faithful paraphrase understanding ("saunter over", "go the extra mile")
// belongs to the LLM judge; the mock intentionally stays keyword-based.

import type { Action, ActionSemantics, World } from "../types.js";
import type { SemanticJudge } from "../intelligence/types.js";
import {
  parseActionQuotes,
  resolveDestinationActorId,
  resolveDestinationObjectId,
  resolveMentionedActorId,
} from "../engine/deterministicSemantics.js";

/** Double- and single-quoted segments (content length >= 2). Format parsing, not a verb ontology. */
function quotedSegments(text: string): string[] {
  return parseActionQuotes(text);
}

/**
 * Mock-only movement heuristic (kept in sync with nothing — the production
 * path does not use it). Mirrors the retired validator masks so offline
 * runs behave as before: body-part "head" masked, "return/back to
 * <activity>" masked, subordinate "as/while/when" clauses dropped.
 *
 * Exp-3 item 3: perception/cognition is NEVER locomotion. Clauses headed
 * by look/glance (any direction — "look up", "glance over notes"), asking,
 * sipping/drinking, reviewing, preparing, or typing are masked to clause
 * end before the movement-verb scan, so "Take a sip of coffee, reviewing
 * candidate notes" and "Ask Anton about backend experience" no longer
 * force pointless teleports or guaranteed fallbacks.
 */
function mockLooksLikeMovement(text: string): boolean {
  let t = text;
  t = t.replace(/\b(his|her|my|your|their|its|the|a|an)\s+heads?\b/gi, " ");
  t = maskNonLocomotion(t);
  t = t.replace(/\b(as|while|when)\b[^,.;]*/gi, " ");
  if (
    /\b(head\s+(to|toward|towards|for|into|out|off|over|back|down|up|north|south|east|west|through|across|along)|headed|heading\s+(to|toward|towards|for|into|out|off|over|back))\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(walk|walks|walking|go|goes|going|move|moves|moving|moved|run|runs|running|step|steps|stepping|come|comes|coming|came|approach|approaches|approaching|enter|enters|entering|leave|leaves|leaving|follow|follows|following|join|joins|joining|return|returns|returning|advance|advances|proceed|shift|slide|stroll|hurry|rush|rushing)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return /\b(closer|close to|nearer|toward|towards|up to|next to|beside|over to)\b/i.test(t);
}

/**
 * Exp-3 item 3: mask non-locomotion clauses (perception/cognition/resumed
 * activity) to clause end. Exported so the mask list is visible in one
 * place; the LLM judge prompt carries the equivalent rule in prose.
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
  // Perception/cognition verbs head non-locomotion clauses: looking or
  // glancing anywhere ("look up", "glance over notes"), asking, sipping,
  // reviewing, preparing, typing/thinking/waiting. Masked to clause end so
  // a later movement verb in the SAME clause is not misread either — the
  // mock stays keyword-based; nuanced mixed clauses belong to the LLM judge.
  t = t.replace(
    /\b(look|looks|looking|glance|glances|glancing|ask|asks|asked|asking|sip|sips|sipping|drink|drinks|drinking|drank|review|reviews|reviewing|prepare|prepares|preparing|type|types|typing|typed|think|thinks|thinking|wait|waits|waiting)\b[^,.;]*/gi,
    " ",
  );
  return t;
}

/** Mock-only speech-intent heuristic (keyword list lives ONLY in this mock). */
function mockLooksLikeSpeech(text: string): boolean {
  return /\b(say|says|said|speak|speaks|talk|talks|tell|tells|ask|asks|greet|greets|greeting|hello|hi\b|hey|introduce|speech|shout|whisper|reply|replies|answer|answers|exclaim|announce)\b/i.test(
    text,
  );
}

/** Mock-only name resolution by id/name substring (pronouns not resolved offline). */
function mockFindMentionedActorId(
  world: World,
  actingActorId: string,
  actionText: string,
): string | undefined {
  return resolveMentionedActorId(world, actingActorId, actionText);
}

/** Mock-only landmark resolution: object whose id or name appears in the text. */
function mockFindMentionedObjectId(
  world: World,
  actionText: string,
  actingActorId?: string,
): string | undefined {
  return resolveDestinationObjectId(world, actionText, actingActorId);
}

/** Mock-only physical-contact heuristic (handshake, hugs, handing things over). */
function mockFindContactActorId(
  world: World,
  actingActorId: string,
  actionText: string,
): string | undefined {
  if (
    !/\b(handshake|shake\s+.*hands?|shake\s+.*hand|hug|embrace|kiss|high[\s-]?five|fist[\s-]?bump|\bpat\b|slap|punch|handing|hands?\s+(him|her|them|over|.*coffee|.*cup)|give\s+.*(coffee|cup)|pass\s+.*(coffee|cup))\b/i.test(
      actionText,
    )
  ) {
    return undefined;
  }
  return mockFindMentionedActorId(world, actingActorId, actionText);
}

/** Synchronous mock classification shared by the judge and effect synthesis. */
export function mockClassifyAction(world: World, action: Action): ActionSemantics {
  let moves = mockLooksLikeMovement(action.text);
  const quotes = quotedSegments(action.text);
  const speaks = quotes.length > 0 || mockLooksLikeSpeech(action.text);
  // Destinations resolve only from movement-toward mentions (shared
  // deterministic resolution): a greeting addressee ("Thanks Tanya!"
  // while walking to a desk) is never a destination (exp-3 tick 6).
  let destinationActorId = moves
    ? resolveDestinationActorId(world, action.actorId, action.text)
    : undefined;
  // Exp-3 item 3: approaching/joining someone already adjacent is not
  // locomotion — no movement needed, no destination owed. (Mirrors the LLM
  // judge prompt rule; keeps ask/approach-when-adjacent turns in place.)
  if (moves && destinationActorId !== undefined) {
    const actor = world.actors.find((a) => a.id === action.actorId);
    const target = world.actors.find((a) => a.id === destinationActorId);
    if (
      actor &&
      target &&
      /\b(approach|approaches|approaching|come|comes|coming|came|join|joins|joining)\b/i.test(
        action.text,
      ) &&
      Math.hypot(actor.x - target.x, actor.y - target.y) <= 2.5
    ) {
      moves = false;
      destinationActorId = undefined;
    }
  }
  const destinationObjectId = moves
    ? mockFindMentionedObjectId(world, action.text, action.actorId)
    : undefined;
  const addresseeActorId = speaks
    ? mockFindMentionedActorId(world, action.actorId, action.text)
    : undefined;
  const contactActorId = mockFindContactActorId(world, action.actorId, action.text);
  return {
    moves,
    ...(destinationActorId !== undefined ? { destinationActorId } : {}),
    ...(destinationObjectId !== undefined ? { destinationObjectId } : {}),
    speaks,
    quotedSpeech: quotes,
    ...(addresseeActorId !== undefined ? { addresseeActorId } : {}),
    ...(contactActorId !== undefined ? { contactActorId } : {}),
  };
}

export class MockSemanticJudge implements SemanticJudge {
  async classify(world: World, action: Action): Promise<ActionSemantics> {
    return mockClassifyAction(world, action);
  }
}
