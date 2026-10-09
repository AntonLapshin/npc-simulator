import { describe, expect, it } from "vitest";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { loadOfficeScenario } from "../helpers.js";

function baseScenario() {
  return {
    version: 1,
    id: "test",
    title: "Test",
    narrative: "Narrative.",
    userActorId: "a",
    order: ["a", "b"],
    scene: { width: 6, height: 6, objects: [] },
    actors: [
      {
        id: "a",
        name: "A",
        persona: "P",
        x: 1,
        y: 1,
        state: "s",
        emotion: "e",
        goal: "g",
        memories: [],
        beliefs: [],
        relationships: [],
      },
      {
        id: "b",
        name: "B",
        persona: "P",
        x: 4,
        y: 4,
        state: "s",
        emotion: "e",
        goal: "g",
        memories: [],
        beliefs: [],
        relationships: [],
      },
    ],
  };
}

describe("scenarioLoader", () => {
  it("loads a valid scenario with tick=0, turnIndex=0, empty history", () => {
    const world = loadScenario(baseScenario());
    expect(world.tick).toBe(0);
    expect(world.turnIndex).toBe(0);
    expect(world.history).toEqual([]);
    expect(world.id).toBe("test");
  });

  it("loads the office scenario", () => {
    const world = loadOfficeScenario();
    expect(world.actors).toHaveLength(3);
    expect(world.userActorId).toBe("jeff");
  });

  it("rejects invalid schema", () => {
    expect(() => loadScenario({ nope: true })).toThrow();
    expect(() => loadScenario(null)).toThrow();
  });

  it("rejects missing user actor", () => {
    const s = baseScenario() as unknown as Record<string, unknown>;
    expect(() => loadScenario({ ...s, userActorId: "ghost" })).toThrow(/userActorId/);
  });

  it("rejects duplicate actor id", () => {
    const s = baseScenario();
    s.actors = [...s.actors, { ...s.actors[0]! }];
    expect(() => loadScenario(s)).toThrow(/duplicate actor id/);
  });

  it("rejects duplicate object id", () => {
    const s = baseScenario();
    (s.scene as { objects: unknown[] }).objects = [
      { id: "o", name: "O", description: "d", x: 0, y: 0, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false },
      { id: "o", name: "O2", description: "d", x: 2, y: 2, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false },
    ];
    expect(() => loadScenario(s)).toThrow(/duplicate object id/);
  });

  it("rejects invalid turn order (unknown id / missing actor)", () => {
    const s = baseScenario();
    expect(() => loadScenario({ ...s, order: ["a", "ghost"] })).toThrow(/unknown actor/);
    expect(() => loadScenario({ ...s, order: ["a"] })).toThrow(/missing actor/);
  });

  it("rejects actor outside scene", () => {
    const s = baseScenario();
    s.actors[0] = { ...s.actors[0]!, x: 99, y: 99 };
    expect(() => loadScenario(s)).toThrow(/outside scene/);
  });

  it("rejects actor inside non-passable object", () => {
    const s = baseScenario();
    (s.scene as { objects: unknown[] }).objects = [
      { id: "wall", name: "W", description: "d", x: 0, y: 0, w: 3, h: 3, passable: false, blocksVision: true, blocksSound: true },
    ];
    expect(() => loadScenario(s)).toThrow(/non-passable/);
  });

  it("rejects object outside scene bounds", () => {
    const s = baseScenario();
    (s.scene as { objects: unknown[] }).objects = [
      { id: "wall", name: "W", description: "d", x: 5, y: 5, w: 5, h: 5, passable: false, blocksVision: true, blocksSound: true },
    ];
    expect(() => loadScenario(s)).toThrow(/outside scene/);
  });

  it("loads directorEvents and a custom staleness threshold", () => {
    const s = baseScenario();
    const world = loadScenario({
      ...s,
      directorEvents: [
        { id: "alarm", text: "The fire alarm starts ringing." },
        { id: "courier", text: "A courier arrives." },
      ],
      directorStalenessThreshold: 3,
    });
    expect(world.directorEvents).toHaveLength(2);
    expect(world.directorEvents![0]).toEqual({
      id: "alarm",
      text: "The fire alarm starts ringing.",
    });
    expect(world.directorStalenessThreshold).toBe(3);
  });

  it("leaves the director off when directorEvents is absent", () => {
    const world = loadScenario(baseScenario());
    expect(world.directorEvents).toBeUndefined();
    expect(world.directorStalenessThreshold).toBeUndefined();
  });

  it("rejects duplicate director event ids", () => {
    const s = baseScenario();
    expect(() =>
      loadScenario({
        ...s,
        directorEvents: [
          { id: "alarm", text: "One." },
          { id: "alarm", text: "Two." },
        ],
      }),
    ).toThrow(/duplicate director event id: alarm/);
  });

  it("rejects malformed director events and thresholds (fail fast)", () => {
    const s = baseScenario();
    // empty id / empty text
    expect(() =>
      loadScenario({ ...s, directorEvents: [{ id: "", text: "x" }] }),
    ).toThrow();
    expect(() =>
      loadScenario({ ...s, directorEvents: [{ id: "e", text: "" }] }),
    ).toThrow();
    // non-string text
    expect(() =>
      loadScenario({ ...s, directorEvents: [{ id: "e", text: 42 }] }),
    ).toThrow();
    // threshold below 1
    expect(() =>
      loadScenario({ ...s, directorStalenessThreshold: 0 }),
    ).toThrow();
  });

  it("loads the office scenario's example director events", () => {
    const world = loadOfficeScenario();
    expect(world.directorEvents).toHaveLength(2);
    expect(world.directorEvents!.map((e) => e.id)).toEqual([
      "fire-alarm-test",
      "courier-package",
    ]);
  });
});
