// Unit tests for the ARCHITECTURE.md reviewed fixes (F1–F35, Q1–Q7).
// Each test names the flaw it locks in so future edits know the intent.
import { describe, expect, it } from "vitest";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import { OBJECT_INTERACT_RADIUS } from "../../src/engine/validate/objects.js";
import { MAX_SUGGEST_CANDIDATES, computeMovementOutcome } from "../../src/core/movement.js";

import { hasDisplacementToken, resolveMentionedActorId } from "../../src/engine/deterministicSemantics.js";
import { isFallbackConsequence } from "../../src/engine/turnSalvage.js";
import { isFallbackHistoryEntry } from "../../src/engine/patchApplier.js";
import { applyRenderResult } from "../../src/engine/patchApplier.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { KNOWN_WORLD_VERSIONS, normalizeHistoryEntry, NOT_DONE_SENTINEL } from "../../src/types.js";
import { buildConsequenceContext, historyVisibleTo } from "../../src/engine/contextBuilder.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import { accumulateTurnUsage } from "../../src/engine/turnOrchestrator.js";
import { Logger } from "../../src/logging/logger.js";
import { hist, makeTinyWorld, errorText } from "../helpers.js";
import type { ConsequenceResult } from "../../src/types.js";

function baseResult(narrative = "Something happens."): ConsequenceResult {
  return { narrative, reasoning: "r" };
}

function facts(over: Partial<RenderFacts> = {}): RenderFacts {
  return {
    exactQuote: null, moved: false, pose: null, effectivePose: "stand",
    x: 1, y: 1, engineManipulation: null, ...over,
  };
}

describe("F2: stable error codes", () => {
  it("validation errors carry snake_case codes, not bare strings", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Walk." },
      baseResult("U walks to the door."),
      facts(),
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e.code).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});

describe("F6: perceiver-scoped history", () => {
  it("normalizeHistoryEntry maps legacy strings to global perceivers", () => {
    const entry = normalizeHistoryEntry("U: Wave.", ["u", "n"]);
    expect(entry).toEqual({ text: "U: Wave.", perceivers: ["u", "n"] });
    const obj = { text: "x", perceivers: ["u"] };
    expect(normalizeHistoryEntry(obj, ["u", "n"])).toEqual(obj);
  });

  it("historyVisibleTo filters to perceived-or-authored entries", () => {
    const world = makeTinyWorld();
    world.history.push(hist(world, "U: Hello everyone.", ["u"]));
    world.history.push(hist(world, "N: Hi U.", ["u", "n"]));
    const forN = historyVisibleTo(world, "n");
    expect(forN).toHaveLength(1);
    expect(forN[0]!.text).toBe("N: Hi U.");
    const forU = historyVisibleTo(world, "u");
    expect(forU).toHaveLength(2);
  });
});

describe("F19: bounded engine step computation", () => {
  it("exports MAX_SUGGEST_CANDIDATES = 500", () => {
    expect(MAX_SUGGEST_CANDIDATES).toBe(500);
  });

  it("computeMovementOutcome scans within the cap and avoids other actors", () => {
    const world = makeTinyWorld();
    const o = computeMovementOutcome(world, "u", { destinationActorId: "n" });
    expect(o).not.toBeNull();
    // Not on top of n.
    expect([o!.x, o!.y]).not.toEqual([4, 4]);
    expect(Math.hypot(o!.x - 4, o!.y - 4)).toBeLessThan(Math.hypot(1 - 4, 1 - 4));
  });
});

describe("F20: duplicate order ids rejected", () => {
  it("loadScenario throws a descriptive error on duplicate order ids", () => {
    const raw = JSON.parse(JSON.stringify({
      id: "dup", version: 1, title: "Dup", narrative: "n",
      userActorId: "u", order: ["u", "u"],
      scene: { width: 6, height: 6, objects: [] },
      actors: [
        { id: "u", name: "U", persona: "p", x: 1, y: 1, state: "standing", emotion: "calm", goal: "g", memories: [], beliefs: [], relationships: [] },
      ],
    }));
    expect(() => loadScenario(raw)).toThrow(/duplicate/i);
  });
});

describe("F21: word-boundary mention matching", () => {
  it("does not match actor ids inside other words", () => {
    const world = makeTinyWorld(); // actors u, n
    world.actors.push({
      id: "dan", name: "Dana", persona: "p", x: 0, y: 0,
      state: "standing", emotion: "calm", goal: "g", thoughts: "",
      memories: [], beliefs: [], relationships: [],
    });
    // "Dana" as a word matches dan; the id "dan" inside "Bandana" does not.
    expect(resolveMentionedActorId(world, "u", "Walk to Dana.")).toBe("dan");
    expect(resolveMentionedActorId(world, "u", "Adjust the bandana.")).toBeUndefined();
    // "Listen." contains the letter n but not a mention of anyone.
    expect(resolveMentionedActorId(world, "u", "Listen.")).toBeUndefined();
  });
});

