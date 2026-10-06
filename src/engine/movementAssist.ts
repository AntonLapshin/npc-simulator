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

function isFree(world: World, x: number, y: number): boolean {
  const p = { x, y };
  return isInsideScene(world.scene, p) && !isPointBlocked(world.scene, p);
}

/**
 * Find a reachable free position for `actorId` that satisfies the movement
 * gate: changed, reachable, and — when `destinationActorId` is given —
 * strictly closer to that actor than the current position.
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

  const oldDist = hasTarget
    ? Math.hypot(actor.x - target!.x, actor.y - target!.y)
    : 0;

  type Candidate = { x: number; y: number; score: number; distToTarget: number };
  const candidates: Candidate[] = [];

  for (let x = 0; x < world.scene.width; x++) {
    for (let y = 0; y < world.scene.height; y++) {
      if (x === actor.x && y === actor.y) continue;
      if (!isFree(world, x, y)) continue;
      if (hasTarget) {
        const d = Math.hypot(x - target!.x, y - target!.y);
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
  candidates.sort((a, b) => {
    const stackA = hasTarget && a.distToTarget < 0.5 ? 1 : 0;
    const stackB = hasTarget && b.distToTarget < 0.5 ? 1 : 0;
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
