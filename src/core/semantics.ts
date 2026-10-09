// PLAN_V2 Phase 2 (Laya as parser): pure helpers over a parsed
// ActionSemantics.
//
// The parse step produces one ActionSemantics per action sentence (one
// batched local Laya decide); the executors translate those parsed facts
// into their planning shapes. Everything here is pure: no world reads, no
// text parsing, no I/O — the world reads and the text parsing both stay in
// the engine wrappers (and on the deterministic fallback path).

import type { ActionSemantics } from "../types.js";

/**
 * The movement pre-pass shape built from parsed (never text-derived)
 * semantics. Mirrors the PlannedMovement pick in movementExecutor.
 */
export type ParsedMovementSemantics = Pick<
  ActionSemantics,
  | "moves"
  | "destinationActorId"
  | "destinationObjectId"
  | "destinationObjectExplicit"
  | "contactActorId"
>;

/**
 * Translate a Laya-parsed ActionSemantics into the movement pre-pass
 * shape. Passes every field through verbatim except a destination naming
 * the acting actor, which is dropped (meaningless — an actor cannot walk
 * to themselves; the executor's own guards apply downstream regardless).
 */
export function plannedMovementFromSemantics(
  semantics: ActionSemantics,
  actorId: string,
): ParsedMovementSemantics {
  const out: ParsedMovementSemantics = { moves: semantics.moves };
  if (
    semantics.destinationActorId !== undefined &&
    semantics.destinationActorId !== actorId
  ) {
    out.destinationActorId = semantics.destinationActorId;
  }
  if (semantics.destinationObjectId !== undefined) {
    out.destinationObjectId = semantics.destinationObjectId;
  }
  if (semantics.destinationObjectExplicit !== undefined) {
    out.destinationObjectExplicit = semantics.destinationObjectExplicit;
  }
  if (semantics.contactActorId !== undefined) {
    out.contactActorId = semantics.contactActorId;
  }
  return out;
}
