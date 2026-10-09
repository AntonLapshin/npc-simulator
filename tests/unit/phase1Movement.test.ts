// Phase 1 acceptance tests: engine-owned movement.
//
// The model never emits coordinates: movement is computed by the engine,
// always materializes, and always moves the right actor. These tests cover
// the executor units plus the golden mock runs from the Phase-1
// acceptance criteria:
// - render engine emits no x/y (or deliberately wrong x/y) → final
//   position still equals the pathfinder output;
// - B3 shape (walk narrated, no patch) and B6 shape (patch for the wrong
//   actor) produce correct engine movement.
import { describe, expect, it } from "vitest";
import { Logger } from "../../src/logging/logger.js";
import { makeTestDeps } from "../helpers.js";
import { MockProposalEngine } from "../../src/mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../../src/mocks/mockSelectionEngine.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import {
  resolveWithValidation,
  runTurn,
} from "../../src/engine/turnOrchestrator.js";
import { computeMovementOutcome } from "../../src/core/movement.js";
import {
  applyEngineMovement,
  executedMovementFacts,
  executeMovement,
  executorDestination,
  planMovementSemantics,
} from "../../src/engine/movementExecutor.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { buildConsequenceContext } from "../../src/engine/contextBuilder.js";
import { defaultConfig } from "../../src/config.js";
import type {
  ActionSemantics,
  ConsequenceResult,
  World,
} from "../../src/types.js";

function moveWorld(): World {
  return loadScenario({
    version: 1,
    id: "move-test",
    title: "Move",
    narrative: "A room.",
    userActorId: "alf",
    order: ["alf", "bea"],
    scene: { width: 10, height: 10, objects: [] },
    actors: [
      {
        id: "alf", name: "Alf", persona: "A walker.", x: 1, y: 1,
        state: "standing", emotion: "calm", goal: "Move.", thoughts: "t",
        memories: [], beliefs: [], relationships: [],
      },
      {
        id: "bea", name: "Bea", persona: "A stander.", x: 8, y: 8,
        state: "standing", emotion: "calm", goal: "Stay.", thoughts: "t",
        memories: [], beliefs: [], relationships: [],
      },
    ],
  });
}

function silentSemantics(): ActionSemantics {
  return { moves: false, speaks: false, quotedSpeech: [] };
}

function scriptedConsequence(result: ConsequenceResult) {
  return { resolve: async () => structuredClone(result) } as never;
}

describe("planMovementSemantics", () => {
  it("plans locomotion with a resolved actor destination from text", () => {
    const world = moveWorld();
    const planned = planMovementSemantics(world, { actorId: "alf", text: "Walk toward Bea." });
    expect(planned.moves).toBe(true);
    expect(planned.destinationActorId).toBe("bea");
  });

  it("plans no movement for stationary work", () => {
    const world = moveWorld();
    expect(
      planMovementSemantics(world, { actorId: "alf", text: "Type furiously on the laptop." }).moves,
    ).toBe(false);
  });

  it("plans no movement for facing-only turns", () => {
    const world = moveWorld();
    expect(
      planMovementSemantics(world, { actorId: "alf", text: "Turn to Bea." }).moves,
    ).toBe(false);
  });

  it("plans no movement for pure questions", () => {
    const world = moveWorld();
    expect(
      planMovementSemantics(world, { actorId: "alf", text: "Bea, where should I sit?" }).moves,
    ).toBe(false);
  });
});

describe("executorDestination", () => {
  it("prefers explicit actor, then object, then contact destinations", () => {
    const s: ActionSemantics = {
      moves: true, speaks: false, quotedSpeech: [],
      destinationActorId: "bea", destinationObjectId: "desk", contactActorId: "bea",
    };
    expect(executorDestination(s, "alf")).toEqual({ kind: "actor", id: "bea" });
    const s2: ActionSemantics = {
      moves: true, speaks: false, quotedSpeech: [], destinationObjectId: "desk",
    };
    expect(executorDestination(s2, "alf")).toEqual({ kind: "object", id: "desk" });
    const s3: ActionSemantics = {
      moves: false, speaks: false, quotedSpeech: [], contactActorId: "bea",
    };
    expect(executorDestination(s3, "alf")).toEqual({ kind: "actor", id: "bea" });
    // Self-contact is not a destination.
    const s4: ActionSemantics = {
      moves: false, speaks: false, quotedSpeech: [], contactActorId: "alf",
    };
    expect(executorDestination(s4, "alf")).toBeNull();
    expect(executorDestination(silentSemantics(), "alf")).toBeNull();
  });
});

