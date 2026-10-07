import type { World } from "../types.js";
import { isInsideScene, isPointBlocked } from "./geometry.js";
import { canMoveBetween } from "./pathfinding.js";

/**
 * Deterministic movement assistance for weak consequence LLMs.
 *
 * Small models (e.g. 3B-8B Ollama) often narrate movement correctly
 * ("Anton approaches Tanya") but omit the required x/y patch — even after
 * validation feedback tells them to include it. Retrying the same prompt 4
 * times then falls back to "Nothing changes.", stalling the turn.
 *
 * This helper computes a valid replacement position deterministically so the
 * orchestrator can either suggest exact coordinates in the retry feedback
 * or auto-repair an otherwise-valid consequence instead of falling back.
 */

export type MoveSuggestion = { x: number; y: number };

/**
 * Exp-3 item 4: per-turn displacement cap (half the default perception
 * radius of 12). A glance must not teleport 9-13 cells (ticks 8/20), and
 * cross-room walks become multi-turn arcs instead of instant jumps. The
 * validator rejects larger single-turn displacements; the suggestion helper
 * below only proposes within-cap steps.
 */
export const MAX_STEP_DISTANCE = 6;

/**
 * Exp-3 item 4: minimum real progress for a named cross-room walk. Mere
 * strictly-closer lets a 12-cell "walk to my desk" succeed with a 0.8-cell
 * shuffle (tick 15). When starting more than PROGRESS_THRESHOLD cells from
 * a named landmark/actor, the turn must close at least half the distance
 * or spend the full step allowance — whichever is smaller.
 */
export const PROGRESS_THRESHOLD = 8;

export function requiredProgress(oldDist: number): number {
  if (oldDist <= PROGRESS_THRESHOLD) return 0;
  return Math.min(oldDist / 2, MAX_STEP_DISTANCE);
}

function isFree(world: World, x: number, y: number): boolean {
  const p = { x, y };
  return isInsideScene(world.scene, p) && !isPointBlocked(world.scene, p);
}

/**
 * Find a reachable free position for `actorId` that satisfies the movement
 * gate: changed, reachable, and — when `destinationActorId` is given —
 * strictly closer to that actor than the current position (or, when
 * `destinationObjectId` is given, strictly closer to that object).
 *
 * Strategy: scan integer cells, keep free + reachable candidates, sort by
 * distance to the destination (or to the actor for undirected moves) and
 * return the best. Prefers standing NEXT to the target (distance >= 1)
 * over stacking on the exact same point.
 */
export function suggestMoveTarget(
  world: World,
  actorId: string,
  destinationActorId?: string,
  destinationObjectId?: string,
): MoveSuggestion | null {
  const actor = world.actors.find((a) => a.id === actorId);
  if (!actor) return null;
  const from = { x: actor.x, y: actor.y };

  const target =
    destinationActorId !== undefined
      ? world.actors.find((a) => a.id === destinationActorId)
      : undefined;
  // Unknown destination id: fall back to undirected movement.
  const hasTarget = target !== undefined && target.id !== actorId;

  const obj =
    !hasTarget && destinationObjectId !== undefined
      ? world.scene.objects.find((o) => o.id === destinationObjectId)
      : undefined;
  const objCx = obj !== undefined ? obj.x + obj.w / 2 : 0;
  const objCy = obj !== undefined ? obj.y + obj.h / 2 : 0;
  const hasObjectTarget = obj !== undefined;

  const distToTarget = (x: number, y: number): number => {
    if (hasTarget) return Math.hypot(x - target!.x, y - target!.y);
    if (hasObjectTarget) return Math.hypot(x - objCx, y - objCy);
    return Math.hypot(x - actor.x, y - actor.y);
  };
  const oldDist = hasTarget || hasObjectTarget ? distToTarget(actor.x, actor.y) : 0;

  type Candidate = { x: number; y: number; score: number; distToTarget: number };
  const candidates: Candidate[] = [];

  for (let x = 0; x < world.scene.width; x++) {
    for (let y = 0; y < world.scene.height; y++) {
      if (x === actor.x && y === actor.y) continue;
      if (!isFree(world, x, y)) continue;
      // Exp-3 item 4: never suggest a teleport — one step covers at most
      // MAX_STEP_DISTANCE cells.
      if (Math.hypot(x - actor.x, y - actor.y) > MAX_STEP_DISTANCE + 1e-9) continue;
      if (hasTarget || hasObjectTarget) {
        const d = distToTarget(x, y);
        // Must be strictly closer (with a small epsilon for int coords).
        if (!(d < oldDist - 1e-9)) continue;
        candidates.push({ x, y, score: d, distToTarget: d });
      } else {
        const dFrom = Math.hypot(x - actor.x, y - actor.y);
        if (dFrom < 1e-9) continue;
        candidates.push({ x, y, score: dFrom, distToTarget: dFrom });
      }
    }
  }

  // Closest-to-target first (directed); nearest-step first (undirected).
  // For directed moves, deprioritize stacking exactly on the target cell so
  // the actor stands NEXT to them instead.
  const hasDirectedTarget = hasTarget || hasObjectTarget;
  candidates.sort((a, b) => {
    const stackA = hasDirectedTarget && a.distToTarget < 0.5 ? 1 : 0;
    const stackB = hasDirectedTarget && b.distToTarget < 0.5 ? 1 : 0;
    if (stackA !== stackB) return stackA - stackB;
    return a.score - b.score;
  });

  for (const c of candidates) {
    const to = { x: c.x, y: c.y };
    if (canMoveBetween(world.scene, from, to)) return { x: c.x, y: c.y };
  }
  return null;
}

/** True when every validation error looks like the movement gate. */
export function isMovementOnlyFailure(errors: string[]): boolean {
  if (errors.length === 0) return false;
  return errors.every(
    (e) =>
      /no position change|position is unchanged|not closer|implies movement/i.test(
        e,
      ),
  );
}
