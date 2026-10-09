// Phase 2 acceptance tests: engine-owned speech.
//
// Quotes are verbatim by construction: the engine extracts the exact quote
// from the action text at turn start, dictates it to the render call, and
// repairs any deviation deterministically before validation (no LLM retry
// burned). These tests cover the executor units plus the acceptance
// criteria:
// - mock render returns a narrative with an ALTERED quote → validator
//   rejects (speech.exact_quote_missing) → deterministic reinsertion fires
//   → final history contains the exact action quote in all cases;
// - B1 regression: action `Dana says "I need help with the API"` — the
//   history quote equals the action quote byte-for-byte across 5 seeds.
import { describe, expect, it } from "vitest";
import { Logger } from "../../src/logging/logger.js";
import { makeTestDeps } from "../helpers.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { resolveRender, runTurn } from "../../src/engine/turnOrchestrator.js";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import { buildConsequenceContext } from "../../src/engine/contextBuilder.js";
import {
  exactQuoteFacts,
  planSpeech,
} from "../../src/engine/speechExecutor.js";
import type { ConsequenceResult, World } from "../../src/types.js";

const QUOTE = "I need help with the API";
const ACTION = `Dana says "${QUOTE}"`;

function danaWorld(): World {
  return loadScenario({
    version: 1,
    id: "speech-test",
    title: "Speech",
    narrative: "A room.",
    userActorId: "dana",
    order: ["dana", "bea"],
    scene: { width: 10, height: 10, objects: [] },
    actors: [
      {
        id: "dana", name: "Dana", persona: "A speaker.", x: 1, y: 1,
        state: "standing", emotion: "calm", goal: "Talk.", thoughts: "t",
        memories: [], beliefs: [], relationships: [],
      },
      {
        id: "bea", name: "Bea", persona: "A listener.", x: 8, y: 8,
        state: "standing", emotion: "calm", goal: "Listen.", thoughts: "t",
        memories: [], beliefs: [], relationships: [],
      },
    ],
  });
}

function scriptedConsequence(result: ConsequenceResult) {
  return { resolve: async () => structuredClone(result) } as never;
}

function speechResult(narrative: string): ConsequenceResult {
  return { narrative, thoughts: "Saying words.", reasoning: "r" };
}

function renderFacts(): RenderFacts {
  return {
    exactQuote: QUOTE, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
    x: 1, y: 1, engineManipulation: null,
  };
}

describe("planSpeech", () => {
  it("extracts the exact quote from the action text", () => {
    expect(planSpeech({ actorId: "dana", text: ACTION })).toBe(QUOTE);
  });

  it("returns null when the action carries no quoted speech", () => {
    expect(planSpeech({ actorId: "dana", text: "Dana waves hello." })).toBeNull();
    expect(planSpeech({ actorId: "dana", text: "Say hello to Bea." })).toBeNull();
  });

  it("picks the first segment for multi-quote actions (documented rule)", () => {
    expect(planSpeech({ actorId: "dana", text: 'Dana says "hi" then adds "bye"' })).toBe("hi");
  });
});

describe("exactQuoteFacts", () => {
  it("states the verbatim render contract with the exact quote", () => {
    const facts = exactQuoteFacts(danaWorld(), "dana", QUOTE);
    const text = facts.join("\n");
    expect(text).toContain("EXACT QUOTE");
    expect(text).toContain(`Dana says "${QUOTE}"`);
    expect(text).toContain("character-for-character");
  });

  it("states the no-quote case without inventing a quote", () => {
    const facts = exactQuoteFacts(danaWorld(), "dana", null);
    expect(facts.join("\n")).toContain("EXACT QUOTE: none");
  });
});


