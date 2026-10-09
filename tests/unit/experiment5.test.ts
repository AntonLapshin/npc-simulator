// Regression tests for experiment-5.md action items 1-8
// (office-anton.json, 7 adaptive user turns, local 8B, ticks 0-20).
import { describe, expect, it } from "vitest";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import { resolveDestinationObjectId } from "../../src/engine/deterministicSemantics.js";
import {
  MAX_STEP_DISTANCE,
} from "../../src/core/movement.js";
import { computeMovementOutcome } from "../../src/core/movement.js";
import {
  consecutiveFallbacks,
  resolveRender,
  runTurn,
} from "../../src/engine/turnOrchestrator.js";
import { isPartialHistoryEntry } from "../../src/engine/patchApplier.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import {
  detectIdentityLeak,
  getOpenQuestions,
  getRecentOwnActions,
  validateSelectionForActor,
} from "../../src/engine/contextBuilder.js";
import { Logger, createTestLogger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld, hist, errorText, triedHist } from "../helpers.js";
import type { ActionSemantics, ConsequenceResult, World } from "../../src/types.js";

function baseResult(narrative = "Something happens."): ConsequenceResult {
  return { narrative, reasoning: "r" };
}

function baseFacts(over: Partial<RenderFacts> = {}): RenderFacts {
  return {
    exactQuote: null, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
    x: 1, y: 1, engineManipulation: null, ...over,
  };
}

/** Office-anton-shaped world with lamp/sign/laptop props (Exp-5 §4.3 repros). */
function antonWorldWithProps(): World {
  const world = makeTinyWorld();
  world.scene.width = 20;
  world.scene.height = 20;
  const [anton, tanya] = world.actors;
  anton!.id = "anton";
  anton!.name = "Anton";
  anton!.x = 6;
  anton!.y = 8;
  tanya!.id = "tanya";
  tanya!.name = "Tanya";
  tanya!.x = 8;
  tanya!.y = 7;
  world.actors.push({
    id: "dana", name: "Dana", persona: "Dana is a recruiter.",
    x: 15, y: 11, state: "sitting", emotion: "stressed",
    goal: "Screen candidates.", thoughts: "t", memories: [], beliefs: [], relationships: [],
  });
  world.order = ["anton", "tanya", "dana"];
  world.scene.objects.push(
    { id: "anton_desk", name: "Anton's desk", description: "A fresh desk.", x: 3, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false },
    { id: "tanya_desk", name: "Tanya's desk", description: "A desk.", x: 7, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false },
    { id: "anton_laptop", name: "Anton's laptop", description: "A new laptop.", x: 4, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    { id: "tanya_laptop", name: "Tanya's laptop", description: "An open laptop.", x: 8, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    { id: "anton_lamp", name: "Desk lamp", description: "A small desk lamp on Anton's desk.", x: 5, y: 9, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    { id: "anton_sign", name: "Anton's desk sign", description: "A name-plate reading ANTON.", x: 5, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
  );
  return world;
}

describe("exp5-3 ranked destination resolution (ticks 3/15/18/19)", () => {
  it("plural 'desks' with a grab verb in the same clause still resolves the desk (tick 18)", () => {
    const world = antonWorldWithProps();
    expect(
      resolveDestinationObjectId(
        world,
        "Thank both, head toward the west-side desks to set up laptop.",
        "anton",
      ),
    ).toBe("anton_desk");
  });

  it("'desk with ANTON sign' resolves the desk, never the lamp or sign (ticks 3/15)", () => {
    const world = antonWorldWithProps();
    expect(
      resolveDestinationObjectId(world, "Walk to the desk with the ANTON sign and sit.", "anton"),
    ).toBe("anton_desk");
  });

  it("grab-only clauses still resolve props (no walk tokens)", () => {
    const world = antonWorldWithProps();
    expect(resolveDestinationObjectId(world, "Open the laptop to set it up.", "anton")).toBe(
      "anton_laptop",
    );
  });
});

describe("exp5-4 triple-verb semantics (tick 15)", () => {
  it("bare 'open laptop' plans like 'open my laptop' (no prose luck, Phase 3)", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "u_laptop", name: "U's laptop", description: "A laptop.",
      x: 1, y: 2, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    for (const text of [
      "Sit down and open laptop to set up.",
      "Sit down and open my laptop to set up.",
    ]) {
      // Phase 3: the engine plans the laptop pick-up from either phrasing
      // (the determiner never mattered to the planner) — no model patch
      // demanded, no prose luck.
      const action = { actorId: "u", text };
      const outcome = executeManipulation(world, action);
      expect(outcome, text).not.toBeNull();
      expect(outcome!.plan.kind, text).toBe("pick-up");
      expect(outcome!.plan.propName, text).toBe("laptop");
      const errors = validateRenderProse(
        world,
        action,
        { ...baseResult("U sits down at the desk."), thoughts: "Settling in." },
        {
          ...baseFacts(),
          pose: "sit",
          effectivePose: "sit",
          engineManipulation: outcome,
        },
      );
      expect(errors, text).toEqual([]);
    }
  });

  it("'open' as an adjective never trips the gate", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Stand there with an open and welcoming demeanor." },
      { ...baseResult("U stands nearby, calm."), thoughts: "Waiting." },
      baseFacts(),
    );
    expect(errors).toEqual([]);
  });
});

describe("exp5-8 explanation pressure (ticks 14/20)", () => {
  it("an explanation narrated as silent behavior fails the topic gate", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Nod and start explaining Nadia's first task." },
      { ...baseResult("U looks up from the monitor."), thoughts: "Busy." },
      baseFacts(),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errorText(errors)).toMatch(/topic/);
  });

  it("an explanation that keeps the topic passes", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Nod and start explaining Nadia's first task." },
      {
        ...baseResult("U nods and explains the first backend task to Nadia."),
        thoughts: "Onboarding.",
      },
      baseFacts(),
    );
    expect(errors).toEqual([]);
  });

  it("'describe the layout' narrated as a greeting substitute fails", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Walk over and describe the office layout." },
      { ...baseResult("U greets Nadia warmly."), thoughts: "Going." },
      baseFacts({ moved: true, x: 2, y: 2 }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errorText(errors)).toMatch(/topic/);
  });
});



