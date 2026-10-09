// Exhaustive unit tests for the pure movement core (src/core/movement.ts).
// Phase 1 mandate: every core module gets a unit test file aiming at 100%
// line + branch coverage (no coverage tool installed — branches are
// enumerated deliberately below).
import { describe, expect, it } from "vitest";
import {
  assertMovementInvariants,
  clampMoveToCap,
  computeMovementOutcome,
  describeMovement,
  hasContactVerb,
  isFacingOnlyTurn,
  isInterrogativeQuestion,
  isNonLocomotionSense,
  MAX_STEP_DISTANCE,
  MAX_SUGGEST_CANDIDATES,
  PROGRESS_THRESHOLD,
  requiredProgress,
  resolveMovementDestination,
  stepTowardPoint,
  suggestStep,
} from "../../../src/core/movement.js";
import { loadScenario } from "../../../src/engine/scenarioLoader.js";
import type { World } from "../../../src/types.js";
import { makeTinyWorld } from "../../helpers.js";

/** 6x6 empty room, u at (1,1), n at (4,4) — from tests/helpers.ts. */
function tiny(): World {
  return makeTinyWorld();
}

/** u boxed in by non-passable 1x1 objects on all four sides. */
function boxedWorld(): World {
  const world = tiny();
  const walls = [
    { id: "w1", x: 0, y: 1 },
    { id: "w2", x: 2, y: 1 },
    { id: "w3", x: 1, y: 0 },
    { id: "w4", x: 1, y: 2 },
  ];
  for (const w of walls) {
    world.scene.objects.push({
      id: w.id,
      name: w.id,
      description: "wall",
      x: w.x,
      y: w.y,
      w: 1,
      h: 1,
      passable: false,
      blocksVision: false,
      blocksSound: false,
    });
  }
  return world;
}

function bigWorld(): World {
  return loadScenario({
    version: 1,
    id: "big",
    title: "Big",
    narrative: "A big room.",
    userActorId: "u",
    order: ["u", "n"],
    scene: { width: 30, height: 30, objects: [] },
    actors: [
      {
        id: "u", name: "U", persona: "p", x: 1, y: 1,
        state: "s", emotion: "e", goal: "g", thoughts: "t",
        memories: [], beliefs: [], relationships: [],
      },
      {
        id: "n", name: "N", persona: "p", x: 25, y: 25,
        state: "s", emotion: "e", goal: "g", thoughts: "t",
        memories: [], beliefs: [], relationships: [],
      },
    ],
  });
}

describe("movement constants", () => {
  it("exports the per-turn cap, progress threshold, and candidate cap", () => {
    expect(MAX_STEP_DISTANCE).toBe(6);
    expect(PROGRESS_THRESHOLD).toBe(8);
    expect(MAX_SUGGEST_CANDIDATES).toBe(500);
  });
});

describe("requiredProgress", () => {
  it("demands nothing within the threshold", () => {
    expect(requiredProgress(0)).toBe(0);
    expect(requiredProgress(8)).toBe(0);
    expect(requiredProgress(7.9)).toBe(0);
  });

  it("demands half the distance beyond the threshold, capped at the step cap", () => {
    expect(requiredProgress(10)).toBe(5);
    expect(requiredProgress(12)).toBe(6);
    expect(requiredProgress(100)).toBe(6);
  });
});

describe("isInterrogativeQuestion", () => {
  it("detects pure questions", () => {
    expect(isInterrogativeQuestion("Ana, where should I sit?")).toBe(true);
    expect(isInterrogativeQuestion("What time is it?")).toBe(true);
  });

  it("lets a movement clause win over a question clause", () => {
    expect(isInterrogativeQuestion("Walk to Ana and ask where I should sit?")).toBe(false);
  });

  it("requires both a question mark and an interrogative word", () => {
    expect(isInterrogativeQuestion("Hello everyone.")).toBe(false);
    expect(isInterrogativeQuestion("Really?")).toBe(false);
    expect(isInterrogativeQuestion("Where is the coffee machine")).toBe(false);
  });
});

