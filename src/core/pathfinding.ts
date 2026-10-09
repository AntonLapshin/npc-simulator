// Pure grid pathfinding for actor movement.
//
// Phase 1 (renderer architecture): pure functions live in `src/core/` —
// deterministic, no I/O, no argument mutation, no randomness. This module
// was moved verbatim from `src/engine/pathfinding.ts`; the old path
// remains as a re-export shim.

import type { Point, Scene } from "../types.js";
import { isInsideScene, isPointBlocked } from "./geometry.js";

// Movement validation uses an integer grid with cell size 1.
// Actors are points; non-passable object cells block movement.
// Pathfinding uses A* with 4-directional movement.

export function toCell(p: Point): Point {
  return { x: Math.floor(p.x), y: Math.floor(p.y) };
}

export function isCellBlocked(scene: Scene, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= scene.width || cy >= scene.height) return true;
  // A cell is blocked when its center point is inside a non-passable object.
  return isPointBlocked(scene, { x: cx + 0.5, y: cy + 0.5 });
}

/** F19: binary heap keyed by f-score. Lazy decrease-key: improved paths
 * re-push a node; stale pops are skipped via the gScore check. */
class BinaryHeap {
  private items: Array<{ x: number; y: number; f: number; g: number }> = [];

  get size(): number {
    return this.items.length;
  }

  push(node: { x: number; y: number; f: number; g: number }): void {
    const a = this.items;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.f <= a[i]!.f) break;
      const tmp = a[p]!;
      a[p] = a[i]!;
      a[i] = tmp;
      i = p;
    }
  }

  pop(): { x: number; y: number; f: number; g: number } | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (last !== undefined && a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.f < a[m]!.f) m = l;
        if (r < a.length && a[r]!.f < a[m]!.f) m = r;
        if (m === i) break;
        const tmp = a[m]!;
        a[m] = a[i]!;
        a[i] = tmp;
        i = m;
      }
    }
    return top;
  }
}

/** A* over integer cells, 4-directional. Returns cell-center path or null. */
export function findPath(scene: Scene, from: Point, to: Point): Point[] | null {
  const start = toCell(from);
  const goal = toCell(to);

  if (!isInsideScene(scene, from) || !isInsideScene(scene, to)) return null;
  if (isPointBlocked(scene, to)) return null;
  if (isCellBlocked(scene, start.x, start.y)) return null;
  if (isCellBlocked(scene, goal.x, goal.y)) return null;
  if (start.x === goal.x && start.y === goal.y) return [{ x: goal.x + 0.5, y: goal.y + 0.5 }];

  const key = (x: number, y: number) => `${x},${y}`;
  const open = new BinaryHeap();
  open.push({ x: start.x, y: start.y, f: 0, g: 0 });
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[key(start.x, start.y), 0]]);
  const closed = new Set<string>();
  const h = (x: number, y: number) => Math.abs(x - goal.x) + Math.abs(y - goal.y);

  while (open.size > 0) {
    const current = open.pop()!;
    const currentKey = key(current.x, current.y);
    if (closed.has(currentKey)) continue;
    // Skip stale re-pushes (a better g for this cell was found since).
    if (current.g > (gScore.get(currentKey) ?? Infinity)) continue;
    closed.add(currentKey);

    if (current.x === goal.x && current.y === goal.y) {
      const cells: Point[] = [];
      let k: string | undefined = currentKey;
      while (k !== undefined) {
        const [cx, cy] = k.split(",").map(Number);
        cells.push({ x: cx! + 0.5, y: cy! + 0.5 });
        k = cameFrom.get(k);
      }
      cells.reverse();
      return cells;
    }

    const neighbors = [
      [current.x + 1, current.y],
      [current.x - 1, current.y],
      [current.x, current.y + 1],
      [current.x, current.y - 1],
    ] as const;
    for (const [nx, ny] of neighbors) {
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      if (nx < 0 || ny < 0 || nx >= scene.width || ny >= scene.height) continue;
      if (isCellBlocked(scene, nx, ny)) continue;
      const tentativeG = current.g + 1;
      if (tentativeG < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, tentativeG);
        cameFrom.set(nk, currentKey);
        open.push({ x: nx, y: ny, g: tentativeG, f: tentativeG + h(nx, ny) });
      }
    }
  }
  return null;
}

export function canMoveBetween(scene: Scene, from: Point, to: Point): boolean {
  if (!isInsideScene(scene, to)) return false;
  if (isPointBlocked(scene, to)) return false;
  return findPath(scene, from, to) !== null;
}
