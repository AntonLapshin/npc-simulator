// Golden replay of the office-anton incident log (refactor plan Phase 4).
//
// The logged run needed 8 validation failures + 2 fallbacks across 3 turns:
// the task-resuming actions of ticks 1-2 ("... then return to typing ...",
// "... returning to staring at the monitor ...") were misread as locomotion
// by regex heuristics. Replayed with engine-owned movement (Phase 1: the
// resumed-activity mask), all three ticks validate on attempt 1 with zero
// retries.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTurns } from "../../src/engine/turnOrchestrator.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { Logger } from "../../src/logging/logger.js";
import { MockIntentEngine } from "../../src/mocks/mockIntentEngine.js";
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
  it("ticks 1-2 render clean on attempt 1", async () => {
    const logger = new Logger({ sessionId: "golden_office_anton", writeToFile: false });

    // PLAN_V2 Phase 6: one intent call decides each NPC turn directly.
    // Echoed candidate numbering exercises the stripSelectionPrefix guard.
    const intentEngine = new MockIntentEngine(logger, {
      "tanya@tick1": {
        action: `3. ${TANYA_ACTION}`,
        quote: "",
      },
      "dana@tick2": {
        action: DANA_ACTION,
        quote: "",
      },
    });

    const consequenceEngine = new MockConsequenceEngine(logger, {
      // Phase 4: prose-only scripts. Task-resuming actions imply no
      // movement (the engine's resumed-activity mask); quotes are
      // engine-dictated verbatim contracts.
      "greetings all!": {
        narrative: 'Anton says "Greetings all!" to the room.',
        thoughts: "Hope that came across well.",
        emotion: "hopeful",
        reasoning: "Anton spoke in a shared room.",
      },
      [TANYA_ACTION.toLowerCase()]: {
        narrative: "Tanya calls out a friendly 'Hey!' as she sees Anton, then returns to typing.",
        thoughts: "Welcomed Anton without losing focus.",
        emotion: "welcoming",
        reasoning: "A greeting plus resumed typing; no locomotion occurred.",
      },
      [DANA_ACTION.toLowerCase()]: {
        narrative:
          "Dana sighs, rubs his temples, and mutters 'Just a few more minutes...' before returning to staring at the monitor.",
        thoughts: "Almost done with this draft.",
        emotion: "stressed",
        reasoning: "An in-place mutter plus resumed staring; no locomotion occurred.",
      },
    });

    const final = await runTurns(
      loadOfficeAntonScenario(),
      {
        intentEngine,
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
    // Q1: history records the consequence narrative, not the action text.
    expect(final.history[1]!.text).toContain("Tanya: Tanya calls out a friendly 'Hey!'");
    expect(final.history[2]!.text).toContain("Dana: Dana sighs, rubs his temples");

    // Zero retries: every tick renders clean on attempt 1.
    const events = logger.store.events();
    expect(logger.store.byEvent("render_failed")).toHaveLength(0);
    expect(events).not.toContain("retry_started");
    expect(events).not.toContain("fallback_used");
    expect(logger.store.byEvent("render_accepted")).toHaveLength(3);
    // Phase 4: no semantic judge in the turn loop — prose validation only.
    expect(events).not.toContain("semantic_resolved");
  });
});
