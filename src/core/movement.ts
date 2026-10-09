// Pure movement core: destination resolution, step computation, and
// engine-output invariants for actor locomotion.
//
// Phase 1 (renderer architecture): pure functions live in `src/core/` —
// deterministic, no I/O, no argument mutation, no randomness. The engine
// (`src/engine/movementExecutor.ts`) is the thin business-logic wrapper
// over this module: it decides WHEN to move (semantics) and applies the
// outcome to the world; everything about WHERE is computed here.
//
// Moved here (verbatim or refactored) from:
// - `src/engine/movementAssist.ts`: step computation (suggestMoveTarget,
//   clampMoveToCap, stepTowardPoint), the per-turn cap constants.
// - `src/engine/validate/movement.ts`: stationary-intent word-sense
//   predicates (interrogative questions / facing-only turns).
// - `src/engine/textHints.ts`: direction-hint extraction now lives in
//   `src/core/text.ts`.

import type { ActionSemantics, World } from "../types.js";
import { distanceToRect, isInsideScene, isPointBlocked } from "./geometry.js";
import { canMoveBetween, findPath } from "./pathfinding.js";
import type { DirectionHint } from "./text.js";

/**
 * Exp-3 item 4: per-turn displacement cap (half the default perception
 * radius of 12). Cross-room walks become multi-turn arcs instead of
 * instant jumps.
 */
export const MAX_STEP_DISTANCE = 6;

/**
 * Exp-3 item 4: minimum real progress for a named cross-room walk. When
 * starting more than PROGRESS_THRESHOLD cells from a named
 * landmark/actor, the turn must close at least half the distance or spend
 * the full step allowance — whichever is smaller.
 */
export const PROGRESS_THRESHOLD = 8;

export function requiredProgress(oldDist: number): number {
  if (oldDist <= PROGRESS_THRESHOLD) return 0;
  return Math.min(oldDist / 2, MAX_STEP_DISTANCE);
}

/**
 * F19: cap on step-candidate scans. The scan is already bounded to the
 * reachable box around the actor (≤ ~15×15 cells), so this is a backstop,
 * not the primary bound.
 */
export const MAX_SUGGEST_CANDIDATES = 500;

// ---------------------------------------------------------------------------
// Stationary-intent word sense (moved from validate/movement.ts).
//
// Two action shapes carry locomotion/pose-looking words without moving the
// body: interrogative questions ("where should I sit?") and facing
// constructions ("turn to/toward Dan", "face Ana"). Both exempt the turn
// from locomotion — the body stays in place.
// ---------------------------------------------------------------------------

/**
 * Unambiguous whole-body displacement verbs (true steps — proximity
 * phrases like "toward" are deliberately excluded because facing uses
 * them too).
 */
const STEP_VERBS_RE =
  /\b(walk|walks|walked|walking|go|goes|went|going|move|moves|moved|moving|run|runs|ran|running|step|steps|stepped|stepping|approach|approaches|approached|approaching|enter|enters|entered|entering|leave|leaves|left|leaving|come|comes|came|coming|follow|follows|followed|following|join|joins|joined|head|heads|headed|heading|return|returns|returned|returning|advance|advances|advancing|proceed|proceeds|proceeding|shift|shifts|shifting|slide|slides|sliding|stroll|strolls|strolling|hurry|hurries|hurrying|rush|rushes|rushing|rushed|saunter|saunters|sauntering|drift|drifts|drifting|sidle|sidles|sidling|dance|dances|dancing|slip|slips|slipping|slipped|teleport|teleports|teleporting)\b/i;

const INTERROGATIVE_RE = /\b(who|whom|whose|what|where|when|why|how|which)\b/i;

/**
 * True when the action text asks a question (a "?" plus an interrogative
 * word) and carries no genuine movement clause. "Walk to Ana and ask
 * where I should sit?" still moves — the walk clause wins; only pure
 * questions ("Ana, where should I sit?") are exempt.
 */
