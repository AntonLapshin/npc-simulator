import { describe, expect, it } from "vitest";
import { MockSemanticJudge } from "../../src/mocks/mockSemanticJudge.js";
import { LLMSemanticJudge } from "../../src/llm/llmSemanticJudge.js";
import {
  effectsToSemantics,
  resolveActionSemantics,
} from "../../src/engine/actionSemantics.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { makeTinyWorld } from "../helpers.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { Action, ActionSemantics, World } from "../../src/types.js";

class StubProvider implements LLMProvider {
  readonly name = "stub";
  calls = 0;
  constructor(private readonly script: Array<string | Error>) {}
  async complete(_system: string, _user: string): Promise<string> {
    this.calls++;
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("stub provider exhausted");
    return next;
  }
}

describe("MockSemanticJudge", () => {
  it("classifies task-resuming actions as stillness (office-anton regression)", async () => {
    const world = makeTinyWorld();
    const judge = new MockSemanticJudge();
    const s1 = await judge.classify(world, {
      actorId: "u",
      text: "3. Call out a friendly 'Hey!' as she sees N, then return to typing, an open and welcoming demeanor still present even with full focus on the task at hand.",
    });
    expect(s1.moves).toBe(false);
    expect(s1.speaks).toBe(true);
    expect(s1.quotedSpeech).toEqual(["Hey!"]);

    const s2 = await judge.classify(world, {
      actorId: "u",
      text: "Sighs, rubs temples, and mutters 'Just a few more minutes...' before returning to staring at the monitor, trying to refocus.",
    });
    expect(s2.moves).toBe(false);
    expect(s2.speaks).toBe(true);
    expect(s2.quotedSpeech).toEqual(["Just a few more minutes..."]);
  });

  it("resolves movement targets to actor ids", async () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const judge = new MockSemanticJudge();
    const s = await judge.classify(world, { actorId: "u", text: "Come closer to Nadia" });
    expect(s).toMatchObject({ moves: true, destinationActorId: "n" });
  });

  it("extracts quoted speech and detects speech intent without quotes", async () => {
    const world = makeTinyWorld();
    const judge = new MockSemanticJudge();
    const quoted = await judge.classify(world, { actorId: "u", text: 'Say "Hello there!" loudly.' });
    expect(quoted).toMatchObject({ speaks: true, quotedSpeech: ["Hello there!"] });
    const implied = await judge.classify(world, { actorId: "u", text: "Introduce yourself." });
    expect(implied.speaks).toBe(true);
    expect(implied.quotedSpeech).toEqual([]);
  });
});

describe("resolveActionSemantics", () => {
  it("merges self-declared effects with an independent judge classification", async () => {
    const world = makeTinyWorld();
    const logger = createTestLogger();
    let calls = 0;
    const judge = {
      async classify(_w: World, _a: Action): Promise<ActionSemantics> {
        calls++;
        return { moves: false, speaks: false, quotedSpeech: [] };
      },
    };
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "u", text: "Walk." },
      {
        narrative: "U walks.",
        actorPatches: [],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: true, spoke: false, destinationActorId: "n" },
      },
      judge,
      logger,
    );
    expect(calls).toBe(1);
    expect(resolved).toEqual({
      source: "effects",
      semantics: { moves: true, destinationActorId: "n", speaks: false, quotedSpeech: [] },
      disagreements: ["moves conflict: effects=true judge=false (kept OR)"],
    });
    expect(logger.store.events()).toContain("semantic_resolved");
    expect(logger.store.events()).toContain("judge_vs_effects_disagreement");
  });

  it("widens lying effects via the judge (merged source)", async () => {
    const world = makeTinyWorld();
    const logger = createTestLogger();
    // Consequence claims nothing happened for a "walk toward N" action —
    // the independent classification must restore the movement requirement.
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "u", text: "Walk toward N, my friend." },
      {
        narrative: "U adjusts his tie.",
        actorPatches: [{ actorId: "u", thoughts: "Sharp." }],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: false, spoke: false },
      },
      new MockSemanticJudge(),
      logger,
    );
    expect(resolved.source).toBe("merged");
    expect(resolved.semantics).toMatchObject({ moves: true });
  });

  it("asks the judge when effects are absent", async () => {
    const world = makeTinyWorld();
    const logger = createTestLogger();
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "u", text: "Walk to the door." },
      { narrative: "U walks.", actorPatches: [], objectPatches: [], reasoning: "r" },
      new MockSemanticJudge(),
      logger,
    );
    expect(resolved.source).toBe("judge");
    expect(resolved.semantics).toMatchObject({ moves: true });
  });

  it("fails open to physics-only when the judge is unavailable", async () => {
    const world = makeTinyWorld();
    const logger = createTestLogger();
    const failing = {
      async classify(): Promise<ActionSemantics> {
        throw new Error("provider down");
      },
    };
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "u", text: "Walk." },
      { narrative: "U walks.", actorPatches: [], objectPatches: [], reasoning: "r" },
      failing,
      logger,
    );
    expect(resolved).toEqual({ source: "fail-open", semantics: undefined, disagreements: [] });
    expect(logger.store.events()).toContain("semantic_failed");
  });

  it("projects effects deterministically", () => {
    expect(
      effectsToSemantics({ narrative: "x", actorPatches: [], objectPatches: [], reasoning: "r" }),
    ).toBeUndefined();
    expect(
      effectsToSemantics({
        narrative: "x",
        actorPatches: [],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: false, spoke: true, quotedSpeech: ["Hi"] },
      }),
    ).toEqual({ moves: false, speaks: true, quotedSpeech: ["Hi"] });
  });
});

describe("LLMSemanticJudge", () => {
  it("classifies via the LLM and logs semantic_completed", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({ moves: true, destinationActorId: "n", speaks: false, quotedSpeech: [] }),
    ]);
    const judge = new LLMSemanticJudge(logger, provider);
    const semantics = await judge.classify(makeTinyWorld(), { actorId: "u", text: "Sidle over to him." });
    expect(semantics).toEqual({ moves: true, destinationActorId: "n", speaks: false, quotedSpeech: [] });
    expect(provider.calls).toBe(1);
    expect(logger.store.events()).toContain("semantic_completed");
  });

  it("retries unknown destination ids, then throws when the judge keeps failing", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({ moves: true, destinationActorId: "ghost", speaks: false, quotedSpeech: [] }),
      JSON.stringify({ moves: true, destinationActorId: "ghost", speaks: false, quotedSpeech: [] }),
    ]);
    const judge = new LLMSemanticJudge(logger, provider, { maxRetries: 1 });
    await expect(
      judge.classify(makeTinyWorld(), { actorId: "u", text: "Walk." }),
    ).rejects.toThrow(/SemanticJudge failed/);
    expect(provider.calls).toBe(2);
  });
});
