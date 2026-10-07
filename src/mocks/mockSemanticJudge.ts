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
// belongs to the LLM judge; the mock intentionally stays keyword-based,
// with ONE deliberate exception: a small hand-maintained idiom map (F16)
// for the most common movement/speech idioms the keyword lists miss
// ("heads over", "makes her way", "sidles up" → movement; "mutters",
// "whispers", "calls out" → speech). This keeps offline/test runs from
// diverging on everyday phrasing, but anything subtler still belongs to
// the LLM judge — the mock is not a paraphrase engine.

import type { Action, ActionSemantics, World } from "../types.js";
import type { SemanticJudge } from "../intelligence/types.js";
import {
  hasDisplacementToken,
  hasSpeechToken,
  maskNonLocomotion as canonicalMaskNonLocomotion,
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
 * F16: mock-only common-idiom map. The canonical keyword lists
 * (engine/deterministicSemantics.ts) miss everyday idioms the production
 * LLM judge handles natively: "heads over" (HEAD_TO_RE only covers bare
 * "head"), "makes his/her way" (no displacement verb at all), "sidles up".
 * A couple are already covered by the verb lists ("sidles" is a
 * displacement verb) — they are listed anyway so the idiom coverage is
 * explicit in one place rather than accidental.
 */
const IDIOM_MOVEMENT_RES: RegExp[] = [
  /\bheads?\s+over\b/i,
  /\bmakes?\s+(his|her|their|its)\s+way\b/i,
  /\bsidles?\s+up\b/i,
];

/**
 * F16: mock-only speech-idiom map. "whispers"/"calls out" overlap the
 * canonical speech-verb list (listed for explicitness); "mutters" and
 * "whispering" are genuinely missing there.
 */
const IDIOM_SPEECH_RES: RegExp[] = [
  /\bmutter(s|ed|ing)?\b/i,
  /\bwhisper(s|ed|ing)?\b/i,
  /\bcalls?\s+out\b/i,
];

function matchesAny(text: string, res: RegExp[]): boolean {
  return res.some((re) => re.test(text));
}

/**
 * Mock-only movement heuristic: the canonical displacement-token check
 * (engine/deterministicSemantics.ts) — body-part "head" masked,
 * non-locomotion clauses masked, subordinate someone-else clauses dropped.
 * Phase 2 moved the logic to the shared module so the mock and the
 * production moves-grounding classify identically.
 *
 * F16: plus the idiom map above — the ONE intentional divergence from the
 * production grounding, documented in the file header.
 */
function mockLooksLikeMovement(text: string): boolean {
  if (hasDisplacementToken(text)) return true;
  // Body-part "head" is not locomotion ("shakes his head over the
  // report") — same masking as the canonical check, applied to the raw
  // text before idiom matching.
  const deheaded = text.replace(/\b(his|her|my|your|their|its|the|a|an)\s+heads?\b/gi, " ");
  return matchesAny(deheaded, IDIOM_MOVEMENT_RES);
}

/**
 * Exp-3 item 3: mask non-locomotion clauses (perception/cognition/resumed
 * activity) to clause end. Re-exported from the canonical module so the
 * mask list lives in exactly one place; the LLM judge prompt carries the
 * equivalent rule in prose.
 */
export const maskNonLocomotion = canonicalMaskNonLocomotion;

/**
 * Mock-only speech-intent heuristic. Delegates to the canonical
 * speech-token check (engine/deterministicSemantics.ts) so the mock and
 * the production speaks-grounding classify identically — including
 * unquoted explaining/describing/nodding/thanking (Exp-4 item 3, tick 14).
 * F16: plus the speech-idiom map (see IDIOM_SPEECH_RES).
 */
function mockLooksLikeSpeech(text: string): boolean {
  return hasSpeechToken(text) || matchesAny(text, IDIOM_SPEECH_RES);
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