export function isInterrogativeQuestion(text: string): boolean {
  return text.includes("?") && INTERROGATIVE_RE.test(text) && !STEP_VERBS_RE.test(text);
}

const FACING_RE = /\bturn(?:s|ed|ing)?\s+(?:to|toward|towards)\b|\bface[sd]?\b/i;

/**
 * True for facing-only turns ("turn to Dan", "turns toward Ana", "face
 * the room"): a facing construction with no step/movement verb. "Turn to
 * Dan and walk over" keeps locomotion — the step verb wins. Word-boundary
 * anchored so "return to Dan" (no boundary before "turn") never matches.
 */
export function isFacingOnlyTurn(text: string): boolean {
  return FACING_RE.test(text) && !STEP_VERBS_RE.test(text);
}

/** Either non-locomotion word sense: interrogative question or pure facing. */
export function isNonLocomotionSense(text: string): boolean {
  return isInterrogativeQuestion(text) || isFacingOnlyTurn(text);
}

// ---------------------------------------------------------------------------
// Step computation.
// ---------------------------------------------------------------------------

function isFree(world: World, x: number, y: number): boolean {
  const p = { x, y };
  return isInsideScene(world.scene, p) && !isPointBlocked(world.scene, p);
}

/**
 * F10: cells occupied by another actor are never movement candidates —
 * two actors cannot share a cell.
 */
function occupiedCells(world: World, actorId: string): Set<string> {
  const out = new Set<string>();
  for (const a of world.actors) {
    if (a.id !== actorId) out.add(`${a.x},${a.y}`);
  }
  return out;
}

/** Unit vectors for direction-hint scoring (y grows southward). */
const HINT_VECTORS: Record<DirectionHint, { x: number; y: number }> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
};

/**
 * Find a reachable free cell for `actorId`: changed, within the per-turn
 * cap, and — when `target` is given — strictly closer to it than the
 * current position.
 *
 * This is the pure core of the old `suggestMoveTarget`: destination
 * resolution (ids/text → point) moved up to the caller (the engine
 * executor), so this function takes an already-resolved target point plus
 * an optional direction hint for undirected steps ("walk east" must not
 * step westward).
 *
 * Directed strategy: scan integer cells, keep free + reachable +
 * strictly-closer candidates, return the closest to the target (standing
 * NEXT to the target is preferred over stacking on it). Undirected:
 * nearest step, scored toward the direction hint.
 */
