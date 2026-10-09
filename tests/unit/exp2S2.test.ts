// Regression tests for Experiment-2 items 5 (S2) and 7 (S1/S7).
//
// S2: two fully-corrupt consequences passed the old `validateConsequence`
// outright in the Exp-2 run —
//   tick 10: "Ana: Jeff introduces Ana to Dan." for a silent coffee sip
//            (observer-as-subject hid behind the "Ana: " attribution
//            prefix, and "introduces" is missing from the validator's
//            verb list);
//   tick 11: "Dan walks into the conference room…" for "Stay where you
//            are" (self-declared effects.moved=true dodged
//            movement.unexpected_move through the merged-semantics OR-trust).
// Phase 4: the render contract has no patches and no self-declared
// effects — `validateRenderProse` rejects both corrupt narratives
// directly, and the turn falls back after the single prose retry.
import { describe, expect, it } from "vitest";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import {
  findSupplementObserverSubject,
  isExplicitStayAction,
  stripAttributionPrefix,
} from "../../src/engine/validate/narrative.js";
import { resolveRender } from "../../src/engine/turnOrchestrator.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import { defaultConfig } from "../../src/config.js";
import { loadOfficeScenario, makeTestDeps } from "../helpers.js";
import type { ConsequenceResult, World } from "../../src/types.js";

function facts(over: Partial<RenderFacts> = {}): RenderFacts {
  return {
    exactQuote: null, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
    x: 7, y: 8, engineManipulation: null, ...over,
  };
}

function officeWorld(): World {
  const world = loadOfficeScenario();
  // Exp-2 tick-10/11 positions: Ana near her desk, Dan across the room.
  world.actors.find((a) => a.id === "ana")!.x = 7;
  world.actors.find((a) => a.id === "ana")!.y = 8;
  world.actors.find((a) => a.id === "dan")!.x = 15;
  world.actors.find((a) => a.id === "dan")!.y = 8;
  return world;
}

describe("exp2-5 S2 final accept gate: tick-10 wrong-subject narrative", () => {
  const action = { actorId: "ana", text: "Take a quiet sip of coffee." };
  const corrupt: ConsequenceResult = {
    narrative: "Ana: Jeff introduces Ana to Dan.",
    thoughts: "Sipping coffee.",
    reasoning: "r",
  };

  it("rejects the Jeff-subject narrative for a silent sip action", () => {
    const world = officeWorld();
    const errors = validateRenderProse(world, action, corrupt, facts());
    expect(errors.some((e) => e.code === "narrative.observer_as_subject")).toBe(true);
  });

  it("also catches the unprefixed form (introduces not in the validator verb list)", () => {
    const world = officeWorld();
    const noPrefix = { ...corrupt, narrative: "Jeff introduces Ana to Dan." };
    const errors = validateRenderProse(world, action, noPrefix, facts());
    expect(errors.some((e) => e.code === "narrative.observer_as_subject")).toBe(true);
  });

  it("does not false-positive on clean prose with observer landmarks", () => {
    const world = officeWorld();
    const clean: ConsequenceResult = {
      ...corrupt,
      narrative: "Ana takes a quiet sip of her coffee, watching Jeff and Dan.",
      thoughts: "Good coffee.",
    };
    expect(validateRenderProse(world, action, clean, facts())).toEqual([]);
  });

  it("does not false-positive on possessives", () => {
    const world = officeWorld();
    const possessive = { ...corrupt, narrative: "Ana: Jeff's desk is cluttered today." };
    expect(validateRenderProse(world, action, possessive, facts())).toEqual([]);
  });
});

describe("exp2-5 S2 final accept gate: tick-11 stay-action teleport", () => {
  const action = { actorId: "dan", text: "Stay where you are." };

  it("rejects movement narration on an explicit stay action", () => {
    const world = officeWorld();
    expect(isExplicitStayAction(action.text)).toBe(true);
    // Phase 4: the engine is the source of truth for movement — the model
    // cannot self-declare moved=true anymore, so the stay-teleport
    // surfaces as narrated-without-move.
    const errors = validateRenderProse(
      world,
      action,
      {
        narrative: "Dan walks into the conference room and greets everyone.",
        thoughts: "Time to mingle.",
        reasoning: "r",
      },
      facts({ x: 15, y: 8 }),
    );
    expect(errors.some((e) => e.code === "movement.narrated_without_move")).toBe(true);
  });

  it("end-to-end: the stay-teleport narrative is marked but never applied", async () => {
    const logger = createTestLogger();
    const world = officeWorld();
    const scripted: ConsequenceResult = {
      narrative: "Dan walks into the conference room and greets everyone.",
      thoughts: "Time to mingle.",
      reasoning: "r",
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: new MockConsequenceEngine(logger, {
        "stay where you are.": scripted,
      }),
      config: { ...defaultConfig, autosaveEnabled: false, maxRetries: 1 },
    });
    const out = await resolveRender(world, action, deps);
    // PLAN_V2 Phase 4: the flawed paragraph is accepted and marked honest —
    // but it is never APPLIED: Dan never moved.
    expect(out.render.narrateAcceptedDespiteViolations).toBe(true);
    expect(world.actors.find((a) => a.id === "dan")!.x).toBe(15);
  });
});

describe("exp2-5 attribution prefix stripping", () => {
  it("strips the acting actor's Name: prefix, never an observer's", () => {
    expect(stripAttributionPrefix("Ana: Jeff introduces Ana to Dan.", "Ana", "ana")).toBe(
      "Jeff introduces Ana to Dan.",
    );
    expect(stripAttributionPrefix("ana - takes a sip.", "Ana", "ana")).toBe("takes a sip.");
    expect(stripAttributionPrefix("Jeff: hello there.", "Ana", "ana")).toBe(
      "Jeff: hello there.",
    );
    expect(stripAttributionPrefix("Ana stands up.", "Ana", "ana")).toBe("Ana stands up.");
  });

  it("the stripped narrative exposes observer subjects to the validator list too", () => {
    const world = officeWorld();
    const action = { actorId: "ana", text: "Take a quiet sip of coffee." };
    // "greets" IS in the validator's verb list — the only hole was the prefix.
    const errors = findSupplementObserverSubject(
      world,
      stripAttributionPrefix("Ana: Jeff greets Dan.", "Ana", "ana"),
      action,
    );
    expect(errors.some((e) => e.code === "narrative.observer_as_subject")).toBe(true);
  });
});