describe("isFacingOnlyTurn", () => {
  it("detects facing constructions", () => {
    expect(isFacingOnlyTurn("turn to Dan")).toBe(true);
    expect(isFacingOnlyTurn("Turns toward Ana")).toBe(true);
    expect(isFacingOnlyTurn("face the room")).toBe(true);
    expect(isFacingOnlyTurn("faced the window")).toBe(true);
  });

  it("lets a step verb win", () => {
    expect(isFacingOnlyTurn("Turn to Dan and walk over")).toBe(false);
  });

  it("does not match 'return to Dan' (word boundary before turn)", () => {
    expect(isFacingOnlyTurn("return to Dan")).toBe(false);
    expect(isFacingOnlyTurn("I walk to Dan")).toBe(false);
  });
});

describe("isNonLocomotionSense", () => {
  it("is the OR of the two senses", () => {
    expect(isNonLocomotionSense("Ana, where should I sit?")).toBe(true);
    expect(isNonLocomotionSense("turn to Dan")).toBe(true);
    expect(isNonLocomotionSense("Walk toward Tanya.")).toBe(false);
  });
});

describe("hasContactVerb (Phase 4: deterministic contact approach)", () => {
  it("detects contact verbs", () => {
    expect(hasContactVerb("Shake Bea's hand.")).toBe(true);
    expect(hasContactVerb("Give Bea a handshake.")).toBe(true);
    expect(hasContactVerb("Hug Tanya.")).toBe(true);
    expect(hasContactVerb("High-five Dan!")).toBe(true);
    expect(hasContactVerb("Pat him on the back.")).toBe(true);
  });

  it("ignores non-contact actions", () => {
    expect(hasContactVerb("Walk toward Bea.")).toBe(false);
    expect(hasContactVerb("Shake the bottle and hand it over.")).toBe(false);
    expect(hasContactVerb("Wave at Bea.")).toBe(false);
  });
});

describe("suggestStep", () => {
  it("returns null for an unknown actor", () => {
    expect(suggestStep(tiny(), "ghost", { x: 4, y: 4 }, null)).toBeNull();
  });

  it("steps strictly closer to a directed target", () => {
    const world = tiny();
    const s = suggestStep(world, "u", { x: 4, y: 4 }, null);
    expect(s).not.toBeNull();
    const oldDist = Math.hypot(1 - 4, 1 - 4);
    expect(Math.hypot(s!.x - 4, s!.y - 4)).toBeLessThan(oldDist);
    // Never the current cell, never stacked on the other actor.
    expect([s!.x, s!.y]).not.toEqual([1, 1]);
    expect([s!.x, s!.y]).not.toEqual([4, 4]);
    expect(Math.hypot(s!.x - 1, s!.y - 1)).toBeLessThanOrEqual(MAX_STEP_DISTANCE + 1e-9);
  });

  it("returns null when the target is the actor's own cell (nothing strictly closer)", () => {
    expect(suggestStep(tiny(), "u", { x: 1, y: 1 }, null)).toBeNull();
  });

  it("returns null when boxed in (no reachable candidate)", () => {
    expect(suggestStep(boxedWorld(), "u", { x: 4, y: 4 }, null)).toBeNull();
    expect(suggestStep(boxedWorld(), "u", null, null)).toBeNull();
  });

  it("caps directed steps at MAX_STEP_DISTANCE", () => {
    const world = bigWorld();
    const s = suggestStep(world, "u", { x: 25, y: 25 }, null);
    expect(s).not.toBeNull();
    expect(Math.hypot(s!.x - 1, s!.y - 1)).toBeLessThanOrEqual(MAX_STEP_DISTANCE + 1e-9);
    expect(Math.hypot(s!.x - 25, s!.y - 25)).toBeLessThan(Math.hypot(1 - 25, 1 - 25));
  });

  it("steers undirected steps toward the direction hint", () => {
    const east = suggestStep(tiny(), "u", null, "east");
    expect(east).not.toBeNull();
    expect(east!.x).toBeGreaterThan(1); // eastward, not the old westward drift
    const north = suggestStep(tiny(), "u", null, "north");
    expect(north).not.toBeNull();
    expect(north!.y).toBeLessThan(1);
  });

  it("takes a nearest step when undirected with no hint", () => {
    const s = suggestStep(tiny(), "u", null, null);
    expect(s).not.toBeNull();
    expect(Math.hypot(s!.x - 1, s!.y - 1)).toBe(1);
  });

  it("never steps into a non-passable object", () => {
    const world = tiny();
    world.scene.objects.push({
      id: "desk", name: "Desk", description: "d",
      x: 2, y: 0, w: 2, h: 3,
      passable: false, blocksVision: false, blocksSound: false,
    });
    const s = suggestStep(world, "u", { x: 4, y: 4 }, null);
    expect(s).not.toBeNull();
    // (2,1) is inside the desk rect — must not be suggested.
    expect([s!.x, s!.y]).not.toEqual([2, 1]);
  });
});

