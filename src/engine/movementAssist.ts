import type { ValidationError, World } from "../types.js";
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

/**
 * F19: cap on movement-suggestion candidate scans. The scan is already
 * bounded to the reachable box around the actor (≤ ~15×15 cells), so this
 * is a backstop, not the primary bound.
 */
export const MAX_SUGGEST_CANDIDATES = 500;

function isFree(world: World, x: number, y: number): boolean {
  const p = { x, y };
  return isInsideScene(world.scene, p) && !isPointBlocked(world.scene, p);
}

/**
 * F10: cells occupied by another actor are not movement candidates — the
 * validator rejects destinations stacked on another actor, so suggesting
 * them would only burn a repair cycle.
 */
function occupiedCells(world: World, actorId: string): Set<string> {
  const out = new Set<string>();
  for (const a of world.actors) {
    if (a.id !== actorId) out.add(`${a.x},${a.y}`);
  }
  return out;
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
  const occupied = occupiedCells(world, actorId);

  // F19: scan only the reachable box around the actor instead of the full
  // scene — the MAX_STEP_DISTANCE filter below rejects everything outside
  // it anyway, so this is behavior-identical and O(1) in scene size.
  const scanR = Math.ceil(MAX_STEP_DISTANCE) + 1;
  const x0 = Math.max(0, Math.floor(actor.x - scanR));
  const x1 = Math.min(world.scene.width - 1, Math.ceil(actor.x + scanR));
  const y0 = Math.max(0, Math.floor(actor.y - scanR));
  const y1 = Math.min(world.scene.height - 1, Math.ceil(actor.y + scanR));
  for (let x = x0; x <= x1 && candidates.length < MAX_SUGGEST_CANDIDATES; x++) {
    for (let y = y0; y <= y1 && candidates.length < MAX_SUGGEST_CANDIDATES; y++) {
      if (x === actor.x && y === actor.y) continue;
      if (occupied.has(`${x},${y}`)) continue; // F10: never suggest stacking
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

/** F2: failure classification switches on stable error codes, not message prose. */
const MOVEMENT_ONLY_CODES = new Set([
  "movement.no_position_change",
  "movement.position_unchanged",
  "movement.not_closer_actor",
  "movement.not_closer_object",
  "movement.declared_without_patch",
  "movement.narrated_without_patch",
]);

/** True when every validation error looks like the movement gate. */
export function isMovementOnlyFailure(errors: ValidationError[]): boolean {
  if (errors.length === 0) return false;
  return errors.every((e) => MOVEMENT_ONLY_CODES.has(e.code));
}

const CLAMPABLE_CODES = new Set([
  ...MOVEMENT_ONLY_CODES,
  "movement.over_step_cap",
  "movement.no_progress_actor",
  "movement.no_progress_object",
]);

/**
 * Exp-4 item 1: is this failure clampable to a partial step? True when the
 * error set is movement-only (see above) plus optionally the per-turn
 * displacement cap ("at most 6 cells") and/or the real-progress rule
 * ("make real progress") — i.e. the model walked in the right direction
 * but too far (or barely at all). The repair projects the claimed target
 * onto the ≤6-cell reachable set instead of failing the turn whole, so a
 * 14-cell entrance→desk walk degrades to capped steps with the question
 * thread intact.
 */
export function isClampableMovementFailure(errors: ValidationError[]): boolean {
  if (errors.length === 0) return false;
  return errors.every((e) => CLAMPABLE_CODES.has(e.code));
}

/**
 * F24: does the error set include a "make real progress"/token-shuffle
 * failure? The in-loop deterministic repair extends to these (try
 * suggestMoveTarget, then clampMoveToCap) — previously they only got a
 * feedback hint.
 */
export function isRealProgressFailure(errors: ValidationError[]): boolean {
  if (errors.length === 0) return false;
  return errors.some(
    (e) => e.code === "movement.no_progress_actor" || e.code === "movement.no_progress_object",
  );
}

/**
 * Exp-4 item 1: project a claimed (possibly over-cap) destination onto the
 * ≤6-cell reachable set around the actor: scale the actor→claimed vector
 * to MAX_STEP_DISTANCE, then snap to the nearest free + reachable cell
 * (never inside furniture, never outside bounds). Returns null when even
 * a capped step is impossible (fully blocked surroundings).
 */
export function clampMoveToCap(
  world: World,
  actorId: string,
  claimedX: number,
  claimedY: number,
): MoveSuggestion | null {
  const actor = world.actors.find((a) => a.id === actorId);
  if (!actor) return null;
  if (!Number.isFinite(claimedX) || !Number.isFinite(claimedY)) return null;
  const dx = claimedX - actor.x;
  const dy = claimedY - actor.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const scale = Math.min(1, MAX_STEP_DISTANCE / len);
  const cx = actor.x + dx * scale;
  const cy = actor.y + dy * scale;
  type Candidate = { x: number; y: number; d: number };
  const candidates: Candidate[] = [];
  const occupied = occupiedCells(world, actorId);
  const radius = Math.ceil(MAX_STEP_DISTANCE) + 1;
  for (
    let x = Math.max(0, Math.floor(cx - radius));
    x <= Math.min(world.scene.width - 1, Math.ceil(cx + radius));
    x++
  ) {
    for (
      let y = Math.max(0, Math.floor(cy - radius));
      y <= Math.min(world.scene.height - 1, Math.ceil(cy + radius));
      y++
    ) {
      if (x === actor.x && y === actor.y) continue;
      if (occupied.has(`${x},${y}`)) continue; // F10: never suggest stacking
      if (!isFree(world, x, y)) continue;
      if (Math.hypot(x - actor.x, y - actor.y) > MAX_STEP_DISTANCE + 1e-9) continue;
      candidates.push({ x, y, d: Math.hypot(x - cx, y - cy) });
    }
  }
  candidates.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
  const from = { x: actor.x, y: actor.y };
  for (const c of candidates) {
    if (canMoveBetween(world.scene, from, { x: c.x, y: c.y })) return { x: c.x, y: c.y };
  }
  return null;
}
