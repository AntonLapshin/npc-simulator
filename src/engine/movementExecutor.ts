// Engine-owned movement (Phase 1 of the renderer architecture).
//
// The model never emits coordinates: the engine computes the acting
// actor's movement deterministically from action semantics, applies it to
// the acting actor only, and hands the executed movement to the
// consequence (render) call as facts to narrate. This module is the
// business-logic wrapper — sequencing, semantics, world reads — over the
// pure core in `src/core/movement.ts`, which owns every geometric
// decision (destination resolution, step computation, invariants).

import type {
  Action,
  ActionSemantics,
  World,
} from "../types.js";
import type { Intent } from "../decision/decisionTypes.js";
import { isFullyTypedIntent } from "../decision/decisionTypes.js";
import {
  assertMovementInvariants,
  computeMovementOutcome,
  describeMovement,
  hasContactVerb,
  isNonLocomotionSense,
  type MovementOutcome,
} from "../core/movement.js";
import { extractDirectionHint, hasDisplacementToken, maskQuotedSpans } from "../core/text.js";
import { resolveDeterministicSemantics, resolveMentionedActorId } from "./deterministicSemantics.js";

export type { MovementOutcome };

/**
 * Deterministic movement pre-pass: locomotion intent + destination from
 * the ACTION text alone (no model output, no judge). The turn computes
 * this before the first consequence call so the render input can carry
 * the executed movement as facts.
 */
export type PlannedMovement = Pick<
  ActionSemantics,
  "moves" | "destinationActorId" | "destinationObjectId" | "destinationObjectExplicit" | "contactActorId"
>;

export function planMovementSemantics(
  world: World,
  action: Action,
  intent?: Intent,
): PlannedMovement {
  // Phase 5: a fully-typed cascade intent (kind "move" + resolved
  // targetId from the Laya proposal engine) is authoritative — it
  // generated the action text, so the destination comes straight from
  // the intent with no text re-parsing (no translation layer). Any other
  // intent (or none) falls through to the text parsers as before.
  if (
    isFullyTypedIntent(intent) &&
    intent.kind === "move" &&
    intent.targetId !== undefined
  ) {
    const targetId = intent.targetId;
    const targetKind = intent.targetKind;
    if (targetKind === "actor" && targetId !== action.actorId) {
      return { moves: true, destinationActorId: targetId };
    }
    if (targetKind === "landmark" || targetKind === "object") {
      return {
        moves: true,
        destinationObjectId: targetId,
        destinationObjectExplicit: true,
      };
    }
    // Fully-typed move with targetKind "none" (wander): locomotion with
    // no destination — the step computation picks the greedy cell.
    return { moves: true };
  }
  // Stage-2 B4: quoted speech is the character talking, not the narrator
  // describing — "let's go" inside dialogue must not parse as locomotion
  // intent (Stage-2 tick-1 repro: Tanya moved on a quote). Intent AND
  // destination resolve on the quote-masked text. (quotedSpeech for the
  // speech executor is extracted from the raw text inside
  // resolveDeterministicSemantics callers that need it — here only the
  // destination fields are used.)
  const maskedText = maskQuotedSpans(action.text);
  const det = resolveDeterministicSemantics(world, { ...action, text: maskedText });
  const moves = hasDisplacementToken(maskedText) && !isNonLocomotionSense(maskedText);
  if (!moves) {
    // Contact approach: a handshake/hug turn with no walk verb still has
    // to close distance. Phase 4: the semantic judge no longer supplies
    // contactActorId, so detect the contact verb + named actor
    // deterministically.
    if (hasContactVerb(action.text)) {
      const contact = resolveMentionedActorId(world, action.actorId, action.text);
      if (contact !== undefined) return { moves: true, contactActorId: contact };
    }
    return { moves: false };
  }
  return {
    moves: true,
    ...(det.destinationActorId !== undefined
      ? { destinationActorId: det.destinationActorId }
      : {}),
    ...(det.destinationObjectId !== undefined
      ? {
          destinationObjectId: det.destinationObjectId,
          ...(det.destinationObjectExplicit !== undefined
            ? { destinationObjectExplicit: det.destinationObjectExplicit }
            : {}),
        }
      : {}),
  };
}

