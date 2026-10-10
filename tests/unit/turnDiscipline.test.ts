import { describe, expect, it } from "vitest";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { applyRenderResult } from "../../src/engine/patchApplier.js";
import { validateRenderProse } from "../../src/engine/validate/render.js";
import {
  buildNarrateContext,
} from "../../src/engine/contextBuilder.js";
import { runTurn } from "../../src/engine/turnOrchestrator.js";
import type { TurnProgressEvent } from "../../src/engine/turnOrchestrator.js";
import { makeTestDeps, makeTinyWorld, errorText } from "../helpers.js";
import { Logger } from "../../src/logging/logger.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import type { ConsequenceResult } from "../../src/types.js";

function observerSubjectResult(): ConsequenceResult {
  return {
    narrative: "Nadia walks over and says hello back.",
    thoughts: "That went well.",
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

  it("applyRenderResult replaces the acting actor's thoughts from prose", () => {
    const world = makeTinyWorld();
    const next = applyRenderResult(
      world,
      { actorId: "u", text: "Hi!" },
      { narrative: "U speaks.", thoughts: "Hope that landed.", reasoning: "r" },
      { movement: null, pose: null, manipulation: null },
    );
    expect(next.actors.find((a) => a.id === "u")!.thoughts).toBe("Hope that landed.");
    // Observers are never touched by the prose: their response belongs to
    // their own turn.
    expect(next.actors.find((a) => a.id === "n")!.thoughts).toBe("");
  });
});

describe("turn discipline", () => {
  it("rejects observer-as-subject prose, accepts acting-actor prose", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const action = { actorId: "u", text: "Hi!" };
    const facts = {
      exactQuote: null, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
      x: 1, y: 1, engineManipulation: null,
    };

    const bad = validateRenderProse(world, action, observerSubjectResult(), facts);
    expect(bad.length).toBeGreaterThan(0);
    expect(errorText(bad)).toMatch(/narrative\.observer_as_subject/);

    const good = validateRenderProse(
      world,
      action,
      { narrative: "U waves at Nadia.", thoughts: "Friendly." },
      facts,
    );
    expect(good).toEqual([]);
  });

  it("still allows the engine to move the acting actor", () => {
    const world = makeTinyWorld();
    const next = applyRenderResult(
      world,
      { actorId: "u", text: "Walk." },
      { narrative: "U walks across the room.", reasoning: "r" },
      {
        movement: {
          from: { x: 1, y: 1 }, x: 2, y: 1,
          path: [{ x: 2, y: 1 }],
          destination: null,
        },
        pose: null,
        manipulation: null,
      },
    );
    expect(next.actors.find((a) => a.id === "u")!.x).toBe(2);
  });

  it("narrate context instructs observers to use thoughts, not actions", () => {
    const world = makeTinyWorld();
    const ctx = buildNarrateContext(world, { actorId: "u", text: "Hi!" }, undefined, {});
    expect(ctx).toContain("Describe ONLY the acting actor's directly observable behavior");
    expect(ctx).toContain("Observers react in their own thoughts, on their own turns");
  });

  it("an out-of-turn observer action triggers retry then accept-and-mark", async () => {
    const logger = new Logger({ sessionId: "discipline", writeToFile: false });
    const consequenceEngine = new MockConsequenceEngine(logger, {
      "hi!": observerSubjectResult(),
    });
    const deps = makeTestDeps(logger, {
      consequenceEngine,
      getUserAction: async () => "Hi!",
    });
    // Single-letter names never trigger the observer-subject gate
    // (false-positive guard), so the observer gets a full name.
    const renamed = makeTinyWorld();
    renamed.actors.find((a) => a.id === "n")!.name = "Nadia";
    const final = await runTurn(renamed, deps);
    expect(logger.store.byEvent("render_failed").length).toBeGreaterThanOrEqual(1);
    // PLAN_V2 Phase 4: one retry, then accept-and-mark honest — no fallback.
    expect(logger.store.byEvent("narrate_accepted_despite_violations")).toHaveLength(1);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    // The accepted (flawed) paragraph is what lands in history.
    expect(final.history[final.history.length - 1]!.text).toContain("Nadia walks over");
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
