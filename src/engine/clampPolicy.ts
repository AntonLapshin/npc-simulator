// PLAN_V2 Phase 3 — thin engine application of the clamp policy.
//
// Pure assembly over the pure core in `src/core/clamp.ts`: resolves the
// turn's planned semantics + executor outcomes into the attempted-vs-
// executed record. No mutation, no LLM, no retries — one pass, so a
// clamped turn costs exactly the same provider calls as a normal turn.

import type { Action, ActionSemantics, World } from "../types.js";
import { diagnoseManipulation } from "../core/objects.js";
import {
  clampContact,
  clampManipulation,
  clampMovement,
  type TurnClamp,
} from "../core/clamp.js";
import type { MovementOutcome } from "../core/movement.js";
import type { PlannedMovement } from "./movementExecutor.js";
import { buildManipulationSnapshot } from "./objects.js";

/**
 * Apply the clamp policy to one turn: compare what the parsed intent
 * attempted against what the engine executed, per channel (movement,
 * contact, manipulation). Returns null when every channel executed as
 * attempted — no honest gap for the narrate input to carry.
 *
 * The turn orchestrator applies this on every turn; there is no v1 anymore
 * this, so v1 outcomes stay byte-identical.
 */
export function buildTurnClamp(
  world: World,
  action: Action,
  plannedMovement: PlannedMovement,
  movementOutcome: MovementOutcome | null,
  exactQuote: string | null,
  parsedSemantics?: Pick<ActionSemantics, "contactActorId">,
): TurnClamp | null {
  const movement = clampMovement(world, action.actorId, {
    moves: plannedMovement.moves,
    ...(plannedMovement.destinationActorId !== undefined
      ? { destinationActorId: plannedMovement.destinationActorId }
      : {}),
    ...(plannedMovement.destinationObjectId !== undefined
      ? { destinationObjectId: plannedMovement.destinationObjectId }
      : {}),
    ...(plannedMovement.contactActorId !== undefined
      ? { contactActorId: plannedMovement.contactActorId }
      : {}),
    outcome: movementOutcome,
  });
  const contact = clampContact(world, action.actorId, action.text, {
    ...(plannedMovement.contactActorId !== undefined
      ? { targetActorId: plannedMovement.contactActorId }
      : {}),
    exactQuote,
    outcome: movementOutcome,
  });
  const diagnosis = diagnoseManipulation(
    buildManipulationSnapshot(world),
    action.actorId,
    action.text,
    parsedSemantics?.contactActorId,
  );
  const manipulation = clampManipulation(world, action.actorId, diagnosis);
  if (movement === null && contact === null && manipulation === null) return null;
  return { movement, contact, manipulation };
}