export function suggestStep(
  world: World,
  actorId: string,
  target: { x: number; y: number } | null,
  hint: DirectionHint | null,
): { x: number; y: number } | null {
  const actor = world.actors.find((a) => a.id === actorId);
  if (!actor) return null;
  const from = { x: actor.x, y: actor.y };
  const directed = target !== null;

  const distToTarget = (x: number, y: number): number =>
    directed
      ? Math.hypot(x - target!.x, y - target!.y)
      : Math.hypot(x - actor.x, y - actor.y);
  const oldDist = directed ? distToTarget(actor.x, actor.y) : 0;
  const hintVec = hint !== null ? HINT_VECTORS[hint] : null;

  type Candidate = {
    x: number;
    y: number;
    score: number;
    distToTarget: number;
    /** Dot product of the step with the direction hint (0 when no hint). */
    align: number;
  };
  const candidates: Candidate[] = [];
  const occupied = occupiedCells(world, actorId);

  // F19: scan only the reachable box around the actor — the
  // MAX_STEP_DISTANCE filter below rejects everything outside it anyway,
  // so this is behavior-identical and O(1) in scene size.
  const scanR = Math.ceil(MAX_STEP_DISTANCE) + 1;
  const x0 = Math.max(0, Math.floor(actor.x - scanR));
  const x1 = Math.min(world.scene.width - 1, Math.ceil(actor.x + scanR));
  const y0 = Math.max(0, Math.floor(actor.y - scanR));
  const y1 = Math.min(world.scene.height - 1, Math.ceil(actor.y + scanR));
  for (let x = x0; x <= x1 && candidates.length < MAX_SUGGEST_CANDIDATES; x++) {
    for (let y = y0; y <= y1 && candidates.length < MAX_SUGGEST_CANDIDATES; y++) {
      if (x === actor.x && y === actor.y) continue;
      if (occupied.has(`${x},${y}`)) continue; // F10: never stack
      if (!isFree(world, x, y)) continue;
      // Never a teleport — one step covers at most MAX_STEP_DISTANCE cells.
      if (Math.hypot(x - actor.x, y - actor.y) > MAX_STEP_DISTANCE + 1e-9) continue;
      if (directed) {
        const d = distToTarget(x, y);
        // Must be strictly closer (epsilon for int coords) — NEVER a step
        // that increases distance to a named destination.
        if (!(d < oldDist - 1e-9)) continue;
        candidates.push({ x, y, score: d, distToTarget: d, align: 0 });
      } else {
        const dFrom = Math.hypot(x - actor.x, y - actor.y);
        if (dFrom < 1e-9) continue;
        const align =
          hintVec !== null ? (x - actor.x) * hintVec.x + (y - actor.y) * hintVec.y : 0;
        candidates.push({ x, y, score: dFrom, distToTarget: dFrom, align });
      }
    }
  }

  // Closest-to-target first (directed); nearest-step first (undirected).
  // For directed moves, deprioritize stacking exactly on the target cell so
  // the actor stands NEXT to them instead.
  candidates.sort((a, b) => {
    const stackA = directed && a.distToTarget < 0.5 ? 1 : 0;
    const stackB = directed && b.distToTarget < 0.5 ? 1 : 0;
    if (stackA !== stackB) return stackA - stackB;
    // Hint alignment outranks distance for undirected moves.
    if (!directed && a.align !== b.align) return b.align - a.align;
    if (a.score !== b.score) return a.score - b.score;
    // Final tie-break toward the hint direction — replaces the accidental
    // x-ascending scan bias. No hint: keep insertion order.
    if (!directed && hintVec !== null) {
      const ta = a.x * hintVec.x + a.y * hintVec.y;
      const tb = b.x * hintVec.x + b.y * hintVec.y;
      if (ta !== tb) return tb - ta;
    }
    return 0;
  });

  for (const c of candidates) {
    if (canMoveBetween(world.scene, from, { x: c.x, y: c.y })) return { x: c.x, y: c.y };
  }
  return null;
}

/**
 * Exp-4 item 1: project a claimed (possibly over-cap) destination onto the
 * ≤6-cell reachable set around the actor: scale the actor→claimed vector
 * to MAX_STEP_DISTANCE, then snap to the nearest free + reachable cell
 * (never inside furniture, never outside bounds). Returns null when even
 * a capped step is impossible (fully blocked surroundings).
 *
 * Toolkit function: the Phase-1 executor always computes from scratch via
 * suggestStep, but the projection stays available for later phases.
 */
