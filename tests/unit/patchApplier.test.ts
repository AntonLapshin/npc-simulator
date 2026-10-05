import { describe, expect, it } from "vitest";
import { applyConsequence } from "../../src/engine/patchApplier.js";
import { makeTinyWorld } from "../helpers.js";
import { resolveConfig } from "../../src/config.js";

describe("patchApplier", () => {
  it("appends memories, beliefs, relationships", () => {
    const world = makeTinyWorld();
    const next = applyConsequence(
      world,
      {
        narrative: "U speaks.",
        actorPatches: [
          { actorId: "u", memoriesAppend: ["Said hi."], beliefsAppend: ["N is nearby."], relationshipsAppend: ["U greeted N."] },
        ],
        objectPatches: [],
        reasoning: "r",
      },
      { actorId: "u", text: "Hi!" },
    );
    const u = next.actors.find((a) => a.id === "u")!;
    expect(u.memories).toContain("Said hi.");
    expect(u.beliefs).toContain("N is nearby.");
    expect(u.relationships).toContain("U greeted N.");
  });

  it("replaces emotion, goal, state", () => {
    const world = makeTinyWorld();
    const next = applyConsequence(
      world,
      {
        narrative: "U changes.",
        actorPatches: [{ actorId: "u", emotion: "excited", goal: "Celebrate.", state: "dancing" }],
        objectPatches: [],
        reasoning: "r",
      },
      { actorId: "u", text: "Dance!" },
    );
    const u = next.actors.find((a) => a.id === "u")!;
    expect(u.emotion).toBe("excited");
    expect(u.goal).toBe("Celebrate.");
    expect(u.state).toBe("dancing");
  });

  it("trims memories beyond configured maximum", () => {
    const world = makeTinyWorld();
    const config = resolveConfig({ maxMemoriesPerActor: 2 });
    const next = applyConsequence(
      world,
      {
        narrative: "n",
        actorPatches: [{ actorId: "u", memoriesAppend: ["m1", "m2", "m3"] }],
        objectPatches: [],
        reasoning: "r",
      },
      { actorId: "u", text: "act" },
      config,
    );
    expect(next.actors.find((a) => a.id === "u")!.memories).toEqual(["m2", "m3"]);
  });

  it("trims history beyond configured maximum", () => {
    const world = makeTinyWorld();
    const config = resolveConfig({ maxHistoryEntries: 3 });
    let current = world;
    for (let i = 0; i < 5; i++) {
      current = applyConsequence(
        current,
        { narrative: `n${i}`, actorPatches: [], objectPatches: [], reasoning: "r" },
        { actorId: "u", text: `act${i}` },
        config,
      );
    }
    expect(current.history.length).toBe(3);
  });

  it("applies object patches", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "door", name: "Door", description: "Open.",
      x: 0, y: 0, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    const next = applyConsequence(
      world,
      {
        narrative: "Door closes.",
        actorPatches: [],
        objectPatches: [{ objectId: "door", description: "Closed.", passable: false, blocksVision: true }],
        reasoning: "r",
      },
      { actorId: "u", text: "Close the door." },
    );
    const door = next.scene.objects.find((o) => o.id === "door")!;
    expect(door.description).toBe("Closed.");
    expect(door.passable).toBe(false);
    expect(door.blocksVision).toBe(true);
  });

  it("does not mutate the input world", () => {
    const world = makeTinyWorld();
    const before = JSON.stringify(world);
    applyConsequence(
      world,
      { narrative: "n", actorPatches: [{ actorId: "u", emotion: "x" }], objectPatches: [], reasoning: "r" },
      { actorId: "u", text: "act" },
    );
    expect(JSON.stringify(world)).toBe(before);
  });
});
