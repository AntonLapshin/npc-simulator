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
      "hey guys, i'm a new team member, my name is jeff!": {
        narrative:
          "Jeff speaks aloud to the office: \"Hey guys, I'm a new team member, my name is Jeff!\"",
        actorPatches: [
          {
            actorId: "jeff",
            emotion: "nervous",
            state: "standing near the entrance after introducing himself",
            memoriesAppend: ["Introduced himself aloud to the office."],
            relationshipsAppend: ["Jeff has attempted to introduce himself to Ana and Dan."],
          },
          {
            actorId: "ana",
            emotion: "curious",
            // F5: observers may update their OWN goal, never another
            // actor's — no goal patch for Ana on Jeff's turn.
            memoriesAppend: ["Heard Jeff introduce himself as a new team member."],
            beliefsAppend: ["Jeff is a new team member.", "Jeff's name is Jeff."],
            relationshipsAppend: ["Ana has just become aware of Jeff."],
          },
          {
            actorId: "dan",
            emotion: "annoyed",
            memoriesAppend: ["Heard Jeff introduce himself while trying to finish urgent work."],
            beliefsAppend: ["Jeff is a new team member."],
            relationshipsAppend: ["Dan associates Jeff's arrival with an interruption."],
          },
        ],
        objectPatches: [],
        reasoning:
          "Jeff spoke in a normal indoor environment. Ana and Dan are close enough and not separated by sound-blocking objects.",
      },
      "walk over to jeff and welcome him.": {
        narrative: "Ana stands up from her desk, walks toward Jeff, and stops near him.",
        actorPatches: [
          {
            actorId: "ana",
            x: 3,
            y: 9,
            state: "standing near Jeff",
            emotion: "friendly",
            pose: "stand",
            memoriesAppend: ["Walked over to Jeff after hearing his introduction."],
            relationshipsAppend: ["Ana approached Jeff in a friendly way."],
          },
          {
            actorId: "jeff",
            emotion: "hopeful",
            memoriesAppend: ["Saw Ana walk toward him."],
            relationshipsAppend: ["Jeff perceives Ana as welcoming."],
          },
          {
            actorId: "dan",
            memoriesAppend: ["Noticed that Ana got up from her desk."],
          },
        ],
        objectPatches: [],
        reasoning: "Ana moves close enough to Jeff for direct social interaction.",
      },
      "keep working and do not interrupt the design task.": {
        narrative: "Dan remains at his desk and continues working.",
        actorPatches: [
          {
            actorId: "dan",
            state: "sitting at his desk and continuing to work",
            emotion: "stressed",
            memoriesAppend: ["Chose to keep working instead of greeting Jeff."],
          },
          {
            actorId: "jeff",
            memoriesAppend: ["Noticed that Dan remained at his desk."],
          },
        ],
        objectPatches: [],
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

    // Final actor positions.
    expect([ana.x, ana.y]).toEqual([3, 9]);
    expect([jeff.x, jeff.y]).toEqual([1, 10]);
    expect([dan.x, dan.y]).toEqual([15, 8]);

    // Final emotions / goals / states.
    expect(jeff.emotion).toBe("hopeful");
    expect(ana.emotion).toBe("friendly");
    // F5: Ana's goal patch from Jeff's turn is rejected — she keeps her
    // scenario goal; observers update only their own goal.
    expect(ana.goal).toBe("Finish a small engineering task before lunch.");
    expect(ana.state).toBe("standing near Jeff");
    expect(dan.emotion).toBe("stressed");
    expect(dan.state).toBe("sitting at his desk and continuing to work");

    // Memories / beliefs / relationships.
    expect(jeff.memories).toContain("Introduced himself aloud to the office.");
    expect(jeff.memories).toContain("Saw Ana walk toward him.");
    expect(ana.beliefs).toContain("Jeff is a new team member.");
    expect(dan.beliefs).toContain("Jeff is a new team member.");
    expect(ana.relationships).toContain("Ana has just become aware of Jeff.");
    expect(dan.relationships).toContain("Dan associates Jeff's arrival with an interruption.");

    // Object states unchanged.
    const door = final.scene.objects.find((o) => o.id === "door")!;
    expect(door.description).toBe("The office entrance door. It is open.");

    // World history: 1 tickless entry per turn x 3 turns.
    // Q1: clean turns record the consequence narrative, not the action text.
    expect(final.history).toHaveLength(3);
    expect(final.history[0]!.text).toContain("Jeff: Jeff speaks aloud to the office:");
    expect(final.history[0]!.text).not.toMatch(/^Tick \d+ - /);
    expect(final.history[1]!.text).toContain("Ana: Ana stands up from her desk, walks toward Jeff");
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
      "validation_started",
      "validation_passed",
      "patch_applied",
      "history_appended",
      "turn_completed",
    ]) {
      expect(events, `missing log event ${expected}`).toContain(expected);
    }
    // No retries or fallbacks in the golden path.
    expect(events).not.toContain("validation_failed");
    expect(events).not.toContain("fallback_used");
  });
});
