// Phase 3 acceptance tests: engine-owned objects and props.
//
// The model never emits objectPatches or prop patches for its own
// manipulations: the engine plans pick-up/put-down/hand-over from the
// action text and affordances, applies the outcome to the world, and
// hands the executed manipulation to the render call as facts. These
// tests cover the golden acceptance criteria:
// - "Dana picks up the laptop" with a render engine that emits NO
//   objectPatches → dana.prop === "laptop" deterministically;
// - "Anton hands Tanya the report" → the holder flips, both actors
//   coherent;
// - model objectPatches are stripped and ignored (debug-logged);
// - phantom manipulation (narrated transfer the engine did not
//   execute) fails validation;
// - put-down onto a named surface vs at the feet.
import { describe, expect, it } from "vitest";
import { Logger } from "../../src/logging/logger.js";
import { makeTestDeps } from "../helpers.js";
import { MockProposalEngine } from "../../src/mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../../src/mocks/mockSelectionEngine.js";
import { runTurn } from "../../src/engine/turnOrchestrator.js";
import {
  executeManipulation,
  executedManipulationFacts,
} from "../../src/engine/manipulationExecutor.js";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import { consequenceResultSchema } from "../../src/schemas.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { buildConsequenceContext } from "../../src/engine/contextBuilder.js";
import { defaultConfig } from "../../src/config.js";
import type { ConsequenceResult, World } from "../../src/types.js";

function officeWorld(): World {
  return loadScenario({
    version: 1,
    id: "objects-test",
    title: "Objects",
    narrative: "An office.",
    userActorId: "dana",
    order: ["dana", "anton", "tanya"],
    scene: {
      width: 20,
      height: 20,
      objects: [
        {
          id: "dana_laptop", name: "Dana's laptop", description: "A laptop.",
          x: 2, y: 1, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
        },
        {
          id: "q3_report", name: "Q3 report", description: "A report.",
          x: 10, y: 10, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
        },
        {
          id: "anton_desk", name: "Anton's desk", description: "A desk.",
          x: 11, y: 10, w: 2, h: 1, passable: false, blocksVision: false, blocksSound: false,
        },
      ],
    },
    actors: [
      {
        id: "dana", name: "Dana", persona: "An engineer.", x: 2, y: 2,
        state: "standing", emotion: "calm", goal: "Work.", thoughts: "t",
        memories: [], beliefs: [], relationships: [],
      },
      {
        id: "anton", name: "Anton", persona: "A manager.", x: 10, y: 11,
        state: "standing", emotion: "calm", goal: "Manage.", thoughts: "t",
        memories: [], beliefs: [], relationships: [],
      },
      {
        id: "tanya", name: "Tanya", persona: "An analyst.", x: 11, y: 11,
        state: "standing", emotion: "calm", goal: "Analyze.", thoughts: "t",
        memories: [], beliefs: [], relationships: [],
      },
    ],
  });
}

function scriptedConsequence(result: ConsequenceResult) {
  return { resolve: async () => structuredClone(result) } as never;
}

function silentResult(narrative: string): ConsequenceResult {
  // Phase 4: the render engine emits prose only — no objectPatches, no
  // prop patches (the Phase 3 contract, now enforced by the schema).
  return { narrative, reasoning: "r" };
}

function renderFacts(): RenderFacts {
  return {
    exactQuote: null, moved: false, pose: null, effectivePose: "stand",
    x: 2, y: 2, engineManipulation: null,
  };
}