describe("clampMoveToCap", () => {
  it("returns null for unknown actors, non-finite claims, and zero vectors", () => {
    const world = tiny();
    expect(clampMoveToCap(world, "ghost", 5, 5)).toBeNull();
    expect(clampMoveToCap(world, "u", NaN, 5)).toBeNull();
    expect(clampMoveToCap(world, "u", 1, 1)).toBeNull();
  });

  it("projects an over-cap claim onto the reachable set", () => {
    const world = bigWorld();
    const c = clampMoveToCap(world, "u", 20, 1);
    expect(c).not.toBeNull();
    // Scaled to 6 cells east along the same vector.
    expect(c!.x).toBe(7);
    expect(c!.y).toBe(1);
  });

  it("keeps in-cap claims (snapped to the nearest free cell)", () => {
    const world = tiny();
    const c = clampMoveToCap(world, "u", 3, 3);
    expect(c).not.toBeNull();
    expect(Math.hypot(c!.x - 1, c!.y - 1)).toBeLessThanOrEqual(MAX_STEP_DISTANCE + 1e-9);
  });

  it("returns null when boxed in", () => {
    expect(clampMoveToCap(boxedWorld(), "u", 5, 5)).toBeNull();
  });
});

describe("stepTowardPoint", () => {
  it("returns null for an unknown actor", () => {
    expect(stepTowardPoint(tiny(), "ghost", 4, 4)).toBeNull();
  });

  it("returns a capped step strictly toward the target", () => {
    const world = bigWorld();
    const s = stepTowardPoint(world, "u", 25, 25);
    expect(s).not.toBeNull();
    expect(Math.hypot(s!.x - 25, s!.y - 25)).toBeLessThan(Math.hypot(1 - 25, 1 - 25));
    expect(Math.hypot(s!.x - 1, s!.y - 1)).toBeLessThanOrEqual(MAX_STEP_DISTANCE + 1e-9);
  });

  it("returns null when already adjacent (no closer legal step)", () => {
    const world = tiny();
    world.actors.find((a) => a.id === "u")!.x = 3;
    world.actors.find((a) => a.id === "u")!.y = 4;
    // n at (4,4): adjacent — the only strictly-closer integer cell is n's own.
    expect(stepTowardPoint(world, "u", 4, 4)).toBeNull();
  });

  it("returns null when boxed in", () => {
    expect(stepTowardPoint(boxedWorld(), "u", 4, 4)).toBeNull();
  });
});

describe("resolveMovementDestination", () => {
  it("resolves an actor destination to the actor's position", () => {
    expect(resolveMovementDestination(tiny(), "u", { destinationActorId: "n" })).toEqual({
      kind: "actor", id: "n", x: 4, y: 4,
    });
  });

  it("resolves an object destination to the object's center", () => {
    const world = tiny();
    world.scene.objects.push({
      id: "desk", name: "Desk", description: "d",
      x: 2, y: 2, w: 2, h: 2,
      passable: false, blocksVision: false, blocksSound: false,
    });
    expect(resolveMovementDestination(world, "u", { destinationObjectId: "desk" })).toEqual({
      kind: "object", id: "desk", x: 3, y: 3,
    });
  });

  it("prefers actor destinations over object destinations", () => {
    const world = tiny();
    world.scene.objects.push({
      id: "desk", name: "Desk", description: "d",
      x: 2, y: 2, w: 2, h: 2,
      passable: false, blocksVision: false, blocksSound: false,
    });
    const d = resolveMovementDestination(world, "u", {
      destinationActorId: "n", destinationObjectId: "desk",
    });
    expect(d?.kind).toBe("actor");
    expect(d?.id).toBe("n");
  });

  it("returns null for self-destinations, unknown ids, and empty semantics", () => {
    const world = tiny();
    expect(resolveMovementDestination(world, "u", { destinationActorId: "u" })).toBeNull();
    expect(resolveMovementDestination(world, "u", { destinationActorId: "ghost" })).toBeNull();
    expect(resolveMovementDestination(world, "u", { destinationObjectId: "ghost_desk" })).toBeNull();
    expect(resolveMovementDestination(world, "u", {})).toBeNull();
  });

  it("falls back to the object destination when the actor id is unknown", () => {
    const world = tiny();
    world.scene.objects.push({
      id: "desk", name: "Desk", description: "d",
      x: 2, y: 2, w: 2, h: 2,
      passable: false, blocksVision: false, blocksSound: false,
    });
    const d = resolveMovementDestination(world, "u", {
      destinationActorId: "ghost", destinationObjectId: "desk",
    });
    expect(d?.kind).toBe("object");
  });
});