describe("Phase 2 golden run: altered quote (B1)", () => {
  it("validator rejects an altered quote with speech.exact_quote_missing", () => {
    const world = danaWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "dana", text: ACTION },
      speechResult('Dana says "I need help with the backend".'),
      renderFacts(),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.code)).toContain("speech.exact_quote_missing");
  });

  it("the in-loop backstop repairs the altered quote — no retry burned", async () => {
    const logger = new Logger({ sessionId: "phase2-b1", writeToFile: false });
    const world = danaWorld();
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence(
        speechResult('Dana says "I need help with the backend".'),
      ),
    });
    const result = await resolveRender(world, { actorId: "dana", text: ACTION }, deps);
    // The exact action quote — not the model's altered words — is what validates.
    expect(result.render.narrative).toContain(`"${QUOTE}"`);
    expect(result.render.narrative).not.toContain("backend");
    expect(logger.store.byEvent("render_quote_reinserted")).toHaveLength(1);
    expect(logger.store.byEvent("retry_started")).toHaveLength(0);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    expect(logger.store.byEvent("speech_planned")).toHaveLength(1);
  });

  it("a verbatim render passes untouched (backstop does not fire)", async () => {
    const logger = new Logger({ sessionId: "phase2-verbatim", writeToFile: false });
    const world = danaWorld();
    const narrative = `Dana says "${QUOTE}", looking hopeful.`;
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence(speechResult(narrative)),
    });
    const result = await resolveRender(world, { actorId: "dana", text: ACTION }, deps);
    expect(result.render.narrative).toBe(narrative);
    expect(logger.store.byEvent("render_quote_reinserted")).toHaveLength(0);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });

  it("the render input carries the exact quote as facts", () => {
    const world = danaWorld();
    const ctx = buildConsequenceContext(
      world, { actorId: "dana", text: ACTION }, undefined, undefined, undefined, QUOTE,
    );
    expect(ctx).toContain("EXACT QUOTE");
    expect(ctx).toContain(`Dana says "${QUOTE}"`);
    expect(ctx).toContain("RENDER CONTRACT");
  });
});

describe("Phase 2 B1 regression: byte-for-byte quote across 5 seeds", () => {
  // Five deterministic mock-render shapes: verbatim, paraphrase, altered,
  // dropped, and invented-extra dialogue. Every one must end with the
  // action's exact quote in canonical history, byte-for-byte.
  const seeds: Array<[string, string]> = [
    ["verbatim", `Dana says "${QUOTE}", looking hopeful.`],
    ["paraphrase", "Dana asks for help with the API."],
    ["altered", 'Dana says "I need help with the backend".'],
    ["dropped", "Dana looks around the office."],
    [
      "invented-extra",
      `Dana says "${QUOTE}", then declares "the quarterly reports are all wrong and must be redone tonight".`,
    ],
  ];

  for (const [seed, narrative] of seeds) {
    it(`seed "${seed}": history quote equals the action quote byte-for-byte`, async () => {
      const logger = new Logger({ sessionId: `phase2-b1-${seed}`, writeToFile: false });
      const world = danaWorld();
      const deps = makeTestDeps(logger, {
        consequenceEngine: scriptedConsequence(speechResult(narrative)),
        getUserAction: async () => ACTION,
        config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
      });
      const next = await runTurn(world, deps);
      const historyText = next.history.at(-1)!.text;
      expect(historyText).toContain(`"${QUOTE}"`);
      // Byte-for-byte: the exact quoted segment from the action text is
      // present, not a paraphrase or an altered variant.
      const quoted = historyText.match(/"([^"]+)"/g) ?? [];
      expect(quoted).toContain(`"${QUOTE}"`);
      expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    });
  }
});

describe("Phase 2 multi-quote rule", () => {
  it("only the first quote is engine-dictated; the backstop appends it", async () => {
    const logger = new Logger({ sessionId: "phase2-multiquote", writeToFile: false });
    const world = danaWorld();
    const deps = makeTestDeps(logger, {
      consequenceEngine: scriptedConsequence(speechResult("Dana waves.")),
    });
    const result = await resolveRender(
      world,
      { actorId: "dana", text: 'Dana says "hi" then adds "bye"' },
      deps,
    );
    expect(result.render.narrative).toContain('Dana says "hi"');
    expect(logger.store.byEvent("speech_planned")).toHaveLength(1);
    expect(logger.store.byEvent("speech_planned")[0]!.output).toMatchObject({
      exactQuote: "hi",
    });
  });
});
