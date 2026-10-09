// Unit tests for the pure pathfinding core (src/core/pathfinding.ts).
// Moved from src/engine/pathfinding.ts in Phase 1; behavior unchanged.
import { describe, expect, it } from "vitest";
import {
  canMoveBetween,
  findPath,
  isCellBlocked,
  toCell,
} from "../../../src/core/pathfinding.js";
import type { Scene } from "../../../src/types.js";
import { makeTinyWorld } from "../../helpers.js";

function emptyScene(width = 6, height = 6): Scene {
  return { width, height, objects: [] };
}

function walledScene(): Scene {
  // Vertical wall at x=3 splitting the 6x6 scene, no gap.
  return {
    width: 6,
    height: 6,
    objects: [
      {
        id: "wall", name: "Wall", description: "w",
        x: 3, y: 0, w: 1, h: 6,
        passable: false, blocksVision: false, blocksSound: false,
      },
    ],
  };
}

describe("toCell", () => {
  it("floors to integer cells", () => {
    expect(toCell({ x: 2.7, y: 3.2 })).toEqual({ x: 2, y: 3 });
  });
});

describe("isCellBlocked", () => {
  it("treats out-of-bounds cells as blocked", () => {
    const scene = emptyScene();
    expect(isCellBlocked(scene, -1, 0)).toBe(true);
    expect(isCellBlocked(scene, 6, 0)).toBe(true);
    expect(isCellBlocked(scene, 0, 0)).toBe(false);
  });

  it("detects cells inside non-passable objects", () => {
    const scene = walledScene();
    expect(isCellBlocked(scene, 3, 2)).toBe(true);
    expect(isCellBlocked(scene, 2, 2)).toBe(false);
  });
});

describe("findPath", () => {
  it("finds a path across an empty scene", () => {
    const path = findPath(emptyScene(), { x: 1, y: 1 }, { x: 4, y: 4 });
    expect(path).not.toBeNull();
    expect(path![0]).toEqual({ x: 1.5, y: 1.5 });
    expect(path![path!.length - 1]).toEqual({ x: 4.5, y: 4.5 });
    // 4-directional Manhattan path.
    expect(path!.length).toBe(7);
  });

  it("returns a single-point path for the same cell", () => {
    expect(findPath(emptyScene(), { x: 1, y: 1 }, { x: 1.2, y: 1.8 })).toEqual([
      { x: 1.5, y: 1.5 },
    ]);
  });

  it("returns null when no path exists", () => {
    expect(findPath(walledScene(), { x: 1, y: 1 }, { x: 4, y: 4 })).toBeNull();
  });

  it("returns null for out-of-bounds or blocked endpoints", () => {
    expect(findPath(emptyScene(), { x: 1, y: 1 }, { x: 99, y: 99 })).toBeNull();
    expect(findPath(walledScene(), { x: 1, y: 1 }, { x: 3, y: 2 })).toBeNull();
    // Start inside the wall.
    expect(findPath(walledScene(), { x: 3, y: 2 }, { x: 1, y: 1 })).toBeNull();
  });

  it("routes around a partial wall", () => {
    const scene: Scene = {
      width: 6,
      height: 6,
      objects: [
        {
          id: "wall", name: "Wall", description: "w",
          x: 3, y: 0, w: 1, h: 4, // gap at y=4,5
          passable: false, blocksVision: false, blocksSound: false,
        },
      ],
    };
    const path = findPath(scene, { x: 1, y: 1 }, { x: 4, y: 1 });
    expect(path).not.toBeNull();
    // Must dip to the gap rows.
    expect(path!.some((p) => p.y >= 4.5)).toBe(true);
  });
});

describe("canMoveBetween", () => {
  it("is true on an empty scene, false across a wall", () => {
    const world = makeTinyWorld();
    expect(canMoveBetween(world.scene, { x: 1, y: 1 }, { x: 4, y: 4 })).toBe(true);
    expect(canMoveBetween(walledScene(), { x: 1, y: 1 }, { x: 4, y: 4 })).toBe(false);
  });

  it("is false for out-of-bounds or blocked destinations", () => {
    expect(canMoveBetween(emptyScene(), { x: 1, y: 1 }, { x: 99, y: 99 })).toBe(false);
    expect(canMoveBetween(walledScene(), { x: 1, y: 1 }, { x: 3, y: 2 })).toBe(false);
  });
});
