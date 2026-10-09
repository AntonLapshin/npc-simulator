import { describe, expect, it } from "vitest";
import { WorldStore, advanceTurn, getCurrentActor, incrementTick } from "../../src/engine/worldStore.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { Logger } from "../../src/logging/logger.js";
import { makeTinyWorld } from "../helpers.js";

describe("worldStore", () => {
  it("getCurrentActor follows turn order", () => {
    const world = makeTinyWorld();
    expect(getCurrentActor(world).id).toBe("u");
    expect(getCurrentActor(advanceTurn(world)).id).toBe("n");
  });

  it("advanceTurn wraps around and incrementTick adds one", () => {
    const world = makeTinyWorld();
    const advanced = advanceTurn(advanceTurn(world));
    expect(advanced.turnIndex).toBe(0);
    expect(incrementTick(world).tick).toBe(1);
  });

  it("WorldStore snapshots are immutable and render results apply with logging", () => {
    const logger = new Logger({ sessionId: "store1", writeToFile: false });
    const store = new WorldStore(makeTinyWorld(), { logger });
    const snap = store.snapshot();
    snap.tick = 999;
    expect(store.getWorld().tick).toBe(0);

    store.applyRenderResult(
      { narrative: "Hi.", thoughts: "Friendly.", emotion: "happy", reasoning: "r" },
      { actorId: "u", text: "Wave." },
      { movement: null, pose: null, manipulation: null },
    );
    expect(store.getWorld().actors.find((a) => a.id === "u")!.emotion).toBe("happy");
    expect(store.getWorld().actors.find((a) => a.id === "u")!.thoughts).toBe("Friendly.");
    expect(logger.store.byEvent("patch_applied")).toHaveLength(1);

    store.incrementTick();
    expect(store.getWorld().tick).toBe(1);
    store.advanceTurn();
    expect(store.getWorld().turnIndex).toBe(1);
  });
});

describe("scenarioLoader logging", () => {
  it("logs scenario_loaded on success and scenarioloadfailed on failure", () => {
    const logger = new Logger({ sessionId: "loaderlog", writeToFile: false });
    loadScenario(
      {
        version: 1, id: "x", title: "X", narrative: "N", userActorId: "a",
        order: ["a"],
        scene: { width: 4, height: 4, objects: [] },
        actors: [
          { id: "a", name: "A", persona: "p", x: 1, y: 1, state: "s", emotion: "e", goal: "g", memories: [], beliefs: [], relationships: [] },
        ],
      },
      logger,
    );
    expect(logger.store.byEvent("scenario_loaded")).toHaveLength(1);
    expect(() => loadScenario({ nope: true }, logger)).toThrow();
    expect(logger.store.byEvent("scenarioloadfailed")).toHaveLength(1);
  });
});
