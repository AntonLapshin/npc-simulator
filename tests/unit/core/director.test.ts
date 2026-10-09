// PLAN_V2 Phase 5: unit tests for the director core (src/core/director.ts).
// Pure functions — no LLM, no I/O.
import { describe, expect, it } from "vitest";
import {
  directorConfigFor,
  evaluateDirectorStaleness,
  nextDirectorEvent,
  worldStateChanged,
  worldStateSignature,
  type DirectorStalenessInput,
} from "../../../src/core/director.js";
import { DEFAULT_DIRECTOR_STALENESS_THRESHOLD } from "../../../src/types.js";
import type { DirectorEvent } from "../../../src/types.js";
import { makeTinyWorld } from "../../helpers.js";

const EVENTS: DirectorEvent[] = [
  { id: "alarm", text: "The fire alarm starts ringing." },
  { id: "courier", text: "A courier arrives with a large box." },
];

function worldWithDirector(): ReturnType<typeof makeTinyWorld> {
  const world = makeTinyWorld();
  world.directorEvents = EVENTS;
  return world;
}

function staleInput(
  overrides: Partial<DirectorStalenessInput> = {},
): DirectorStalenessInput {
  return {
    actionCore: "other|",
    priorCores: ["other|", "wave|u"],
    worldChanged: false,
    stalenessCount: 0,
    consumedIds: [],
    config: { events: EVENTS, threshold: 6 },
    ...overrides,
  };
}

describe("worldStateSignature", () => {
  it("is stable for identical worlds", () => {
    expect(worldStateSignature(makeTinyWorld())).toBe(
      worldStateSignature(makeTinyWorld()),
    );
  });

  it("ignores turn metadata, history, thoughts, emotions, and memories", () => {
    const a = makeTinyWorld();
    const b = makeTinyWorld();
    b.tick = 99;
    b.turnIndex = 1;
    b.history.push({ text: "something happened", perceivers: ["u", "n"] });
    b.actors[0]!.thoughts = "hmm";
    b.actors[0]!.emotion = "joyful";
    b.actors[0]!.state = "working";
    b.actors[0]!.memories.push("a memory");
    expect(worldStateChanged(a, b)).toBe(false);
  });

  it("detects actor position, pose, prop, and holding-link changes", () => {
    const a = makeTinyWorld();
    const moved = makeTinyWorld();
    moved.actors[1]!.x = 5;
    expect(worldStateChanged(a, moved)).toBe(true);

    const posed = makeTinyWorld();
    posed.actors[0]!.pose = "sit";
    expect(worldStateChanged(a, posed)).toBe(true);

    const holding = makeTinyWorld();
    holding.actors[0]!.prop = "cup";
    holding.actors[0]!.heldObjectId = "mug_1";
    expect(worldStateChanged(a, holding)).toBe(true);
  });

  it("detects object moves, resizes, and state changes", () => {
    const base = makeTinyWorld();
    base.scene.objects.push({
      id: "desk",
      name: "Desk",
      description: "A desk.",
      x: 2,
      y: 2,
      w: 2,
      h: 1,
      passable: false,
      blocksVision: false,
      blocksSound: false,
    });
    const moved = structuredClone(base);
    moved.scene.objects[0]!.x = 3;
    expect(worldStateChanged(base, moved)).toBe(true);

    const relabeled = structuredClone(base);
    relabeled.scene.objects[0]!.description = "A broken desk.";
    expect(worldStateChanged(base, relabeled)).toBe(true);
  });
});

describe("nextDirectorEvent", () => {
  it("returns events in scenario order, skipping consumed ids", () => {
    expect(nextDirectorEvent(EVENTS, [])!.id).toBe("alarm");
    expect(nextDirectorEvent(EVENTS, ["alarm"])!.id).toBe("courier");
  });

  it("returns undefined when the list is exhausted (never repeats)", () => {
    expect(nextDirectorEvent(EVENTS, ["alarm", "courier"])).toBeUndefined();
    expect(nextDirectorEvent([], [])).toBeUndefined();
  });
});

describe("directorConfigFor", () => {
  it("is null when the scenario has no directorEvents (director off)", () => {
    expect(directorConfigFor(makeTinyWorld())).toBeNull();
  });

  it("is null for an empty list", () => {
    const world = makeTinyWorld();
    world.directorEvents = [];
    expect(directorConfigFor(world)).toBeNull();
  });

  it("defaults the threshold to 6 and honors a custom one", () => {
    expect(directorConfigFor(worldWithDirector())!.threshold).toBe(
      DEFAULT_DIRECTOR_STALENESS_THRESHOLD,
    );
    const world = worldWithDirector();
    world.directorStalenessThreshold = 2;
    expect(directorConfigFor(world)!.threshold).toBe(2);
  });
});

describe("evaluateDirectorStaleness", () => {
  it("counts a stale turn (repeat core, no world change)", () => {
    const r = evaluateDirectorStaleness(staleInput({ stalenessCount: 2 }));
    expect(r).toEqual({ stalenessCount: 3, inject: undefined });
  });

  it("counts a turn with an empty history window as not-new", () => {
    // Cold start: there is nothing for the first core to be new against,
    // so K boring turns from tick 0 reach exactly K.
    const r = evaluateDirectorStaleness(
      staleInput({ priorCores: [], stalenessCount: 0 }),
    );
    expect(r).toEqual({ stalenessCount: 1, inject: undefined });
  });

  it("resets on a new action core", () => {
    const r = evaluateDirectorStaleness(
      staleInput({ actionCore: "sit|", stalenessCount: 4 }),
    );
    expect(r).toEqual({ stalenessCount: 0, inject: undefined });
  });

  it("resets when the world changed, even with a repeat core", () => {
    const r = evaluateDirectorStaleness(
      staleInput({ worldChanged: true, stalenessCount: 4 }),
    );
    expect(r).toEqual({ stalenessCount: 0, inject: undefined });
  });

  it("fires exactly at the threshold — not before", () => {
    const before = evaluateDirectorStaleness(
      staleInput({ stalenessCount: 4 }),
    );
    expect(before.inject).toBeUndefined();
    expect(before.stalenessCount).toBe(5);

    const at = evaluateDirectorStaleness(staleInput({ stalenessCount: 5 }));
    expect(at.stalenessCount).toBe(0);
    expect(at.inject).toEqual(EVENTS[0]);
  });

  it("respects a custom threshold", () => {
    const r = evaluateDirectorStaleness(
      staleInput({
        stalenessCount: 1,
        config: { events: EVENTS, threshold: 2 },
      }),
    );
    expect(r.stalenessCount).toBe(0);
    expect(r.inject).toEqual(EVENTS[0]);
  });

  it("skips consumed events and never repeats", () => {
    const r = evaluateDirectorStaleness(
      staleInput({ stalenessCount: 5, consumedIds: ["alarm"] }),
    );
    expect(r.inject).toEqual(EVENTS[1]);
  });

  it("stays silent (no crash, no repeat) when the list is exhausted", () => {
    const r = evaluateDirectorStaleness(
      staleInput({ stalenessCount: 5, consumedIds: ["alarm", "courier"] }),
    );
    expect(r).toEqual({ stalenessCount: 0, inject: undefined });
  });

  it("is inert when the director is off", () => {
    const r = evaluateDirectorStaleness(
      staleInput({ stalenessCount: 99, config: null }),
    );
    expect(r).toEqual({ stalenessCount: 0, inject: undefined });
  });
});
