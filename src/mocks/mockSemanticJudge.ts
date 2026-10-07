// Deterministic mock SemanticJudge (offline / tests only).
//
// This is the ONLY place in src/ where keyword heuristics survive: simple
// verb lists + masking regexes approximate "what did this sentence mean?"
// without any network call. The production validation path never calls
// regex on raw text — it consumes the ActionSemantics produced here (mock
// runs) or by the LLM judge (real runs).
//
// Faithful paraphrase understanding ("saunter over", "go the extra mile")
// belongs to the LLM judge; the mock intentionally stays keyword-based.

import type { Action, ActionSemantics, World } from "../types.js";
import type { SemanticJudge } from "../intelligence/types.js";

/** Double- and single-quoted segments (content length >= 2). Format parsing, not a verb ontology. */
function quotedSegments(text: string): string[] {
  const out: string[] = [];
  const doubleRe = /"([^"]{2,})"/g;
  let m: RegExpExecArray | null;
  while ((m = doubleRe.exec(text)) !== null) out.push(m[1]!);
  // Single quotes: avoid matching apostrophes inside words (don't, I'm).
  const singleRe = /(^|[\s(\[{])'([^']{4,})'/g;
  while ((m = singleRe.exec(text)) !== null) out.push(m[2]!);
  return out;
}

/**
 * Mock-only movement heuristic (kept in sync with nothing — the production
 * path does not use it). Mirrors the retired validator masks so offline
 * runs behave as before: body-part "head" masked, "return/back to
 * <activity>" masked, subordinate "as/while/when" clauses dropped.
 */
function mockLooksLikeMovement(text: string): boolean {
  let t = text;
  t = t.replace(/\b(his|her|my|your|their|its|the|a|an)\s+heads?\b/gi, " ");
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
  const lowered = actionText.toLowerCase();
  for (const a of world.actors) {
    if (a.id === actingActorId) continue;
    if (a.id.toLowerCase().length >= 2 && lowered.includes(a.id.toLowerCase())) return a.id;
    if (a.name.toLowerCase().length >= 2 && lowered.includes(a.name.toLowerCase())) return a.id;
  }
  return undefined;
}

/** Mock-only landmark resolution: object whose id or name appears in the text. */
function mockFindMentionedObjectId(
  world: World,
  actionText: string,
  actingActorId?: string,
): string | undefined {
  const lowered = actionText.toLowerCase();
  for (const o of world.scene.objects) {
    if (o.id.toLowerCase().length >= 3 && lowered.includes(o.id.toLowerCase())) return o.id;
    if (o.name.toLowerCase().length >= 3 && lowered.includes(o.name.toLowerCase())) return o.id;
  }
  // Generic landmark words map to the first matching object — except with a
  // possessive ("my desk", "my own chair"), which resolves to the acting
  // actor's own object first (anton_desk for anton's "my desk"). Without
  // this, "my desk" silently binds to someone else's desk and the
  // closer-to-target gate then enforces the WRONG destination (exp-2 §6).
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
  const moves = mockLooksLikeMovement(action.text);
  const quotes = quotedSegments(action.text);
  const speaks = quotes.length > 0 || mockLooksLikeSpeech(action.text);
  const destinationActorId = moves
    ? mockFindMentionedActorId(world, action.actorId, action.text)
    : undefined;
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
