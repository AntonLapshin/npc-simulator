// Tests for exp-2 (local-laya-7moves) model-side action items 1–4.
//
// Items 1 (roster discipline line + negative example) and 2 (user-turn
// capable-tier routing) were implemented for exp-1 and are covered by
// tests/unit/local8bItems.test.ts — this file covers the exp-2 deltas:
// the roster-drawn positive examples (#1 strengthening), the fully-spoken
// canonical form (#3), and the prop auto-hints (#4).
import { describe, expect, it } from "vitest";
import type { Action, World } from "../../src/types.js";
import type { LLMProvider } from "../../src/llm/index.js";
import {
  buildRosterDisciplineLine,
  rosterExampleActors,
} from "../../src/llm/rosterDiscipline.js";
import { consequenceSuffix, FULLY_SPOKEN_ACTION_LINE } from "../../src/llm/prompts.js";
import { LLMConsequenceEngine } from "../../src/llm/llmConsequenceEngine.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { loadOfficeScenario } from "../helpers.js";

// ---------------------------------------------------------------------------
// Item 1: roster-discipline line + negative Anton/Tanya example (exp-1 base,
// verified here for the office.json roster) + roster-drawn positive
// examples (exp-2 strengthening: the static Anton/Tanya examples were
// copied verbatim by the 8B in exp-2 m1 attempt 2).
// ---------------------------------------------------------------------------
describe("exp-2 item 1: roster discipline in the consequence prompt", () => {
  it("rosterExampleActors takes the first two roster ids with capitalized names", () => {
    expect(rosterExampleActors(["jeff", "ana", "dan"])).toEqual([
      { id: "jeff", name: "Jeff" },
      { id: "ana", name: "Ana" },
    ]);
  });

  it("rosterExampleActors is empty for an empty roster (legacy examples kept)", () => {
    expect(rosterExampleActors([])).toEqual([]);
  });

  it("discipline line still shows the negative Anton/Tanya example for the office roster", () => {
    const line = buildRosterDisciplineLine(["jeff", "ana", "dan"]);
    expect(line).toContain('"jeff", "ana", "dan"');
    expect(line).toContain('"Anton"');
    expect(line).toContain('"Tanya"');
    expect(line).toMatch(/INVALID/);
  });

  it("positive examples use the real roster, never Anton/Tanya, for office.json ids", () => {
    for (const mode of ["short", "full"] as const) {
      const s = consequenceSuffix(mode, ["jeff", "ana", "dan"]);
      // Exp-6 item 1 replaced the copyable "X greets the office." example
      // with a quoted-speech example — still roster-parameterized.
      expect(s).toContain('Jeff says, \\"Morning, everyone');
      expect(s).toContain('"actorId": "jeff"');
      expect(s).not.toContain("Anton greets the office");
      expect(s).not.toContain("Anton walks toward Tanya");
      expect(s).not.toContain("Anton says");
    }
    const full = consequenceSuffix("full", ["jeff", "ana", "dan"]);
    expect(full).toContain("Jeff walks toward Ana");
    expect(full).toContain('"destinationActorId": "ana"');
  });

  it("Anton/Tanya roster keeps the legacy examples (exp-6 speech shape)", () => {
    const short = consequenceSuffix("short", ["anton", "tanya", "dana"]);
    expect(short).toContain('Anton says, \\"Morning, everyone');
    expect(short).toContain('"actorId": "anton"');
    const full = consequenceSuffix("full", ["anton", "tanya", "dana"]);
    expect(full).toContain("Anton walks toward Tanya");
    expect(full).toContain('"destinationActorId": "tanya"');
  });

  it("empty roster keeps the legacy examples (exp-6 speech shape)", () => {
    expect(consequenceSuffix("short")).toContain('Anton says, \\"Morning, everyone');
    expect(consequenceSuffix("full")).toContain("Anton walks toward Tanya");
  });
});

// ---------------------------------------------------------------------------
// Item 2: user-turn consequence through the capable tier. Implemented for
// exp-1 via getEnginesForTurn (src/llm/index.ts) and covered by
// tests/unit/local8bItems.test.ts ("C2 user-turn capable-tier routing") —
// including the exp-2 all-local config (identical tiers → silent fallback).
// No exp-2 delta; no new tests here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Item 3: canonical form for fully-spoken actions.
// ---------------------------------------------------------------------------
describe("exp-2 item 3: fully-spoken canonical form", () => {
  it("the canonical line demands verbatim quotes and a non-speech frame only", () => {
    expect(FULLY_SPOKEN_ACTION_LINE).toMatch(/FULLY-SPOKEN ACTION/);
    expect(FULLY_SPOKEN_ACTION_LINE).toMatch(/VERBATIM/);
    expect(FULLY_SPOKEN_ACTION_LINE).toMatch(/never paraphrase/i);
    expect(FULLY_SPOKEN_ACTION_LINE).toMatch(/non-speech frame/);
  });

  it("both suffix modes carry the canonical line when roster ids are given", () => {
    for (const mode of ["short", "full"] as const) {
      const s = consequenceSuffix(mode, ["jeff", "ana", "dan"]);
      expect(s).toContain("FULLY-SPOKEN ACTION");
      expect(s).toContain("quote it VERBATIM");
    }
  });

  it("the canonical line is present without roster ids too (speech turns happen everywhere)", () => {
    expect(consequenceSuffix("short")).toContain("FULLY-SPOKEN ACTION");
    expect(consequenceSuffix("full")).toContain("FULLY-SPOKEN ACTION");
  });
});

