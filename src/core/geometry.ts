// Pure geometric primitives for the simulation grid.
//
// Phase 1 (renderer architecture): pure functions live in `src/core/` —
// deterministic, no I/O, no argument mutation, no randomness. This module
// was moved verbatim from `src/engine/geometry.ts`; the old path remains
// as a re-export shim.

import type { Point, Rect, Scene, SceneObject } from "../types.js";

/** Half-open containment: [x, x+w) x [y, y+h). */
export function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.w &&
    point.y >= rect.y &&
    point.y < rect.y + rect.h
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w &&
    b.x < a.x + a.w &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h
  );
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/** Distance from a point to the closest point of an axis-aligned rect. */
export function distanceToRect(
  px: number,
  py: number,
  rect: { x: number; y: number; w: number; h: number },
): number {
  const cx = Math.min(Math.max(px, rect.x), rect.x + rect.w);
  const cy = Math.min(Math.max(py, rect.y), rect.y + rect.h);
  return Math.hypot(px - cx, py - cy);
}

export function isInsideScene(scene: Scene, point: Point): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < scene.width &&
    point.y < scene.height
  );
}

/** True when the point lies inside any non-passable object rectangle. */
export function isPointBlocked(scene: Scene, point: Point): boolean {
  for (const obj of scene.objects) {
    if (!obj.passable && pointInRect(point, obj)) return true;
  }
  return false;
}

/**
 * Test whether segment p1->p2 intersects an axis-aligned rectangle.
 * Uses parametric clipping (Liang-Barsky style) against the rect.
 */
export function segmentIntersectsRect(p1: Point, p2: Point, rect: Rect): boolean {
  if (pointInRect(p1, rect) || pointInRect(p2, rect)) return true;
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ];
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    if (segmentsIntersect(p1, p2, a, b)) return true;
  }
  return false;
}

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true;
  return false;
}

/** True when the segment is blocked by any object matching the predicate. */
export function isSegmentBlockedBy(
  from: Point,
  to: Point,
  objects: SceneObject[],
  predicate: (o: SceneObject) => boolean,
): boolean {
  for (const obj of objects) {
    if (!predicate(obj)) continue;
    if (segmentIntersectsRect(from, to, obj)) return true;
  }
  return false;
}