describe("F22: sentinel-marked fallbacks", () => {
  it("NOT_DONE_SENTINEL is the private-use codepoint U+10FFFF", () => {
    expect(NOT_DONE_SENTINEL.codePointAt(0)).toBe(0x10ffff);
  });

  it("detects the sentinel, not the human-readable text", () => {
    expect(isFallbackHistoryEntry({ text: `U tried: X. (not done)${NOT_DONE_SENTINEL}`, perceivers: ["u"] })).toBe(true);
    expect(isFallbackHistoryEntry({ text: "U tried: X. (not done)", perceivers: ["u"] })).toBe(false);
    expect(isFallbackHistoryEntry("U: Wave.")).toBe(false);
  });
});

describe("F23: fallback flag on ConsequenceResult", () => {
  it("checks the flag first, narrative equality as backward compat", () => {
    expect(isFallbackConsequence({ narrative: "Custom.", reasoning: "r", fallback: true })).toBe(true);
    expect(isFallbackConsequence({ narrative: "Nothing changes.", reasoning: "r" })).toBe(true);
    expect(isFallbackConsequence({ narrative: "Custom.", reasoning: "r" })).toBe(false);
  });
});

describe("F27: scenario version validation", () => {
  it("exports KNOWN_WORLD_VERSIONS = [1]", () => {
    expect(KNOWN_WORLD_VERSIONS).toEqual([1]);
  });

  it("rejects unknown scenario versions", () => {
    const raw = JSON.parse(JSON.stringify({
      id: "v2", version: 2, title: "V2", narrative: "n",
      userActorId: "u", order: ["u"],
      scene: { width: 6, height: 6, objects: [] },
      actors: [
        { id: "u", name: "U", persona: "p", x: 1, y: 1, state: "standing", emotion: "calm", goal: "g", memories: [], beliefs: [], relationships: [] },
      ],
    }));
    expect(() => loadScenario(raw)).toThrow(/version/i);
  });
});

describe("F8: scenario vocabulary", () => {
  it("parses vocabulary from the scenario and reattaches it to the world", () => {
    const raw = {
      id: "voc", version: 1, title: "Voc", narrative: "n",
      userActorId: "u", order: ["u"],
      vocabulary: { objectNouns: ["mug", "stapler"] },
      scene: { width: 6, height: 6, objects: [] },
      actors: [
        { id: "u", name: "U", persona: "p", x: 1, y: 1, state: "standing", emotion: "calm", goal: "g", memories: [], beliefs: [], relationships: [] },
      ],
    };
    const world = loadScenario(raw);
    expect(world.vocabulary).toEqual({ objectNouns: ["mug", "stapler"] });
  });
});

describe("F34: head-verb variants", () => {
  it("matches heads/headed/heading to", () => {
    expect(hasDisplacementToken("Head to the desk.")).toBe(true);
    expect(hasDisplacementToken("She heads to the door.")).toBe(true);
    expect(hasDisplacementToken("He headed toward the exit.")).toBe(true);
    expect(hasDisplacementToken("They are heading to lunch.")).toBe(true);
  });
});

describe("Q1: history records the narrative", () => {
  it("clean turns record Name: narrative", () => {
    const world = makeTinyWorld();
    const next = applyRenderResult(world, { actorId: "u", text: "Wave at everyone." }, baseResult("U waves hello."), { movement: null, pose: null, manipulation: null });
    expect(next.history.at(-1)).toEqual({
      text: "U: U waves hello.",
      perceivers: ["u", "n"],
    });
  });
});

describe("Q7 (Phase 3): engine-owned manipulation replaces the affordance nudge", () => {
  it("consequence context carries EXECUTED MANIPULATION facts for a pick-up", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "mug", name: "Mug", description: "A mug.",
      x: 1, y: 2, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    const action = { actorId: "u", text: "Pick up the mug." };
    const outcome = executeManipulation(world, action);
    expect(outcome).not.toBeNull();
    const ctx = buildConsequenceContext(world, action, undefined, undefined, null, null, outcome);
    expect(ctx).toContain("EXECUTED MANIPULATION");
    expect(ctx).toContain("now holds the cup");
    expect(ctx).toContain("Do NOT emit objectPatches");
  });

  it("consequence context states no manipulation for a non-manipulation action", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Wave hello." };
    const ctx = buildConsequenceContext(world, action, undefined, undefined, null, null, null);
    expect(ctx).toContain("EXECUTED MANIPULATION: none");
  });

  it("consequence context carries the engine-ownership rule instead of patch demands", () => {
    const world = makeTinyWorld();
    const ctx = buildConsequenceContext(world, { actorId: "u", text: "Wave hello." });
    expect(ctx).toContain("OBJECT MANIPULATION IS ENGINE-EXECUTED");
    expect(ctx).not.toContain("INCOMPLETE without its patch");
  });
});

describe("F31: per-turn LLM usage accumulation", () => {
  it("sums usage entries for the turn's tick/turnIndex", () => {
    const logger = new Logger({ sessionId: "usage", writeToFile: false });
    logger.log({
      module: "consequence", event: "consequence_completed", tick: 3, turnIndex: 0,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
    logger.log({
      module: "proposal", event: "proposal_completed", tick: 3, turnIndex: 0,
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    });
    logger.log({
      module: "proposal", event: "proposal_completed", tick: 4, turnIndex: 0,
      usage: { promptTokens: 999, completionTokens: 999, totalTokens: 1998 },
    });
    const total = accumulateTurnUsage(logger, 3, 0);
    expect(total).toEqual({ promptTokens: 150, completionTokens: 30, totalTokens: 180 });
  });
});
