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
  ConsequenceResult,
  World,
} from "../types.js";
import {
  assertMovementInvariants,
  computeMovementOutcome,
  describeMovement,
  isNonLocomotionSense,
  type MovementOutcome,
} from "../core/movement.js";
import { extractDirectionHint, hasDisplacementToken } from "../core/text.js";
import { resolveDeterministicSemantics } from "./deterministicSemantics.js";

export type { MovementOutcome };

/**
 * Deterministic movement pre-pass: locomotion intent + destination from
 * the ACTION text alone (no model output, no judge). The turn computes
 * this before the first consequence call so the render input can carry
 * the executed movement as facts.
 */
export type PlannedMovement = Pick<
  ActionSemantics,
  "moves" | "destinationActorId" | "destinationObjectId" | "destinationObjectExplicit"
>;

export function planMovementSemantics(world: World, action: Action): PlannedMovement {
  const det = resolveDeterministicSemantics(world, action);
  const moves = hasDisplacementToken(action.text) && !isNonLocomotionSense(action.text);
  if (!moves) return { moves: false };
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
 * Merge engine-executed movement into a consequence result.
 *
 * Model-emitted coordinates are engine-owned now: x/y is stripped from
 * EVERY actor patch (the `onIgnored` hook lets the caller debug-log each
 * one — B6 shape: a patch "moving" the wrong actor simply loses its
 * coordinates), then the engine outcome is applied to the acting actor
 * only (adding a position-only patch when the consequence didn't patch
 * the actor at all).
 */
export function applyEngineMovement(
  result: ConsequenceResult,
  actorId: string,
  outcome: MovementOutcome | null,
  onIgnored?: (actorId: string, x: number | undefined, y: number | undefined) => void,
): ConsequenceResult {
  const merged: ConsequenceResult = structuredClone(result);
  for (const patch of merged.actorPatches) {
    if (patch.x !== undefined || patch.y !== undefined) {
      onIgnored?.(patch.actorId, patch.x, patch.y);
      delete patch.x;
      delete patch.y;
    }
  }
  if (outcome !== null) {
    const patch = merged.actorPatches.find((p) => p.actorId === actorId);
    if (patch !== undefined) {
      patch.x = outcome.x;
      patch.y = outcome.y;
    } else {
      merged.actorPatches.push({ actorId, x: outcome.x, y: outcome.y });
    }
  }
  return merged;
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