describe("computeMovementOutcome", () => {
  it("returns null for an unknown actor", () => {
    expect(computeMovementOutcome(tiny(), "ghost", { destinationActorId: "n" })).toBeNull();
  });

  it("computes a directed outcome with path and destination", () => {
    const world = tiny();
    const o = computeMovementOutcome(world, "u", { destinationActorId: "n" });
    expect(o).not.toBeNull();
    expect(o!.from).toEqual({ x: 1, y: 1 });
    expect(o!.destination).toEqual({ kind: "actor", id: "n", x: 4, y: 4 });
    // Final cell strictly closer to n.
    expect(Math.hypot(o!.x - 4, o!.y - 4)).toBeLessThan(Math.hypot(1 - 4, 1 - 4));
    // Path runs from the start cell to the final cell.
    expect(o!.path.length).toBeGreaterThan(0);
    expect(o!.path[0]).toEqual({ x: 1.5, y: 1.5 });
    expect(o!.path[o!.path.length - 1]).toEqual({ x: o!.x + 0.5, y: o!.y + 0.5 });
  });

  it("computes an undirected outcome with a null destination", () => {
    const world = tiny();
    const o = computeMovementOutcome(world, "u", {}, "east");
    expect(o).not.toBeNull();
    expect(o!.destination).toBeNull();
    expect(o!.x).toBeGreaterThan(1);
  });

  it("returns null when no legal step exists", () => {
    expect(computeMovementOutcome(boxedWorld(), "u", { destinationActorId: "n" })).toBeNull();
    expect(computeMovementOutcome(boxedWorld(), "u", {})).toBeNull();
  });
});

describe("assertMovementInvariants", () => {
  const good = () =>
    computeMovementOutcome(tiny(), "u", { destinationActorId: "n" })!;

  it("returns no violations for a clean engine outcome", () => {
    expect(assertMovementInvariants(tiny(), "u", good())).toEqual([]);
  });

  it("flags an unknown actor", () => {
    expect(assertMovementInvariants(tiny(), "ghost", good())).toEqual(["unknown actor"]);
  });

  it("flags non-finite coordinates", () => {
    const o = { ...good(), x: NaN };
    expect(assertMovementInvariants(tiny(), "u", o)).toEqual(["coordinates not finite"]);
  });

  it("flags out-of-bounds destinations", () => {
    const o = { ...good(), x: 99, y: 99 };
    const v = assertMovementInvariants(tiny(), "u", o);
    expect(v.some((m) => m.startsWith("out of bounds"))).toBe(true);
  });

  it("flags blocked positions", () => {
    const world = tiny();
    world.scene.objects.push({
      id: "desk", name: "Desk", description: "d",
      x: 2, y: 1, w: 1, h: 1,
      passable: false, blocksVision: false, blocksSound: false,
    });
    const o = { ...good(), x: 2, y: 1, destination: null };
    const v = assertMovementInvariants(world, "u", o);
    expect(v.some((m) => m.startsWith("blocked position"))).toBe(true);
  });

  it("flags actor collisions", () => {
    const o = { ...good(), x: 4, y: 4, destination: null };
    const v = assertMovementInvariants(tiny(), "u", o);
    expect(v.some((m) => m.startsWith("actor collision"))).toBe(true);
  });

  it("flags zero displacement", () => {
    const o = { ...good(), x: 1, y: 1, destination: null };
    const v = assertMovementInvariants(tiny(), "u", o);
    expect(v.some((m) => m.startsWith("no displacement"))).toBe(true);
  });

  it("flags over-cap steps", () => {
    const world = bigWorld();
    const o = {
      from: { x: 1, y: 1 }, x: 20, y: 20, path: [],
      destination: null,
    };
    const v = assertMovementInvariants(world, "u", o);
    expect(v.some((m) => m.startsWith("over step cap"))).toBe(true);
  });

  it("flags missing paths", () => {
    const world = boxedWorld();
    // (4,4) is free but unreachable from boxed-in (1,1).
    const o = {
      from: { x: 1, y: 1 }, x: 4, y: 4, path: [],
      destination: null,
    };
    const v = assertMovementInvariants(world, "u", o);
    expect(v.some((m) => m.startsWith("no path"))).toBe(true);
  });

  it("flags steps that move away from the destination", () => {
    const world = tiny();
    const o = {
      ...good(),
      x: 0, y: 0, // away from n at (4,4)
      destination: { kind: "actor" as const, id: "n", x: 4, y: 4 },
    };
    const v = assertMovementInvariants(world, "u", o);
    expect(v.some((m) => m.startsWith("not closer to destination"))).toBe(true);
  });
});