describe("exp5-5/7 selection guard (ticks 4/7/13/16/19/20)", () => {
  it("validateSelectionForActor flags POV swaps and repeats, passes clean picks", () => {
    const world = antonWorldWithProps();
    expect(validateSelectionForActor(world, "dana", "Anton walks over and introduces himself.")).toMatch(
      /identity leak/,
    );
    expect(
      validateSelectionForActor(world, "dana", "Anton plans to shadow Dana today."),
    ).toMatch(/identity leak/);
    world.history.push(hist(world, "Tanya: Shake Anton's hand warmly."));
    expect(
      validateSelectionForActor(world, "tanya", "Stand up and shake Anton's hand."),
    ).toMatch(/repetition/);
    expect(
      validateSelectionForActor(world, "tanya", "Walk to the coffee machine and pour a coffee."),
    ).toBeUndefined();
  });

  it("runTurn substitutes a clean candidate instead of burning consequence attempts", async () => {
    const logger = new Logger({ sessionId: "exp5-guard", writeToFile: false });
    const world = makeTinyWorld();
    world.userActorId = "u";
    world.turnIndex = 1; // N's turn
    world.history.push(hist(world, "N: Shake U's hand warmly."));
    const { MockProposalEngine } = await import("../../src/mocks/mockProposalEngine.js");
    const { MockSelectionEngine } = await import("../../src/mocks/mockSelectionEngine.js");
    const { MockConsequenceEngine } = await import("../../src/mocks/mockConsequenceEngine.js");
    const deps = makeTestDeps(logger, {
      proposalEngine: new MockProposalEngine(logger, {
        [`n@tick0`]: {
          suggestions: ["Stand up and shake U's hand.", "Stay at the desk and continue working."],
          reasoning: "scripted",
        },
      }),
      selectionEngine: new MockSelectionEngine(logger, {
        [`n@tick0`]: { action: "Stand up and shake U's hand.", reasoning: "scripted repeat" },
      }),
      consequenceEngine: new MockConsequenceEngine(logger),
    });
    const next = await runTurn(world, deps);
    expect(logger.store.byEvent("selection_rejected")).toHaveLength(1);
    expect(logger.store.byEvent("selection_substituted")).toHaveLength(1);
    expect(next.history.at(-1)!.text).toContain("Stay at the desk and continue working.");
  });
});

describe("exp5-6 NPC liveness floor (Tanya 7 / Dana 7 fallbacks)", () => {
  function fallenWorld(): World {
    const world = makeTinyWorld();
    world.userActorId = "u";
    // N fell back 3 consecutive own turns (interleaved with U's applied turns).
    world.history.push(
      triedHist(world, "N tried: Stand up and walk over."),
      hist(world, "U: Wave."),
      triedHist(world, "N tried: Stand up and walk over."),
      hist(world, "U: Wave."),
      triedHist(world, "N tried: Stand up and walk over."),
    );
    return world;
  }

  it("consecutiveFallbacks counts own streaks, ignoring interleaved actors", () => {
    const world = fallenWorld();
    expect(consecutiveFallbacks(world, "n")).toBe(3);
    expect(consecutiveFallbacks(world, "u")).toBe(0);
    world.history.push(hist(world, "N: Stay at the desk and continue working."));
    expect(consecutiveFallbacks(world, "n")).toBe(0);
  });

  it("resolveRender applies liveness instead of a 4th fallback (NPC only)", async () => {
    const logger = new Logger({ sessionId: "exp5-liveness", writeToFile: false });
    // Unrepairable: unknown actor in a person-context position, both attempts.
    const bad: ConsequenceResult = { narrative: "N waves at Liam.", reasoning: "bad" };
    const deps = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(bad) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const out = await resolveRender(fallenWorld(), { actorId: "n", text: "Wait quietly." }, deps);
    expect(out.liveness).toBe(true);
    expect(out.render.narrative).toContain("holds position");
    expect(logger.store.byEvent("liveness_applied")).toHaveLength(1);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });

  it("user turns still fall back (never rewritten)", async () => {
    const logger = new Logger({ sessionId: "exp5-liveness-user", writeToFile: false });
    const world = fallenWorld();
    world.history.push(
      triedHist(world, "U tried: Walk over."),
      triedHist(world, "U tried: Walk over."),
      triedHist(world, "U tried: Walk over."),
    );
    const bad: ConsequenceResult = { narrative: "U waves at Liam.", reasoning: "bad" };
    const deps = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(bad) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const out = await resolveRender(
      world,
      { actorId: "u", text: "Wait quietly." },
      deps,
      { allowLiveness: false },
    );
    expect(out.liveness).toBe(false);
    expect(out.render.narrative).toBe("Nothing changes.");
  });
});
