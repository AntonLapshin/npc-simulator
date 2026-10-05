import { describe, expect, it } from "vitest";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { applyConsequence } from "../../src/engine/patchApplier.js";
import { validateConsequence } from "../../src/engine/physicalValidator.js";
import {
  buildConsequenceContext,
  buildProposalContext,
  buildSelectionContext,
} from "../../src/engine/contextBuilder.js";
import { runTurn } from "../../src/engine/turnOrchestrator.js";
import type { TurnProgressEvent } from "../../src/engine/turnOrchestrator.js";
import { makeTestDeps, makeTinyWorld } from "../helpers.js";
import { Logger } from "../../src/logging/logger.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import type { ConsequenceResult } from "../../src/types.js";

function observerMoveResult(): ConsequenceResult {
  return {
    narrative: "U waves. N walks over and says hello back.",
    actorPatches: [
      { actorId: "u", thoughts: "I greeted the room." },
      { actorId: "n", x: 2, y: 2, state: "walking over to U", thoughts: "Oh, hello!" },
    ],
    objectPatches: [],
    reasoning: "observer acts out of turn",
  };
}

describe("thoughts field", () => {
  it("defaults to empty string for legacy scenarios without the field", () => {
    const world = makeTinyWorld();
    for (const actor of world.actors) {
      expect(actor.thoughts).toBe("");
    }
  });

  it("patchApplier replaces thoughts", () => {
    const world = makeTinyWorld();
    const next = applyConsequence(
      world,
      {
        narrative: "U speaks.",
        actorPatches: [{ actorId: "n", thoughts: "Oh, someone spoke!" }],
        objectPatches: [],
        reasoning: "r",
      },
      { actorId: "u", text: "Hi!" },
    );
    expect(next.actors.find((a) => a.id === "n")!.thoughts).toBe("Oh, someone spoke!");
    // Acting actor untouched when no patch mentions it.
    expect(next.actors.find((a) => a.id === "u")!.thoughts).toBe("");
  });

  it("proposal and selection contexts include the actor's thoughts", () => {
    const world = makeTinyWorld();
    const target = world.actors.find((a) => a.id === "n")!;
    target.thoughts = "That greeting surprised me.";
    expect(buildProposalContext(world, "n")).toContain("That greeting surprised me.");
    expect(buildSelectionContext(world, "n", ["Wave back."])).toContain("That greeting surprised me.");
  });
});

describe("turn discipline", () => {
  it("rejects observer movement and state changes, accepts internal reactions", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Hi!" };

    const bad = validateConsequence(world, observerMoveResult(), action);
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(" ")).toMatch(/only the acting actor/);

    const observerStateOnly: ConsequenceResult = {
      narrative: "U waves.",
      actorPatches: [{ actorId: "n", state: "waving back" }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, observerStateOnly, action).valid).toBe(false);

    const internalOnly: ConsequenceResult = {
      narrative: "U waves across the room. N hears it.",
      actorPatches: [
        {
          actorId: "n",
          thoughts: "Oh, U is greeting everyone. I am busy though.",
          emotion: "distracted",
          memoriesAppend: ["Heard U greet the room."],
          beliefsAppend: ["U is friendly."],
        },
      ],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, internalOnly, action)).toEqual({ valid: true, errors: [] });
  });

  it("still allows the acting actor to move and change state", () => {
    const world = makeTinyWorld();
    const result: ConsequenceResult = {
      narrative: "U walks across the room.",
      actorPatches: [{ actorId: "u", x: 2, y: 1, state: "walking", thoughts: "Going to say hi." }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, result, { actorId: "u", text: "Walk." })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("consequence context instructs observers to use thoughts, not actions", () => {
    const world = makeTinyWorld();
    const ctx = buildConsequenceContext(world, { actorId: "u", text: "Hi!" });
    expect(ctx).toContain("Acting actor this turn: u");
    expect(ctx).toContain("MUST NOT speak");
    expect(ctx).toContain("MUST NOT move");
    expect(ctx).toContain("'thoughts'");
  });

  it("an out-of-turn observer action triggers retry then fallback", async () => {
    const logger = new Logger({ sessionId: "discipline", writeToFile: false });
    const consequenceEngine = new MockConsequenceEngine(logger, {
      "hi!": observerMoveResult(),
    });
    const deps = makeTestDeps(logger, {
      consequenceEngine,
      getUserAction: async () => "Hi!",
    });
    const world = await runTurn(makeTinyWorld(), deps);
    expect(logger.store.byEvent("validation_failed").length).toBeGreaterThanOrEqual(1);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(1);
    expect(world.history[world.history.length - 1]).toContain("Hi!");
    expect(logger.store.byEvent("fallback_used")[0]!.output).toMatchObject({ narrative: "Nothing changes." });
  });
});

describe("turn progress reporting", () => {
  it("emits agentic-style stages for loading indicators", async () => {
    const logger = new Logger({ sessionId: "progress", writeToFile: false });
    const events: TurnProgressEvent[] = [];
    const deps = makeTestDeps(logger, {
      getUserAction: async () => "Hello there.",
      onProgress: (e) => events.push(e),
    });
    await runTurn(makeTinyWorld(), deps);
    const stages = events.map((e) => e.stage);
    // User turns skip proposal (proposal_skipped is logged, proposal_done
    // reported) — no proposal_started stage for the user.
    expect(stages).toContain("proposal_done");
    expect(stages).toContain("consequence_started");
    expect(stages).toContain("turn_completed");
    for (const e of events) {
      expect(e.message.length).toBeGreaterThan(0);
      expect(e.actorId.length).toBeGreaterThan(0);
    }
  });

  it("loads legacy scenario saves without thoughts (backward compatible)", () => {
    const raw = {
      version: 1,
      id: "legacy",
      title: "Legacy",
      narrative: "N.",
      userActorId: "a",
      order: ["a"],
      scene: { width: 4, height: 4, objects: [] },
      actors: [
        {
          id: "a", name: "A", persona: "p", x: 1, y: 1,
          state: "s", emotion: "e", goal: "g",
          memories: [], beliefs: [], relationships: [],
        },
      ],
    };
    const world = loadScenario(raw);
    expect(world.actors[0]!.thoughts).toBe("");
  });
});
