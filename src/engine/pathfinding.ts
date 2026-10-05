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
  const open: Array<{ x: number; y: number; f: number; g: number }> = [
    { x: start.x, y: start.y, f: 0, g: 0 },
  ];
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[key(start.x, start.y), 0]]);
  const closed = new Set<string>();
  const h = (x: number, y: number) => Math.abs(x - goal.x) + Math.abs(y - goal.y);

  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i]!.f < open[best]!.f) best = i;
    }
    const current = open.splice(best, 1)[0]!;
    const currentKey = key(current.x, current.y);
    if (closed.has(currentKey)) continue;
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