export type ExecutorDestination = { kind: "actor" | "object"; id: string } | null;

/**
 * The destination the executor will steer toward for these semantics:
 * an explicit actor destination first, then an object destination, then
 * the contact target (a handshake turn with no walk verb still has to
 * close distance). Null when the turn names no destination.
 */
export function executorDestination(
  semantics: Pick<
    ActionSemantics,
    "destinationActorId" | "destinationObjectId" | "contactActorId"
  >,
  actorId: string,
): ExecutorDestination {
  const contactId =
    semantics.contactActorId !== undefined && semantics.contactActorId !== actorId
      ? semantics.contactActorId
      : undefined;
  const destinationActorId = semantics.destinationActorId ?? contactId;
  if (destinationActorId !== undefined) return { kind: "actor", id: destinationActorId };
  if (semantics.destinationObjectId !== undefined) {
    return { kind: "object", id: semantics.destinationObjectId };
  }
  return null;
}

/**
 * Execute one turn's movement for the acting actor.
 *
 * Returns the computed `{x, y, path}` (+ origin and destination), or null
 * for stationary intents (typing/staring/sipping — no locomotion and no
 * contact), unknown actors, and worlds where no legal step exists
 * (already adjacent / boxed in). A core-invariant violation also yields
 * null — that is an engine bug, and the caller logs it loudly instead of
 * applying a corrupt step.
 *
 * Contact promotes to a movement destination when the action names no
 * other destination: a handshake turn without a walk verb still has to
 * close to adjacency (previously the model emitted the approach
 * coordinates itself).
 */
export function executeMovement(
  world: World,
  action: Action,
  semantics: Pick<
    ActionSemantics,
    "moves" | "destinationActorId" | "destinationObjectId" | "contactActorId"
  >,
): MovementOutcome | null {
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!actor) return null;
  const dest = executorDestination(semantics, action.actorId);
  // Stationary: no locomotion semantics and no contact target.
  if (!semantics.moves && dest === null) return null;
  const outcome = computeMovementOutcome(
    world,
    action.actorId,
    {
      ...(dest?.kind === "actor" ? { destinationActorId: dest.id } : {}),
      ...(dest?.kind === "object" ? { destinationObjectId: dest.id } : {}),
    },
    extractDirectionHint(action.text),
  );
  if (outcome === null) return null;
  // Engine-output invariants (Phase 1: the physicalValidator's movement
  // checks become these assertions, not retry triggers).
  if (assertMovementInvariants(world, action.actorId, outcome).length > 0) return null;
  return outcome;
}


/**
 * Fact lines describing the executed movement for the consequence
 * (render) input, so the render call narrates what actually happened:
 * "Anton moved (2,3)→(5,6), now 1 cell from Tanya."
 */
export function executedMovementFacts(
  world: World,
  actorId: string,
  outcome: MovementOutcome | null,
): string[] {
  const actor = world.actors.find((a) => a.id === actorId);
  const name = actor?.name ?? actorId;
  if (outcome === null) {
    return [
      `EXECUTED MOVEMENT: none — ${name} stays in place${actor !== undefined ? ` at (${actor.x}, ${actor.y})` : ""}.`,
      "Do NOT emit x/y coordinates for any actor: movement is executed by the engine, and any coordinates you emit are ignored.",
    ];
  }
  return [
    "EXECUTED MOVEMENT (the engine already moved the acting actor — narrate exactly this, do not invent coordinates):",
    describeMovement(world, actorId, outcome),
    "Do NOT emit x/y coordinates for any actor: movement is executed by the engine, and any coordinates you emit are ignored.",
  ];
}