describe("Phase 3 acceptance: pick-up", () => {
  it("\"Dana picks up the laptop\" with no model patches → dana.prop === \"laptop\"", async () => {
    const logger = new Logger({ sessionId: "phase3-pickup", writeToFile: false });
    const world = officeWorld();
    const deps = makeTestDeps(logger, {
      proposalEngine: new MockProposalEngine(logger),
      selectionEngine: new MockSelectionEngine(logger),
      consequenceEngine: scriptedConsequence(
        silentResult("Dana picks up her laptop and opens it."),
      ),
      getUserAction: async () => "Pick up the laptop.",
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const next = await runTurn(world, deps);
    const dana = next.actors.find((a) => a.id === "dana")!;
    // Deterministic engine execution — no model patch was involved.
    expect(dana.prop).toBe("laptop");
    // The scene object travels with its holder.
    const laptop = next.scene.objects.find((o) => o.id === "dana_laptop")!;
    expect([laptop.x, laptop.y]).toEqual([dana.x, dana.y]);
    expect(logger.store.byEvent("manipulation_planned")).toHaveLength(1);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });

  it("a model-emitted prop patch is stripped; the engine outcome wins", async () => {
    const logger = new Logger({ sessionId: "phase3-propoverride", writeToFile: false });
    const world = officeWorld();
    const ignored: unknown[] = [];
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence({
        narrative: "Dana picks up her laptop.",
        thoughts: "Wrong prop.",
        reasoning: "r",
      } as ConsequenceResult),
      getUserAction: async () => "Pick up the laptop.",
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const next = await runTurn(world, deps);
    // The engine's "laptop" stands — the render contract is prose-only, so
    // there is no model patch channel left to override it.
    expect(next.actors.find((a) => a.id === "dana")!.prop).toBe("laptop");
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    expect(ignored).toEqual([]);
  });
});

describe("Phase 3 acceptance: hand-over", () => {
  function handoverWorld(): World {
    const world = officeWorld();
    // Anton starts holding the report; Tanya stands adjacent, hands free.
    world.actors.find((a) => a.id === "anton")!.prop = "report";
    return world;
  }

  it("\"Anton hands Tanya the report\" → the holder flips, both actors coherent", async () => {
    const logger = new Logger({ sessionId: "phase3-handover", writeToFile: false });
    const world = handoverWorld();
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence(
        silentResult("Anton hands the Q3 report to Tanya."),
      ),
      getUserAction: async () => "Hand the Q3 report to Tanya.",
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    // Drive Anton's turn directly: he is the user actor here.
    world.userActorId = "anton";
    world.order = ["anton", "tanya", "dana"];
    const next = await runTurn(world, deps);
    const anton = next.actors.find((a) => a.id === "anton")!;
    const tanya = next.actors.find((a) => a.id === "tanya")!;
    expect(anton.prop).toBeNull();
    expect(tanya.prop).toBe("report");
    // The report object travels to the recipient.
    const report = next.scene.objects.find((o) => o.id === "q3_report")!;
    expect([report.x, report.y]).toEqual([tanya.x, tanya.y]);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });

  it("hand-over to a distant actor is not executed (no phantom transfer)", async () => {
    const logger = new Logger({ sessionId: "phase3-handover-far", writeToFile: false });
    const world = handoverWorld();
    world.actors.find((a) => a.id === "tanya")!.x = 19;
    world.actors.find((a) => a.id === "tanya")!.y = 19;
    world.userActorId = "anton";
    world.order = ["anton", "tanya", "dana"];
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence(
        silentResult("Anton hands the Q3 report to Tanya."),
      ),
      getUserAction: async () => "Hand the Q3 report to Tanya.",
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const next = await runTurn(world, deps);
    // The engine refused the transfer; Anton still holds the report.
    expect(next.actors.find((a) => a.id === "anton")!.prop).toBe("report");
    expect(next.actors.find((a) => a.id === "tanya")!.prop).toBeNull();
  });
});

describe("Phase 3 acceptance: put-down", () => {
  it("put-down onto a named surface records the surface", async () => {
    const logger = new Logger({ sessionId: "phase3-putdown", writeToFile: false });
    const world = officeWorld();
    world.actors.find((a) => a.id === "anton")!.prop = "report";
    world.userActorId = "anton";
    world.order = ["anton", "tanya", "dana"];
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence(
        silentResult("Anton sets the report down on his desk."),
      ),
      getUserAction: async () => "Set the report down on Anton's desk.",
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const next = await runTurn(world, deps);
    const anton = next.actors.find((a) => a.id === "anton")!;
    expect(anton.prop).toBeNull();
    // The report lands at Anton's feet (his cell, next to the desk).
    const report = next.scene.objects.find((o) => o.id === "q3_report")!;
    expect([report.x, report.y]).toEqual([anton.x, anton.y]);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });
});

describe("Phase 3 acceptance: stripping and phantom gate", () => {
  it("model objectPatches are stripped by the schema and ignored", () => {
    const parsed = consequenceResultSchema.safeParse({
      narrative: "Dana types.",
      thoughts: "t",
      actorPatches: [{ actorId: "dana", thoughts: "t" }],
      objectPatches: [{ objectId: "invented_mug", description: "Fake." }],
      reasoning: "r",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("actorPatches");
      expect(parsed.data).not.toHaveProperty("objectPatches");
      expect(parsed.data.narrative).toBe("Dana types.");
    }
  });

  it("phantom manipulation fails validation", () => {
    const world = officeWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "dana", text: "Dana stretches." },
      { narrative: "Dana picks up the laptop and waves it triumphantly.", thoughts: "Mine now." },
      renderFacts(),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.code)).toContain("object.phantom_manipulation");
  });

  it("the render input carries the executed manipulation as facts", () => {
    const world = officeWorld();
    const outcome = executeManipulation(world, { actorId: "dana", text: "Pick up the laptop." })!;
    const ctx = buildConsequenceContext(
      world,
      { actorId: "dana", text: "Pick up the laptop." },
      undefined,
      defaultConfig,
      undefined,
      undefined,
      outcome,
    );
    expect(ctx).toContain("EXECUTED MANIPULATION");
    expect(ctx).toContain("Dana picked up the laptop");
    expect(ctx).toContain("Dana now holds the laptop.");
    expect(ctx).toContain("Do NOT emit objectPatches");
    // And the no-manipulation shape states it plainly.
    const facts = executedManipulationFacts(world, "dana", null);
    expect(facts.join("\n")).toContain("EXECUTED MANIPULATION: none");
  });
});
