import { describe, expect, it } from "vitest";
import { runTurns } from "../../src/engine/turnOrchestrator.js";
import { Logger } from "../../src/logging/logger.js";
import { MockProposalEngine } from "../../src/mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../../src/mocks/mockSelectionEngine.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import { defaultConfig } from "../../src/config.js";
import { loadOfficeScenario } from "../helpers.js";

// Deterministic golden run of the office scenario (plan §13):
// Jeff introduces himself -> Ana walks over -> Dan keeps working.
describe("golden office scenario", () => {
  it("runs three turns deterministically with mocks", async () => {
    const logger = new Logger({ sessionId: "golden_office", writeToFile: false });

    const proposalEngine = new MockProposalEngine(logger, {
      "ana@tick1": {
        suggestions: [
          "Stay at the desk and continue working.",
          "Say hello to Jeff from the desk.",
          "Walk over to Jeff and welcome him.",
          "Ask Jeff whether he needs help finding his desk.",
        ],
        reasoning: "Ana has noticed Jeff and her persona makes her inclined to greet him.",
      },
      "dan@tick2": {
        suggestions: [
          "Keep working.",
          "Briefly acknowledge Jeff from the desk.",
          "Tell everyone that he is busy.",
          "Ignore the introduction.",
        ],
        reasoning: "Dan is stressed and focused on urgent work.",
      },
    });

    const selectionEngine = new MockSelectionEngine(logger, {
      "ana@tick1": {
        action: "Walk over to Jeff and welcome him.",
        reasoning: "Ana chooses to greet the new coworker directly.",
      },
      "dan@tick2": {
        action: "Keep working and do not interrupt the design task.",
        reasoning: "Dan prioritizes the urgent design draft over social interaction.",
      },
    });

    const consequenceEngine = new MockConsequenceEngine(logger, {
      // Phase 4: prose-only scripts. Movement is engine-executed; the
      // narrative narrates the executed facts (no coordinates, no invented
      // pose changes, no observer thought patches).
      "hey guys, i'm a new team member, my name is jeff!": {
        narrative:
          "Jeff speaks aloud to the office: \"Hey guys, I'm a new team member, my name is Jeff!\"",
        thoughts: "Hope they take it well.",
        emotion: "nervous",
        reasoning: "Jeff spoke in a normal indoor environment.",
      },
      "walk over to jeff and welcome him.": {
        narrative: "Ana walks toward Jeff and stops near him.",
        thoughts: "Hope Jeff feels welcome.",
        emotion: "friendly",
        reasoning: "Ana moves closer to Jeff; the engine executes the movement.",
      },
      "keep working and do not interrupt the design task.": {
        narrative: "Dan remains at his desk and continues working.",
        thoughts: "This draft cannot wait.",
        emotion: "stressed",
        reasoning: "Dan maintains his current physical position and task focus.",
      },
    });

    const world0 = loadOfficeScenario();
    const final = await runTurns(
      world0,
      {
        proposalEngine,
        selectionEngine,
        consequenceEngine,
        logger,
        config: { ...defaultConfig, autosaveEnabled: false },
        getUserAction: async () => "Hey guys, I'm a new team member, my name is Jeff!",
      },
      3,
    );

    const byId = Object.fromEntries(final.actors.map((a) => [a.id, a]));
    const jeff = byId["jeff"]!;
    const ana = byId["ana"]!;
    const dan = byId["dan"]!;

    // Final actor positions. Phase 1: the model never emits coordinates —
    // the engine computes the optimal step toward Jeff (8,8)→(3,10),
    // strictly closer to Jeff than the model's old (3,9) patch.
    expect([ana.x, ana.y]).toEqual([3, 10]);
    expect([jeff.x, jeff.y]).toEqual([1, 10]);
    expect([dan.x, dan.y]).toEqual([15, 8]);

    // Emotions come from the render prose (acting actor only).
    expect(jeff.emotion).toBe("nervous");
    expect(ana.emotion).toBe("friendly");
    expect(dan.emotion).toBe("stressed");
    // Phase 4: no model patches — goals and object states are untouched.
    expect(ana.goal).toBe("Finish a small engineering task before lunch.");
    const door = final.scene.objects.find((o) => o.id === "door")!;
    expect(door.description).toBe("The office entrance door. It is open.");

    // Memories are the deterministic narrative line (acting actor only).
    expect(jeff.memories.at(-1)).toContain("Jeff speaks aloud to the office");
    expect(ana.memories.at(-1)).toContain("Ana walks toward Jeff");
    expect(dan.memories.at(-1)).toContain("Dan remains at his desk");
    // Phase 4: observers get no per-turn thought patches — each actor's
    // thoughts come only from their own turn's prose.
    expect(dan.thoughts).toBe("This draft cannot wait.");
    expect(jeff.thoughts).toBe("Hope they take it well.");

    // World history: 1 tickless entry per turn x 3 turns.
    // Q1: clean turns record the consequence narrative, not the action text.
    expect(final.history).toHaveLength(3);
    expect(final.history[0]!.text).toContain("Jeff: Jeff speaks aloud to the office:");
    expect(final.history[0]!.text).not.toMatch(/^Tick \d+ - /);
    expect(final.history[1]!.text).toContain("Ana: Ana walks toward Jeff and stops near him.");
    expect(final.history[2]!.text).toContain("Dan: Dan remains at his desk and continues working.");

    // Tick / turn advancement: 3 ticks, wraps back to jeff.
    expect(final.tick).toBe(3);
    expect(final.order[final.turnIndex]).toBe("jeff");

    // Complete log sequence contains the full per-turn chain.
    const events = logger.store.events();
    for (const expected of [
      "turn_started",
      "proposal_started",
      "proposal_completed",
      "useractionsubmitted",
      "selection_started",
      "selection_completed",
      "consequence_started",
      "consequence_completed",
      "render_accepted",
      "patch_applied",
      "history_appended",
      "turn_completed",
    ]) {
      expect(events, `missing log event ${expected}`).toContain(expected);
    }
    // No retries or fallbacks in the golden path.
    expect(events).not.toContain("render_failed");
    expect(events).not.toContain("fallback_used");
  });
});
