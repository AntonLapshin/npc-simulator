// Golden replay of the office-anton incident log (refactor plan Phase 4).
//
// The logged run needed 8 validation failures + 2 fallbacks across 3 turns:
// the task-resuming actions of ticks 1-2 ("... then return to typing ...",
// "... returning to staring at the monitor ...") were misread as locomotion
// by regex heuristics. Replayed through the SemanticJudge + self-declared
// effects path, all three ticks validate on attempt 1 with zero retries.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTurns } from "../../src/engine/turnOrchestrator.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { Logger } from "../../src/logging/logger.js";
import { MockProposalEngine } from "../../src/mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../../src/mocks/mockSelectionEngine.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import { defaultConfig } from "../../src/config.js";
import type { World } from "../../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadOfficeAntonScenario(): World {
  const raw = JSON.parse(readFileSync(join(here, "../../scenarios/office-anton.json"), "utf-8"));
  return loadScenario(raw);
}

// Exact action texts from logs/text_muvv0smo.jsonl (ticks 1-2).
const TANYA_ACTION =
  "Call out a friendly 'Hey!' as she sees Anton, then return to typing, an open and welcoming demeanor still present even with full focus on the task at hand.";
const DANA_ACTION =
  "Sighs, rubs temples, and mutters 'Just a few more minutes...' before returning to staring at the monitor, trying to refocus.";

describe("golden office-anton replay", () => {
  it("ticks 1-2 validate without x/y and without retries", async () => {
    const logger = new Logger({ sessionId: "golden_office_anton", writeToFile: false });

    const proposalEngine = new MockProposalEngine(logger, {
      "tanya@tick1": {
        suggestions: [TANYA_ACTION, "Stay at the desk and continue working."],
        reasoning: "Tanya noticed Anton and greets him while staying focused.",
      },
      "dana@tick2": {
        suggestions: [DANA_ACTION, "Keep working."],
        reasoning: "Dana is stressed and stays focused on urgent work.",
      },
    });

    const selectionEngine = new MockSelectionEngine(logger, {
      // Echoed candidate numbering exercises the stripSelectionPrefix guard.
      "tanya@tick1": {
        action: `3. ${TANYA_ACTION}`,
        reasoning: "Tanya greets Anton briefly without leaving her desk.",
      },
      "dana@tick2": {
        action: DANA_ACTION,
        reasoning: "Dana stays focused on the urgent draft.",
      },
    });

    const consequenceEngine = new MockConsequenceEngine(logger, {
      "greetings all!": {
        narrative: 'Anton says "Greetings all!" to the room.',
        actorPatches: [
          {
            actorId: "anton",
            thoughts: "Hope that came across well.",
            memoriesAppend: ["Greeted the office."],
          },
          { actorId: "tanya", thoughts: "A new coworker — I should say hi." },
          { actorId: "dana", thoughts: "Someone new. Back to work." },
        ],
        objectPatches: [],
        reasoning: "Anton spoke in a shared room; everyone nearby perceives it.",
        effects: { moved: false, spoke: true },
      },
      [TANYA_ACTION.toLowerCase()]: {
        narrative: "Tanya calls out a friendly 'Hey!' as she sees Anton, then returns to typing.",
        actorPatches: [
          {
            actorId: "tanya",
            thoughts: "Welcomed Anton without losing focus.",
            memoriesAppend: ["Greeted Anton, then kept typing."],
          },
          { actorId: "anton", thoughts: "Tanya seems welcoming." },
        ],
        objectPatches: [],
        reasoning: "A greeting plus resumed typing; no locomotion occurred.",
        effects: { moved: false, spoke: true, quotedSpeech: ["Hey!"] },
      },
      [DANA_ACTION.toLowerCase()]: {
        narrative:
          "Dana sighs, rubs his temples, and mutters 'Just a few more minutes...' before returning to staring at the monitor.",
        actorPatches: [
          {
            actorId: "dana",
            thoughts: "Almost done with this draft.",
            memoriesAppend: ["Muttered while refocusing on the draft."],
          },
        ],
        objectPatches: [],
        reasoning: "An in-place mutter plus resumed staring; no locomotion occurred.",
        effects: { moved: false, spoke: true, quotedSpeech: ["Just a few more minutes..."] },
      },
    });

    const final = await runTurns(
      loadOfficeAntonScenario(),
      {
        proposalEngine,
        selectionEngine,
        consequenceEngine,
        logger,
        config: { ...defaultConfig, autosaveEnabled: false },
        getUserAction: async () => "Greetings all!",
      },
      3,
    );

    // Nobody moved: task-resuming actions need no x/y change.
    const byId = Object.fromEntries(final.actors.map((a) => [a.id, a]));
    expect([byId["anton"]!.x, byId["anton"]!.y]).toEqual([16, 2]);
    expect([byId["tanya"]!.x, byId["tanya"]!.y]).toEqual([8, 7]);
    expect([byId["dana"]!.x, byId["dana"]!.y]).toEqual([15, 11]);

    expect(final.history).toHaveLength(3);
    expect(final.history[1]).toContain("Call out a friendly");
    expect(final.history[2]).toContain("few more minutes");

    // Zero retries: every tick validated on attempt 1.
    const events = logger.store.events();
    expect(logger.store.byEvent("validation_failed")).toHaveLength(0);
    expect(events).not.toContain("retry_started");
    expect(events).not.toContain("fallback_used");
    expect(logger.store.byEvent("validation_passed")).toHaveLength(3);
    // Effects declarations agree with the independent (mock) judge, so the
    // merged semantics keep source "effects" on all three ticks.
    expect(logger.store.byEvent("semantic_resolved")).toHaveLength(3);
  });
});