describe("describeMovement", () => {
  it("describes an undirected move", () => {
    const world = tiny();
    const o = computeMovementOutcome(world, "u", {}, "east")!;
    expect(describeMovement(world, "u", o)).toBe(
      `U moved (1,1)→(${o.x},${o.y}).`,
    );
  });

  it("describes a directed move with actor distance (singular)", () => {
    const world = tiny();
    // n at (4,4); move u to (4,3): exactly 1 cell away.
    const o = {
      from: { x: 1, y: 1 }, x: 4, y: 3, path: [],
      destination: { kind: "actor" as const, id: "n", x: 4, y: 4 },
    };
    expect(describeMovement(world, "u", o)).toBe(
      "U moved (1,1)→(4,3), now 1 cell from N.",
    );
  });

  it("describes a directed move with actor distance (plural)", () => {
    const world = tiny();
    const o = computeMovementOutcome(world, "u", { destinationActorId: "n" })!;
    const dist = Math.round(Math.hypot(o.x - 4, o.y - 4));
    const unit = dist === 1 ? "cell" : "cells";
    expect(describeMovement(world, "u", o)).toBe(
      `U moved (1,1)→(${o.x},${o.y}), now ${dist} ${unit} from N.`,
    );
    // The tiny-world outcome is 1 cell out here — also cover a true plural
    // with a hand-built outcome.
    const far = {
      from: { x: 1, y: 1 }, x: 2, y: 2, path: [],
      destination: { kind: "actor" as const, id: "n", x: 4, y: 4 },
    };
    expect(describeMovement(world, "u", far)).toBe(
      "U moved (1,1)→(2,2), now 3 cells from N.",
    );
  });

  it("describes an object destination by rect distance", () => {
    const world = tiny();
    world.scene.objects.push({
      id: "desk", name: "Big Desk", description: "d",
      x: 3, y: 3, w: 2, h: 2,
      passable: false, blocksVision: false, blocksSound: false,
    });
    const o = {
      from: { x: 1, y: 1 }, x: 2, y: 3, path: [],
      destination: { kind: "object" as const, id: "desk", x: 4, y: 4 },
    };
    // (2,3) is 1 cell from the rect's west edge.
    expect(describeMovement(world, "u", o)).toBe(
      "U moved (1,1)→(2,3), now 1 cell from Big Desk.",
    );
  });

  it("falls back to the bare move when the destination is gone", () => {
    const world = tiny();
    const o = {
      from: { x: 1, y: 1 }, x: 2, y: 1, path: [],
      destination: { kind: "actor" as const, id: "ghost", x: 9, y: 9 },
    };
    expect(describeMovement(world, "u", o)).toBe("U moved (1,1)→(2,1).");
  });

  it("falls back to the actor id when the actor is unknown", () => {
    const world = tiny();
    const o = computeMovementOutcome(world, "u", {}, "east")!;
    expect(describeMovement(world, "ghost", o).startsWith("ghost moved")).toBe(true);
  });
});
