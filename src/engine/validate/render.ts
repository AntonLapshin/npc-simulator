// Render-prose validation (Phase 4 of the renderer architecture).
//
// The render engine returns PROSE ONLY — there are no patches left to
// validate against. This module composes the prose validators (voice,
// pronouns, echo/placeholder, observer-discipline, quote containment,
// plus the engine-fact grounding gates: narrated movement/pose/
// manipulation must match what the engine executed). Pure: no engine
// dependencies, no LLM calls.

import type {
  Action,
  ConsequenceResult,
  ValidationError,
  World,
} from "../../types.js";
import type { ManipulationOutcome } from "../manipulationExecutor.js";
import type { PlannedPose } from "../../core/text.js";
import { maskQuotedSpans } from "../../core/text.js";
import { validateExactQuote, validateNarrativePlaceholder, validateSpeechCoverage } from "./speech.js";
import { buildRosterRetryLine } from "../../llm/rosterDiscipline.js";
import {
  findSupplementObserverSubject,
  stripAttributionPrefix,
  validateContactCoverage,
  validateNarratedContactAdjacency,
  validateEnterFreshness,
  validateIdentityConsistency,
  validateNarrativeActors,
  validateNarrativeDestinationGrounding,
  validateNarrativeMovementGrounding,
  validateNarrativePronouns,
  validateNarrativeVoice,
  validateObserverSubject,
  validateRelationshipLabel,
  validateThoughtGrounding,
} from "./narrative.js";
import {
  validateExplanationCoverage,
  validateManipulationGrounding,
  validateObjectGrounding,
} from "./objects.js";

/**
 * The engine-executed facts the render prose is grounded against. The
 * render call narrates exactly these — narrative invention beyond them
 * is a voice violation.
 */
export type RenderFacts = {
  /** Engine-dictated exact quote (null = the action carries no quoted speech). */
  exactQuote: string | null;
  /** Did the engine move the acting actor this turn? */
  moved: boolean;
  /**
   * Stage-1 A4: the engine movement's destination actor id (null when the
   * engine did not move toward a roster actor — undirected moves and
   * object destinations are out of scope for destination grounding).
   */
  destinationActorId: string | null;
  /** Engine-executed pose change (null = pose unchanged). */
  pose: PlannedPose | null;
  /** Effective pose after the engine plan (for the sitting gate). */
  effectivePose: string;
  /** Post-movement position (for the pour-too-far gate). */
  x: number;
  y: number;
  /** Engine-executed manipulation (null = none executed). */
  engineManipulation: ManipulationOutcome | null;
};

/**
 * Validate one render result's prose against the engine-executed facts.
 * All checks are prose-vs-facts: voice, pronouns, echo/placeholder,
 * observer-discipline, quote containment, and grounding (movement, pose,
 * manipulation, sitting, pouring, thoughts, explanation topic).
 */
export function validateRenderProse(
  world: World,
  action: Action,
  render: Pick<ConsequenceResult, "narrative" | "thoughts" | "reasoning">,
  facts: RenderFacts,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const { narrative, thoughts } = render;
  const actor = world.actors.find((a) => a.id === action.actorId);
  const actorName = actor?.name ?? action.actorId;

  // Echo / placeholder.
  errors.push(...validateNarrativePlaceholder(narrative, action));
  // Quote containment — the engine-dictated exact quote, verbatim.
  errors.push(...validateExactQuote(facts.exactQuote, narrative));
  // Unknown actors in prose.
  errors.push(...validateNarrativeActors(world, { narrative }));
  // Voice: third person, always.
  errors.push(...validateNarrativeVoice(narrative, actorName));
  // Pronoun discipline (opt-in via actor.pronouns).
  errors.push(...validateNarrativePronouns(world, narrative, action));
  // Identity theft / alienation labels.
  errors.push(...validateIdentityConsistency(world, narrative, action));
  errors.push(...validateRelationshipLabel(world, narrative, action));
  // Observer discipline: the narrative describes ONLY the acting actor.
  const stripped = stripAttributionPrefix(narrative, actorName, action.actorId);
  errors.push(...validateObserverSubject(world, { narrative: stripped }, action));
  errors.push(...findSupplementObserverSubject(world, stripped, action));
  // Stale "enters the office" prose.
  errors.push(...validateEnterFreshness(world, narrative, action));
  // Grounding against the engine-executed facts: narrated locomotion
  // requires an engine move; narrated pose changes require the engine
  // pose; explicit-stay actions never move. Quoted speech is masked —
  // dialogue ("I'm going to get my laptop") is the character talking,
  // not the narrator describing movement/manipulation.
  const unquoted = maskQuotedSpans(stripped);
  errors.push(
    ...validateNarrativeMovementGrounding(world, action, unquoted, facts.moved, facts.pose),
  );
  // Stage-1 A4: narrated locomotion aimed at the wrong actor contradicts
  // the engine destination (turn-1 repro: engine moved toward Tanya, the
  // 3B narrated "walks toward Dana").
  errors.push(
    ...validateNarrativeDestinationGrounding(world, action, unquoted, facts.destinationActorId),
  );
  // Phantom manipulation: prose describing a transfer the engine did not
  // execute is fiction.
  errors.push(
    ...validateManipulationGrounding(world, action, { narrative: unquoted }, facts.engineManipulation),
  );
  // Sitting / pouring grounding.
  errors.push(
    ...validateObjectGrounding(world, action, unquoted, facts.effectivePose, facts.x, facts.y),
  );
  // Thoughts: no invented people, no ungrounded past claims.
  errors.push(...validateThoughtGrounding(world, action, action.actorId, thoughts));
  // Speech coverage: questions and utterances must survive rendering.
  // (Runs on the quote-intact narrative — quoted dialogue IS rendered
  // speech.)
  errors.push(...validateSpeechCoverage(action, stripped));
  // Contact coverage: a described handshake/hug must be narrated, and a
  // narrated one must be physically possible at the post-move position.
  errors.push(...validateContactCoverage(world, action, unquoted));
  errors.push(...validateNarratedContactAdjacency(world, action, unquoted, facts.x, facts.y));
  // Explanation actions must keep the topic.
  errors.push(...validateExplanationCoverage(action, { narrative }));

  return errors;
}

/**
 * Deterministic one-line retry directive for a rejected render: the most
 * severe error first (the list is already ordered by gate severity —
 * structural prose violations before wording nits), message clipped.
 * Pure.
 */
export function renderRetryFeedback(
  errors: ValidationError[],
  actorIds: string[] = [],
): string {
  if (errors.length === 0) {
    return "Previous render was rejected with no details — re-emit the narrative grounded in the executed facts. Return corrected JSON only.";
  }
  const top = errors[0]!;
  const oneLine = top.message.replace(/\s+/g, " ").trim().slice(0, 220);
  // Unknown-actor failures get the roster repeated (retrieval beats recall).
  const rosterLine =
    errors.some((e) => e.code === "narrative.unknown_actor")
      ? `\n${buildRosterRetryLine(actorIds)}`
      : "";
  return (
    `Previous render was rejected: [${top.code}] ${oneLine} ` +
    `Narrate ONLY the executed facts (movement, quote, manipulation, pose) — no invention. ` +
    `Return corrected JSON only.` +
    rosterLine
  );
}