describe("executeMovement", () => {
  it("returns null for stationary semantics", () => {
    const world = moveWorld();
    expect(
      executeMovement(world, { actorId: "alf", text: "Type furiously." }, silentSemantics()),
    ).toBeNull();
  });

  it("returns null for an unknown actor", () => {
    const world = moveWorld();
    expect(
      executeMovement(
        world,
        { actorId: "ghost", text: "Walk toward Bea." },
        { moves: true, destinationActorId: "bea" },
      ),
    ).toBeNull();
  });

  it("computes a directed outcome toward the destination", () => {
    const world = moveWorld();
    const o = executeMovement(
      world,
      { actorId: "alf", text: "Walk toward Bea." },
      { moves: true, destinationActorId: "bea" },
    );
    expect(o).not.toBeNull();
    expect(o!.destination?.id).toBe("bea");
    const oldDist = Math.hypot(1 - 8, 1 - 8);
    expect(Math.hypot(o!.x - 8, o!.y - 8)).toBeLessThan(oldDist);
    expect(o!.path.length).toBeGreaterThan(0);
  });

  it("promotes contact to a destination when no walk verb is present", () => {
    const world = moveWorld();
    const o = executeMovement(
      world,
      { actorId: "alf", text: "Shake Bea's hand." },
      { moves: false, contactActorId: "bea" },
    );
    expect(o).not.toBeNull();
    expect(o!.destination?.id).toBe("bea");
  });

  it("returns null when no legal step exists", () => {
    const world = moveWorld();
    // Bea stands on Alf's cell: stacking is excluded, adjacency impossible.
    world.actors.find((a) => a.id === "bea")!.x = 1;
    world.actors.find((a) => a.id === "bea")!.y = 1;
    // Surround Alf with walls so nothing is reachable either.
    for (const [x, y] of [[0, 1], [2, 1], [1, 0], [1, 2]] as const) {
      world.scene.objects.push({
        id: `w${x}${y}`, name: "wall", description: "w",
        x, y, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false,
      });
    }
    expect(
      executeMovement(
        world,
        { actorId: "alf", text: "Walk toward Bea." },
        { moves: true, destinationActorId: "bea" },
      ),
    ).toBeNull();
  });
});

describe("applyEngineMovement", () => {
  const outcome = () => computeMovementOutcome(moveWorld(), "alf", { destinationActorId: "bea" }, null)!;

  it("strips model coordinates from every patch and applies the engine outcome to the acting actor", () => {
    const ignored: Array<[string, number | undefined, number | undefined]> = [];
    const merged = applyEngineMovement(
      {
        narrative: "Alf walks.",
        actorPatches: [
          { actorId: "alf", x: 9, y: 0, thoughts: "Teleport!" },
          { actorId: "bea", x: 5, y: 5, thoughts: "Huh?" },
        ],
        objectPatches: [],
        reasoning: "r",
      },
      "alf",
      outcome(),
      (id, x, y) => ignored.push([id, x, y]),
    );
    expect(ignored).toEqual([["alf", 9, 0], ["bea", 5, 5]]);
    const alf = merged.actorPatches.find((p) => p.actorId === "alf")!;
    const expected = outcome();
    expect(alf.x).toBe(expected.x);
    expect(alf.y).toBe(expected.y);
    const bea = merged.actorPatches.find((p) => p.actorId === "bea")!;
    expect(bea.x).toBeUndefined();
    expect(bea.y).toBeUndefined();
  });

  it("adds a position-only patch when the consequence did not patch the actor", () => {
    const merged = applyEngineMovement(
      {
        narrative: "Alf walks.",
        actorPatches: [],
        objectPatches: [],
        reasoning: "r",
      },
      "alf",
      outcome(),
    );
    const alf = merged.actorPatches.find((p) => p.actorId === "alf")!;
    const expected = outcome();
    expect(alf).toEqual({ actorId: "alf", x: expected.x, y: expected.y });
  });

  it("strips coordinates and adds nothing for a null outcome", () => {
    const merged = applyEngineMovement(
      {
        narrative: "Alf types.",
        actorPatches: [{ actorId: "alf", x: 2, y: 2, thoughts: "t" }],
        objectPatches: [],
        reasoning: "r",
      },
      "alf",
      null,
    );
    const alf = merged.actorPatches.find((p) => p.actorId === "alf")!;
    expect(alf.x).toBeUndefined();
    expect(alf.y).toBeUndefined();
    expect(alf.thoughts).toBe("t");
  });

  it("does not mutate the input result", () => {
    const input: ConsequenceResult = {
      narrative: "Alf walks.",
      actorPatches: [{ actorId: "alf", x: 9, y: 0, thoughts: "t" }],
      objectPatches: [],
      reasoning: "r",
    };
    applyEngineMovement(input, "alf", outcome());
    expect(input.actorPatches[0]!.x).toBe(9);
  });
});

