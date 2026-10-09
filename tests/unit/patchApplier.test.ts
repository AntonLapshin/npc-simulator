import { describe, expect, it } from "vitest";
import { applyRenderResult, type ExecutedTurn } from "../../src/engine/patchApplier.js";
import { makeTinyWorld } from "../helpers.js";
import { resolveConfig } from "../../src/config.js";
import type { ConsequenceResult } from "../../src/types.js";

const render: ConsequenceResult = { narrative: "U speaks.", thoughts: "Focused.", emotion: "calm", reasoning: "r" };

function noOutcomes(): ExecutedTurn {
  return { movement: null, pose: null, manipulation: null };
}

describe("applyRenderResult (Phase 4: engine outcomes + prose)", () => {
  it("applies engine movement and movement state labels", () => {
    const world = makeTinyWorld();
    const next = applyRenderResult(world, { actorId: "u", text: "Walk to N." }, render, {
      ...noOutcomes(),
      movement: {
        from: { x: 1, y: 1 }, x: 3, y: 3,
        path: [{ x: 2, y: 2 }, { x: 3, y: 3 }],
        destination: { kind: "actor", id: "n", x: 4, y: 4 },
      },
    });
    const u = next.actors.find((a) => a.id === "u")!;
    expect(u.x).toBe(3);
    expect(u.y).toBe(3);
    // Movement sets a deterministic position/state label (never a raw
    // coordinate echo).
    expect(u.state.length).toBeGreaterThan(0);
  });

  it("applies engine pose changes", () => {
    const world = makeTinyWorld();
    const next = applyRenderResult(world, { actorId: "u", text: "Sit down." }, render, {
      ...noOutcomes(),
      pose: "sit",
    });
    expect(next.actors.find((a) => a.id === "u")!.pose).toBe("sit");
  });

  it("applies engine manipulation: prop moves to the target object", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "u")!.prop = "cup";
    world.scene.objects.push({
      id: "desk", name: "Desk", description: "A desk.",
      x: 2, y: 1, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false,
    });
    const next = applyRenderResult(world, { actorId: "u", text: "Put the cup on the desk." }, render, {
      ...noOutcomes(),
      manipulation: {
        plan: { kind: "put-down", actorId: "u", objectId: "desk", propName: "cup", surfaceId: "desk", rule: "test" },
        actorProps: [{ actorId: "u", prop: null }],
        heldObjectIds: [{ actorId: "u", heldObjectId: null }],
        objectMoves: [{ objectId: "cup", x: 2, y: 1 }],
      },
    });
    expect(next.actors.find((a) => a.id === "u")!.prop).toBeNull();
  });

  it("sets acting actor thoughts/emotion from prose and appends the memory line", () => {
    const world = makeTinyWorld();
    const next = applyRenderResult(world, { actorId: "u", text: "Wave at N." }, {
      narrative: "U waves at N.",
      thoughts: "Hope N noticed.",
      emotion: "hopeful",
      reasoning: "r",
    }, noOutcomes());
    const u = next.actors.find((a) => a.id === "u")!;
    expect(u.thoughts).toBe("Hope N noticed.");
    expect(u.emotion).toBe("hopeful");
    expect(u.memories.at(-1)).toContain("U waves at N.");
    expect(next.history.at(-1)!.text).toBe("U: U waves at N.");
  });

  it("does not set other actors' thoughts", () => {
    const world = makeTinyWorld();
    const next = applyRenderResult(world, { actorId: "u", text: "Wave at N." }, {
      narrative: "U waves at N.",
      thoughts: "Hope N noticed.",
      reasoning: "r",
    }, noOutcomes());
    expect(next.actors.find((a) => a.id === "n")!.thoughts).not.toBe("Hope N noticed.");
  });

  it("liveness applies prose only: no world outcomes", () => {
    const world = makeTinyWorld();
    const snapshot = world.actors.map((a) => ({ x: a.x, y: a.y, state: a.state, prop: a.prop }));
    const next = applyRenderResult(world, { actorId: "u", text: "Idle." }, {
      narrative: "U taps her pen quietly.",
      reasoning: "r",
    }, {
      ...noOutcomes(),
      movement: {
        from: { x: 1, y: 1 }, x: 3, y: 3,
        path: [{ x: 2, y: 2 }, { x: 3, y: 3 }],
        destination: { kind: "actor", id: "n", x: 4, y: 4 },
      },
    }, undefined, { liveness: true });
    expect(next.actors.map((a) => ({ x: a.x, y: a.y, state: a.state, prop: a.prop }))).toEqual(snapshot);
    expect(next.history.at(-1)!.text).toBe("U: U taps her pen quietly.");
  });

  it("fallback marks history as not-done and changes nothing", () => {
    const world = makeTinyWorld();
    const next = applyRenderResult(world, { actorId: "u", text: "Fly to the moon." }, {
      narrative: "Nothing changes.",
      fallback: true,
      reasoning: "r",
    }, noOutcomes(), resolveConfig(), { fallback: true, honestHistoryNote: "Honest: flying is impossible." });
    const u = next.actors.find((a) => a.id === "u")!;
    expect([u.x, u.y]).toEqual([1, 1]);
    const entry = next.history.at(-1)!.text;
    expect(entry).toContain("(not done)");
    // Exp-5 item 2: the honest note applies to non-fallback applied turns.
    const noted = applyRenderResult(world, { actorId: "u", text: "Wave at N." }, {
      narrative: "U waves at N.",
      reasoning: "r",
    }, noOutcomes(), resolveConfig(), { honestHistoryNote: "liveness floor" });
    expect(noted.history.at(-1)!.text).toContain("[liveness floor]");
  });

  it("trims history beyond configured maximum", () => {
    const world = makeTinyWorld();
    const config = resolveConfig({ maxHistoryEntries: 3 });
    let current = world;
    for (let i = 0; i < 5; i++) {
      current = applyRenderResult(current, { actorId: "u", text: `act${i}` }, {
        narrative: `n${i}`,
        reasoning: "r",
      }, noOutcomes(), config);
    }
    expect(current.history.length).toBe(3);
  });

  it("does not mutate the input world", () => {
    const world = makeTinyWorld();
    const before = JSON.stringify(world);
    applyRenderResult(world, { actorId: "u", text: "act" }, render, noOutcomes());
    expect(JSON.stringify(world)).toBe(before);
  });
});
