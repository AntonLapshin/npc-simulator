import { describe, expect, it } from "vitest";
import {
  distance,
  isInsideScene,
  isPointBlocked,
  pointInRect,
  rectsIntersect,
} from "../../src/engine/geometry.js";
import { canMoveBetween, findPath } from "../../src/engine/pathfinding.js";
import {
  canHearPoint,
  canSeePoint,
  getVisibleActors,
  getVisibleObjects,
} from "../../src/engine/perceptionHelpers.js";
import { makeTinyWorld } from "../helpers.js";
import { defaultConfig } from "../../src/config.js";

describe("geometry", () => {
  it("pointInRect uses half-open bounds", () => {
    expect(pointInRect({ x: 0, y: 0 }, { x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    expect(pointInRect({ x: 1, y: 0 }, { x: 0, y: 0, w: 1, h: 1 })).toBe(false);
  });

  it("rectsIntersect detects overlap", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, w: 1, h: 1 }, { x: 2, y: 2, w: 1, h: 1 })).toBe(false);
  });

  it("distance computes euclidean distance", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("isInsideScene enforces bounds", () => {
    const world = makeTinyWorld();
    expect(isInsideScene(world.scene, { x: 0, y: 0 })).toBe(true);
    expect(isInsideScene(world.scene, { x: 6, y: 6 })).toBe(false);
    expect(isInsideScene(world.scene, { x: -1, y: 0 })).toBe(false);
  });

  it("isPointBlocked detects non-passable objects only", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "a", name: "A", description: "d", x: 2, y: 2, w: 1, h: 1,
      passable: true, blocksVision: false, blocksSound: false,
    });
    expect(isPointBlocked(world.scene, { x: 2.5, y: 2.5 })).toBe(false);
    world.scene.objects[0]!.passable = false;
    expect(isPointBlocked(world.scene, { x: 2.5, y: 2.5 })).toBe(true);
  });
});

describe("pathfinding", () => {
  it("finds a path in open space", () => {
    const world = makeTinyWorld();
    expect(findPath(world.scene, { x: 1, y: 1 }, { x: 4, y: 4 })).not.toBeNull();
  });

  it("returns null when walled off", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "wall", name: "W", description: "d", x: 3, y: 0, w: 1, h: 6,
      passable: false, blocksVision: true, blocksSound: true,
    });
    expect(findPath(world.scene, { x: 1, y: 1 }, { x: 4, y: 4 })).toBeNull();
    expect(canMoveBetween(world.scene, { x: 1, y: 1 }, { x: 4, y: 4 })).toBe(false);
  });

  it("canMoveBetween rejects blocked destinations", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "rock", name: "R", description: "d", x: 2, y: 1, w: 1, h: 1,
      passable: false, blocksVision: false, blocksSound: false,
    });
    expect(canMoveBetween(world.scene, { x: 1, y: 1 }, { x: 2, y: 1 })).toBe(false);
  });
});

describe("perceptionHelpers", () => {
  it("sees nearby actors without blockers", () => {
    const world = makeTinyWorld();
    expect(getVisibleActors(world, "u").map((a) => a.id)).toContain("n");
  });

  it("vision blocked by walls", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "wall", name: "W", description: "d", x: 0, y: 2, w: 6, h: 1,
      passable: false, blocksVision: true, blocksSound: true,
    });
    expect(getVisibleActors(world, "u")).toHaveLength(0);
    expect(canSeePoint(world, { x: 1, y: 1 }, { x: 4, y: 4 })).toBe(false);
  });

  it("sound blocked only by blocksSound objects", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "glass", name: "G", description: "d", x: 0, y: 2, w: 6, h: 1,
      passable: false, blocksVision: true, blocksSound: false,
    });
    expect(canSeePoint(world, { x: 1, y: 1 }, { x: 4, y: 4 })).toBe(false);
    expect(canHearPoint(world, { x: 1, y: 1 }, { x: 4, y: 4 })).toBe(true);
  });

  it("respects perception radius", () => {
    const world = makeTinyWorld();
    // F7: radius now comes from the injected config, not a raw number.
    expect(
      canSeePoint(world, { x: 1, y: 1 }, { x: 4, y: 4 }, { ...defaultConfig, defaultPerceptionRadius: 1 }),
    ).toBe(false);
  });

  it("getVisibleObjects uses object centers", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "lamp", name: "Lamp", description: "A lamp.", x: 1, y: 2, w: 1, h: 1,
      passable: true, blocksVision: false, blocksSound: false,
    });
    expect(getVisibleObjects(world, "u").map((o) => o.id)).toContain("lamp");
  });
});