// ---------------------------------------------------------------------------
// Item 4 (Phase 3): prop/object auto-hints are deleted — props are
// engine-owned now, so the prompt no longer teaches the patch convention.
// The executor plans the same mappings deterministically from the action
// text (typing→laptop, sip→cup) when the object is within reach.
// ---------------------------------------------------------------------------
describe("exp-2 item 4 (Phase 3): executor owns the prop mappings", () => {
  const world: World = loadOfficeScenario();

  it("executor plans laptop for typing near the actor-owned laptop", () => {
    const w = loadOfficeScenario();
    const ana = w.actors.find((a) => a.id === "ana")!;
    const laptop = w.scene.objects.find((o) => o.id === "ana_laptop")!;
    // Stand next to the laptop: the executor needs physical reach.
    ana.x = laptop.x; ana.y = laptop.y;
    const outcome = executeManipulation(w, { actorId: "ana", text: "Ana keeps typing on her laptop." });
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.propName).toBe("laptop");
    expect(outcome!.plan.objectId).toBe("ana_laptop");
  });

  it("executor plans cup for sipping near the roster mug", () => {
    const w = loadOfficeScenario();
    const dan = w.actors.find((a) => a.id === "dan")!;
    const mug = w.scene.objects.find((o) => o.id === "coffee_mug")!;
    dan.x = mug.x; dan.y = mug.y;
    const outcome = executeManipulation(w, { actorId: "dan", text: "Dan sips his coffee while reading the monitor." });
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.propName).toBe("cup");
  });

  it("executor plans nothing for non-manipulation actions", () => {
    expect(executeManipulation(world, { actorId: "jeff", text: "Jeff walks to the door." })).toBeNull();
    expect(executeManipulation(world, { actorId: "ana", text: "Ana asks Dan about the deploy." })).toBeNull();
  });
});

class ValidConsequenceProvider implements LLMProvider {
  readonly name = "stub-valid";
  constructor(private readonly narrative: string) {}
  async complete(): Promise<string> {
    return JSON.stringify({
      narrative: this.narrative,
      actorPatches: [{ actorId: "ana", prop: "laptop" }],
      objectPatches: [],
      effects: { moved: false, spoke: false, quotedSpeech: [] },
      reasoning: "Typing implies holding the laptop.",
    });
  }
}

describe("exp-2 item 4 (Phase 3): no prop hint in the consequence prompt", () => {
  it("the prompt carries engine-ownership instead of the PROP HINT", async () => {
    const logger = createTestLogger();
    const engine = new LLMConsequenceEngine(
      logger,
      new ValidConsequenceProvider("Ana keeps typing on her laptop."),
      { maxRetries: 0 },
    );
    const world = loadOfficeScenario();
    const action: Action = { actorId: "ana", text: "Ana keeps typing on her laptop." };
    const result = await engine.resolve(world, action);
    // The model-emitted prop patch survives the raw engine resolve —
    // stripping happens in the turn orchestrator's in-loop merge.
    expect(result.actorPatches[0]).toMatchObject({ actorId: "ana", prop: "laptop" });
    const completed = logger.store.all().find((e) => e.event === "consequence_completed");
    expect(completed).toBeDefined();
    const prompt = String((completed as { prompt?: unknown }).prompt ?? "");
    expect(prompt).not.toContain("PROP HINT");
    expect(prompt).toContain("OBJECT MANIPULATION IS ENGINE-EXECUTED");
  });

  it("non-manipulation actions get no PROP HINT either", async () => {
    const logger = createTestLogger();
    const engine = new LLMConsequenceEngine(
      logger,
      new ValidConsequenceProvider("Jeff walks to the door."),
      { maxRetries: 0 },
    );
    const world = loadOfficeScenario();
    await engine.resolve(world, { actorId: "jeff", text: "Jeff walks to the door." });
    const completed = logger.store.all().find((e) => e.event === "consequence_completed");
    expect(completed).toBeDefined();
    const prompt = String((completed as { prompt?: unknown }).prompt ?? "");
    expect(prompt).not.toContain("PROP HINT");
  });
});