describe("executedMovementFacts", () => {
  it("narrates an executed move with the no-coordinates rule", () => {
    const world = moveWorld();
    const o = computeMovementOutcome(world, "alf", { destinationActorId: "bea" }, null)!;
    const facts = executedMovementFacts(world, "alf", o);
    expect(facts[0]).toMatch(/EXECUTED MOVEMENT/);
    expect(facts[1]).toBe(`Alf moved (1,1)→(${o.x},${o.y}), now ${Math.round(Math.hypot(o.x - 8, o.y - 8))} cells from Bea.`);
    expect(facts[2]).toMatch(/Do NOT emit x\/y coordinates/);
  });

  it("states the stationary case", () => {
    const world = moveWorld();
    const facts = executedMovementFacts(world, "alf", null);
    expect(facts[0]).toMatch(/stays in place/);
    expect(facts[1]).toMatch(/Do NOT emit x\/y coordinates/);
  });
});

describe("Phase 1 golden runs: B3 (narrated walk, no patch)", () => {
  it("engine movement materializes when the render emits no x/y", async () => {
    const logger = new Logger({ sessionId: "phase1-b3", writeToFile: false });
    const world = moveWorld();
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence({
        narrative: "Alf walks toward Bea.",
        actorPatches: [{ actorId: "alf", thoughts: "Going to say hi." }],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: true, destinationActorId: "bea", spoke: false, quotedSpeech: [] },
      }),
    });
    const result = await resolveWithValidation(
      world, { actorId: "alf", text: "Walk toward Bea." }, deps,
    );
    expect(result.narrative).not.toBe("Nothing changes.");
    const patch = result.actorPatches.find((p) => p.actorId === "alf")!;
    const expected = computeMovementOutcome(world, "alf", { destinationActorId: "bea" }, null)!;
    // Final position equals the pathfinder output — no model coordinates involved.
    expect(patch.x).toBe(expected.x);
    expect(patch.y).toBe(expected.y);
    expect(Math.hypot(patch.x! - 8, patch.y! - 8)).toBeLessThan(Math.hypot(1 - 8, 1 - 8));
    expect(logger.store.byEvent("movement_planned")).toHaveLength(1);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });

  it("deliberately wrong model x/y is ignored — the engine position wins", async () => {
    const logger = new Logger({ sessionId: "phase1-wrongxy", writeToFile: false });
    const world = moveWorld();
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence({
        narrative: "Alf walks toward Bea.",
        actorPatches: [{ actorId: "alf", x: 9, y: 0, thoughts: "Teleport!" }],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: true, destinationActorId: "bea", spoke: false, quotedSpeech: [] },
      }),
    });
    const result = await resolveWithValidation(
      world, { actorId: "alf", text: "Walk toward Bea." }, deps,
    );
    const patch = result.actorPatches.find((p) => p.actorId === "alf")!;
    const expected = computeMovementOutcome(world, "alf", { destinationActorId: "bea" }, null)!;
    expect(patch.x).toBe(expected.x);
    expect(patch.y).toBe(expected.y);
    expect([patch.x, patch.y]).not.toEqual([9, 0]);
    const ignored = logger.store.byEvent("model_coordinates_ignored");
    expect(ignored.length).toBeGreaterThanOrEqual(1);
    expect(ignored[0]!.output).toMatchObject({ ignoredActorId: "alf", ignoredX: 9, ignoredY: 0 });
  });

  it("the render input carries the executed movement as facts", () => {
    // buildConsequenceContext is what the real consequence engines call —
    // the scripted engines in the other tests bypass it, so test it directly.
    const world = moveWorld();
    const o = computeMovementOutcome(world, "alf", { destinationActorId: "bea" }, null)!;
    const ctx = buildConsequenceContext(
      world,
      { actorId: "alf", text: "Walk toward Bea." },
      undefined,
      defaultConfig,
      o,
    );
    expect(ctx).toMatch(/EXECUTED MOVEMENT/);
    expect(ctx).toMatch(new RegExp(`Alf moved \\(1,1\\)→\\(${o.x},${o.y}\\)`));
    expect(ctx).toMatch(/Do NOT emit x\/y coordinates/);
    // Stationary turns state it plainly.
    const still = buildConsequenceContext(
      world,
      { actorId: "alf", text: "Type furiously." },
      undefined,
      defaultConfig,
      null,
    );
    expect(still).toMatch(/stays in place/);
    expect(still).toMatch(/Do NOT emit x\/y coordinates/);
  });
});

