// PLAN_V2 Phase 1: the intent-call engine with scripted providers.
// No network — a stub LLMProvider simulates valid JSON, invalid JSON,
// and transport failures.
import { describe, expect, it } from "vitest";
import { createTestLogger } from "../../src/logging/logger.js";
import { LLMIntentEngine, buildIntentPrompt } from "../../src/llm/llmIntentEngine.js";
import { FALLBACK_INTENT } from "../../src/core/intent.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { World } from "../../src/types.js";
import { makeTinyWorld } from "../helpers.js";

class StubProvider implements LLMProvider {
  readonly name = "stub";
  calls: Array<{ system: string; user: string }> = [];

  constructor(private readonly script: Array<string | Error>) {}

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    this.calls.push({ system: systemPrompt, user: userPrompt });
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("stub provider exhausted");
    return next;
  }
}

/** A world with something to ground on: adjacent actors, a held prop, a nearby object. */
function makeGroundedWorld(): World {
  const world = makeTinyWorld();
  const u = world.actors.find((a) => a.id === "u")!;
  const n = world.actors.find((a) => a.id === "n")!;
  // n stands at (4, 4); put u one cell away so contact is within reach.
  u.x = 3;
  u.y = 4;
  n.prop = "a coffee mug";
  world.scene.objects.push({
    id: "desk",
    name: "Desk",
    description: "A wooden desk.",
    x: 4,
    y: 3,
    w: 2,
    h: 1,
    passable: false,
    blocksVision: false,
    blocksSound: false,
  });
  world.history.push({ text: "U: Good morning.", perceivers: ["u", "n"] });
  return world;
}

const goodJson = JSON.stringify({
  action: "N picks up the coffee mug.",
  quote: "",
});

describe("buildIntentPrompt", () => {
  it("contains the physical facts: positions, held items, reachability", () => {
    const prompt = buildIntentPrompt(makeGroundedWorld(), "n");
    // Who stands where.
    expect(prompt).toContain("N at (4, 4)");
    expect(prompt).toContain("U at (3, 4)");
    // Who holds what.
    expect(prompt).toContain("holding a coffee mug");
    // What is within reach (u is 1 cell away; the desk center is ~0.7 away).
    expect(prompt).toContain("within reach");
    expect(prompt).toContain("Desk");
  });

  it("marks out-of-reach actors as distant", () => {
    const prompt = buildIntentPrompt(makeTinyWorld(), "n");
    // u is ~4.2 cells from n — a distance, not within reach.
    const othersLine = prompt.split("\n").find((l) => l.includes("U at (1, 1)"));
    expect(othersLine).toBeDefined();
    expect(othersLine).toContain("4.2 cells away");
    expect(othersLine).not.toContain("within reach");
  });

  it("carries identity, the task, and what just happened", () => {
    const prompt = buildIntentPrompt(makeGroundedWorld(), "n");
    expect(prompt).toContain("IDENTITY: You are N");
    expect(prompt).toContain('"action"');
    expect(prompt).toContain('"quote"');
    expect(prompt).toContain("U: Good morning.");
  });

  it("throws for an unknown actor (the engine converts this to the fallback)", () => {
    expect(() => buildIntentPrompt(makeTinyWorld(), "ghost")).toThrow();
  });
});

describe("LLMIntentEngine", () => {
  it("returns the parsed intent on a good payload", async () => {
    const logger = createTestLogger("intent1");
    const provider = new StubProvider([goodJson]);
    const engine = new LLMIntentEngine(logger, provider);
    const result = await engine.intent(makeTinyWorld(), "n");
    expect(result).toEqual({ action: "N picks up the coffee mug.", quote: "" });
    expect(provider.calls).toHaveLength(1);
    expect(logger.store.byEvent("intent_completed")).toHaveLength(1);
    expect(logger.store.byEvent("intent_failed")).toHaveLength(0);
    // The logged prompt carries the physical facts.
    const logged = logger.store.byEvent("intent_started")[0]!;
    expect(String(logged.prompt)).toContain("PHYSICAL FACTS");
  });

  it("retries exactly once, then returns the deterministic fallback", async () => {
    const logger = createTestLogger("intent2");
    const provider = new StubProvider(["not json at all", "{still not json"]);
    const engine = new LLMIntentEngine(logger, provider);
    const result = await engine.intent(makeTinyWorld(), "n");
    expect(result).toEqual(FALLBACK_INTENT);
    // Exactly 1 retry = 2 provider calls, then the fallback (no more).
    expect(provider.calls).toHaveLength(2);
    // completeJson logs one intent_failed per failed attempt; the engine
    // logs the final one with the "fallback:" cause.
    const failed = logger.store.byEvent("intent_failed");
    expect(failed[failed.length - 1]!.error).toMatch(/^fallback: /);
    expect(logger.store.byEvent("intent_completed")).toHaveLength(0);
  });

  it("a failure followed by a good payload succeeds on the retry", async () => {
    const logger = createTestLogger("intent3");
    const provider = new StubProvider(['{"action": 42}', goodJson]);
    const engine = new LLMIntentEngine(logger, provider);
    const result = await engine.intent(makeTinyWorld(), "n");
    expect(result).toEqual({ action: "N picks up the coffee mug.", quote: "" });
    expect(provider.calls).toHaveLength(2);
    expect(logger.store.byEvent("intent_completed")).toHaveLength(1);
  });

  it("a transport failure followed by a good payload succeeds on the retry", async () => {
    const logger = createTestLogger("intent4");
    const provider = new StubProvider([new Error("HTTP 500"), goodJson]);
    const engine = new LLMIntentEngine(logger, provider);
    const result = await engine.intent(makeTinyWorld(), "n");
    expect(result).toEqual({ action: "N picks up the coffee mug.", quote: "" });
    expect(provider.calls).toHaveLength(2);
  });

  it("an empty action fails schema validation and falls back after the retry", async () => {
    const logger = createTestLogger("intent5");
    const provider = new StubProvider([
      JSON.stringify({ action: "", quote: "" }),
      JSON.stringify({ action: "   ", quote: "" }),
    ]);
    const engine = new LLMIntentEngine(logger, provider);
    const result = await engine.intent(makeTinyWorld(), "n");
    expect(result).toEqual(FALLBACK_INTENT);
    expect(provider.calls).toHaveLength(2);
  });

  it("is provider-backed so the turn budget counts the call", () => {
    const engine = new LLMIntentEngine(createTestLogger("intent6"), new StubProvider([]));
    expect(engine.providerBacked).toBe(true);
  });
});