export function clampMoveToCap(
  world: World,
  actorId: string,
  claimedX: number,
  claimedY: number,
): { x: number; y: number } | null {
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
      if (occupied.has(`${x},${y}`)) continue; // F10: never stack
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

/**
 * Exp-4 item 5 (S2): scan the reachable box for a legal step strictly
 * TOWARD a target point; return the closest-to-target one. Returns null
 * when no such step exists (fully blocked / already adjacent). Toolkit
 * function for later phases.
 */
export function stepTowardPoint(
  world: World,
  actorId: string,
  tx: number,
  ty: number,
): { x: number; y: number } | null {
  const actor = world.actors.find((a) => a.id === actorId);
  if (!actor) return null;
  const from = { x: actor.x, y: actor.y };
  const oldD = Math.hypot(actor.x - tx, actor.y - ty);
  const occupied = occupiedCells(world, actorId);
  const scanR = Math.ceil(MAX_STEP_DISTANCE) + 1;
  const x0 = Math.max(0, Math.floor(actor.x - scanR));
  const x1 = Math.min(world.scene.width - 1, Math.ceil(actor.x + scanR));
  const y0 = Math.max(0, Math.floor(actor.y - scanR));
  const y1 = Math.min(world.scene.height - 1, Math.ceil(actor.y + scanR));
  let best: { x: number; y: number } | null = null;
  let bestD = oldD;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (x === actor.x && y === actor.y) continue;
      if (occupied.has(`${x},${y}`)) continue;
      if (!isFree(world, x, y)) continue;
      if (Math.hypot(x - actor.x, y - actor.y) > MAX_STEP_DISTANCE + 1e-9) continue;
      const d = Math.hypot(x - tx, y - ty);
      if (!(d < bestD - 1e-9)) continue;
      if (d < 0.5) continue;
      if (!canMoveBetween(world.scene, from, { x, y })) continue;
      best = { x, y };
      bestD = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Destination resolution + movement outcome.
// ---------------------------------------------------------------------------

/** A movement destination resolved to a concrete target point. */
export type MovementDestination = {
  kind: "actor" | "object";
  id: string;
  /** Concrete target point: the actor's position, or the object's center. */
  x: number;
  y: number;
};

type DestinationSemantics = Pick<
  ActionSemantics,
  "destinationActorId" | "destinationObjectId"
>;

/**
 * Pure destination resolution from action semantics + a world snapshot.
 * Actor destinations win over object destinations (a person is the
 * stronger steering signal); unknown ids and self-destinations resolve to
 * null (undirected movement). Never throws.
 */
export function resolveMovementDestination(
  world: World,
  actorId: string,
  semantics: DestinationSemantics,
): MovementDestination | null {
  if (semantics.destinationActorId !== undefined) {
    const target = world.actors.find((a) => a.id === semantics.destinationActorId);
    if (target !== undefined && target.id !== actorId) {
      return { kind: "actor", id: target.id, x: target.x, y: target.y };
    }
  }
  if (semantics.destinationObjectId !== undefined) {
    const obj = world.scene.objects.find((o) => o.id === semantics.destinationObjectId);
    if (obj !== undefined) {
      return { kind: "object", id: obj.id, x: obj.x + obj.w / 2, y: obj.y + obj.h / 2 };
    }
  }
  return null;
}

/** The engine-computed result of one actor's movement for a turn. */
export type MovementOutcome = {
  /** Where the actor started. */
  from: { x: number; y: number };
  /** Final cell the actor moves to. */
  x: number;
  y: number;
  /** Cell-center path from `from` to the final cell (A*). */
  path: { x: number; y: number }[];
  /** Resolved destination, when the action named one (null = undirected). */
  destination: MovementDestination | null;
};

/**
 * Compute one turn's engine-owned movement for `actorId`: resolve the
 * destination from semantics, step toward it (or take a hint-directed
 * undirected step), and return the final cell + path. Returns null when
 * the actor is unknown, no legal step exists, or the best step is the
 * current cell (already there / boxed in).
 */
export function computeMovementOutcome(
  world: World,
  actorId: string,
  semantics: DestinationSemantics,
  directionHint?: DirectionHint | null,
): MovementOutcome | null {
  const actor = world.actors.find((a) => a.id === actorId);
  if (!actor) return null;
  const destination = resolveMovementDestination(world, actorId, semantics);
  const step = suggestStep(
    world,
    actorId,
    destination !== null ? { x: destination.x, y: destination.y } : null,
    directionHint ?? null,
  );
  if (step === null) return null;
  if (step.x === actor.x && step.y === actor.y) return null;
  const from = { x: actor.x, y: actor.y };
  // Reachability was verified by suggestStep; a null path here is an
  // internal inconsistency, not a "no movement" signal.
  const path = findPath(world.scene, from, step);
  if (path === null) return null;
  return { from, x: step.x, y: step.y, path, destination };
}

/**
 * Engine-output invariants for a computed movement outcome (Phase 1:
 * the physicalValidator's movement checks on model output become these
 * assertions on engine output — kept as assertions, not retry triggers).
 * Returns the list of violations; empty means the outcome is clean.
 * Pure: reads the world, never mutates.
 */
export function assertMovementInvariants(
  world: World,
  actorId: string,
  outcome: MovementOutcome,
): string[] {
  const violations: string[] = [];
  const actor = world.actors.find((a) => a.id === actorId);
  if (!actor) return ["unknown actor"];
  const { x, y } = outcome;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return ["coordinates not finite"];
  }
  const to = { x, y };
  if (!isInsideScene(world.scene, to)) {
    violations.push(`out of bounds: (${x}, ${y}) outside ${world.scene.width}x${world.scene.height}`);
  } else {
    if (isPointBlocked(world.scene, to)) violations.push(`blocked position: (${x}, ${y}) inside a non-passable object`);
    const occupant = world.actors.find((a) => a.id !== actorId && a.x === x && a.y === y);
    if (occupant) violations.push(`actor collision: (${x}, ${y}) occupied by ${occupant.id}`);
  }
  const stepLen = Math.hypot(x - actor.x, y - actor.y);
  if (stepLen < 1e-9) {
    violations.push("no displacement: outcome equals the current position");
  } else {
    if (stepLen > MAX_STEP_DISTANCE + 1e-9) {
      violations.push(`over step cap: ${stepLen.toFixed(2)} cells > ${MAX_STEP_DISTANCE}`);
    }
    if (!canMoveBetween(world.scene, { x: actor.x, y: actor.y }, to)) {
      violations.push(`no path from (${actor.x}, ${actor.y}) to (${x}, ${y})`);
    }
  }
  if (outcome.destination !== null) {
    const t = { x: outcome.destination.x, y: outcome.destination.y };
    const oldDist = Math.hypot(actor.x - t.x, actor.y - t.y);
    const newDist = Math.hypot(x - t.x, y - t.y);
    if (!(newDist < oldDist - 1e-9)) {
      violations.push(
        `not closer to destination ${outcome.destination.id}: ${newDist.toFixed(2)} !< ${oldDist.toFixed(2)}`,
      );
    }
  }
  return violations;
}

function fmtCoord(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * Render an executed movement as a plain-language fact for the
 * consequence (render) input, e.g.
 * "Anton moved (2,3)→(5,6), now 1 cell from Tanya." Pure.
 */
export function describeMovement(
  world: World,
  actorId: string,
  outcome: MovementOutcome,
): string {
  const actor = world.actors.find((a) => a.id === actorId);
  const name = actor?.name ?? actorId;
  const base =
    `${name} moved (${fmtCoord(outcome.from.x)},${fmtCoord(outcome.from.y)})` +
    `→(${fmtCoord(outcome.x)},${fmtCoord(outcome.y)})`;
  const dest = outcome.destination;
  if (dest === null) return `${base}.`;
  let label: string | undefined;
  let dist: number | undefined;
  if (dest.kind === "actor") {
    const t = world.actors.find((a) => a.id === dest.id);
    if (t !== undefined) {
      label = t.name ?? t.id;
      dist = Math.hypot(outcome.x - t.x, outcome.y - t.y);
    }
  } else {
    const o = world.scene.objects.find((o) => o.id === dest.id);
    if (o !== undefined) {
      label = o.name;
      dist = distanceToRect(outcome.x, outcome.y, o);
    }
  }
  if (label === undefined || dist === undefined) return `${base}.`;
  const rounded = Math.round(dist);
  return `${base}, now ${rounded} cell${rounded === 1 ? "" : "s"} from ${label}.`;
}