describe("Phase 1 golden runs: B6 (patch moves the wrong actor)", () => {
  it("a wrong-actor patch loses its coordinates; only the acting actor moves", async () => {
    const logger = new Logger({ sessionId: "phase1-b6", writeToFile: false });
    const world = moveWorld();
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence({
        narrative: "Alf walks toward Bea.",
        actorPatches: [
          { actorId: "bea", x: 5, y: 5, thoughts: "Why am I moving?" },
          { actorId: "alf", thoughts: "Walking." },
        ],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: true, destinationActorId: "bea", spoke: false, quotedSpeech: [] },
      }),
    });
    const result = await resolveWithValidation(
      world, { actorId: "alf", text: "Walk toward Bea." }, deps,
    );
    const bea = result.actorPatches.find((p) => p.actorId === "bea")!;
    expect(bea.x).toBeUndefined();
    expect(bea.y).toBeUndefined();
    const alf = result.actorPatches.find((p) => p.actorId === "alf")!;
    const expected = computeMovementOutcome(world, "alf", { destinationActorId: "bea" }, null)!;
    expect(alf.x).toBe(expected.x);
    expect(alf.y).toBe(expected.y);
    const ignored = logger.store.byEvent("model_coordinates_ignored");
    expect(ignored.some((e) => (e.output as { ignoredActorId?: string })?.ignoredActorId === "bea")).toBe(true);
  });
});

describe("Phase 1 golden runs: stationary and contact", () => {
  it("a typing turn stays in place with no coordinates demanded", async () => {
    const logger = new Logger({ sessionId: "phase1-stationary", writeToFile: false });
    const world = moveWorld();
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence({
        narrative: "Alf stares blankly at the wall.",
        actorPatches: [{ actorId: "alf", thoughts: "So blank." }],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: false, spoke: false, quotedSpeech: [] },
      }),
    });
    const result = await resolveWithValidation(
      world, { actorId: "alf", text: "Stare blankly at the wall." }, deps,
    );
    expect(result.narrative).not.toBe("Nothing changes.");
    const patch = result.actorPatches.find((p) => p.actorId === "alf")!;
    expect(patch.x).toBeUndefined();
    expect(patch.y).toBeUndefined();
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });

  it("a contact turn closes to adjacency via the engine", async () => {
    const logger = new Logger({ sessionId: "phase1-contact", writeToFile: false });
    const world = moveWorld();
    world.actors.find((a) => a.id === "bea")!.x = 4;
    world.actors.find((a) => a.id === "bea")!.y = 2;
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence({
        narrative: "Alf shakes Bea's hand.",
        actorPatches: [{ actorId: "alf", thoughts: "Handshake." }],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: false, spoke: false, quotedSpeech: [], contactActorId: "bea" },
      }),
    });
    const result = await resolveWithValidation(
      world, { actorId: "alf", text: "Shake Bea's hand." }, deps,
    );
    expect(result.narrative).not.toBe("Nothing changes.");
    const patch = result.actorPatches.find((p) => p.actorId === "alf")!;
    expect(patch.x).toBeDefined();
    expect(patch.y).toBeDefined();
    // Adjacent to Bea (contact radius 2.5).
    expect(Math.hypot(patch.x! - 4, patch.y! - 2)).toBeLessThanOrEqual(2.5);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });
});

describe("Phase 1 end-to-end: runTurn applies engine movement to the world", () => {
  it("a full mock turn moves the acting actor to the engine-computed cell", async () => {
    const logger = new Logger({ sessionId: "phase1-e2e", writeToFile: false });
    const world = moveWorld();
    const deps = makeTestDeps(logger, {
      forceAllNpc: true,
      proposalEngine: new MockProposalEngine(logger, {
        alf: { suggestions: ["Walk toward Bea."], reasoning: "r" },
      }),
      selectionEngine: new MockSelectionEngine(logger, {
        alf: { action: "Walk toward Bea.", reasoning: "r" },
      }),
      consequenceEngine: new MockConsequenceEngine(logger, {
        "walk toward bea.": {
          narrative: "Alf walks toward Bea.",
          actorPatches: [{ actorId: "alf", thoughts: "Going." }],
          objectPatches: [],
          reasoning: "r",
          effects: { moved: true, destinationActorId: "bea", spoke: false, quotedSpeech: [] },
        },
      }),
    });
    const expected = computeMovementOutcome(world, "alf", { destinationActorId: "bea" }, null)!;
    const next = await runTurn(world, deps);
    const alf = next.actors.find((a) => a.id === "alf")!;
    expect(alf.x).toBe(expected.x);
    expect(alf.y).toBe(expected.y);
    // Bea never moved.
    const bea = next.actors.find((a) => a.id === "bea")!;
    expect(bea.x).toBe(8);
    expect(bea.y).toBe(8);
  });
});
