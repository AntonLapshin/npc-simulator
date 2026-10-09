// Regression tests for experiment-6.md action items 1-8
// (office-anton.json, JoinGonka GLM 5.3 Flash, truncated at 9/21 turns).
import { describe, expect, it } from "vitest";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import {
  findManipulatedObjects,
  normalizeQuotes,
  parseActionQuotes,
  resolveDestinationObjectId,
} from "../../src/engine/deterministicSemantics.js";
import { isQuoteGroundedInAction } from "../../src/core/speech.js";
import { buildConsequenceContext } from "../../src/engine/contextBuilder.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import { applyRenderResult, describePosition } from "../../src/engine/patchApplier.js";
import { resolveRender } from "../../src/engine/turnOrchestrator.js";
import {
  RENDER_OUTPUT_SCHEMA,
  LLM_SYSTEM_PROMPT,
  renderSuffix,
} from "../../src/llm/prompts.js";
import {
  completeJson,
  minimalRepairPrompt,
  parseErrorSignature,
} from "../../src/llm/complete.js";
import { extractJsonPayload, tryCloseTruncatedJson } from "../../src/llm/json.js";
import {
  FailoverProvider,
  JoinGonkaProvider,
  createProviderForTask,
  probeLlmEndpoint,
  resolveLlmEnv,
} from "../../src/llm/provider.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld, errorText } from "../helpers.js";
import type { ActionSemantics, ConsequenceResult, World } from "../../src/types.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { ConsequenceEngine } from "../../src/intelligence/types.js";

function baseResult(narrative = "Something happens."): ConsequenceResult {
  return { narrative, reasoning: "r" };
}

/** Office-anton-shaped world (mirrors experiment5.test.ts helpers). */
function antonWorld(): World {
  const world = makeTinyWorld();
  world.scene.width = 20;
  world.scene.height = 20;
  const [anton, tanya] = world.actors;
  anton!.id = "anton";
  anton!.name = "Anton";
  anton!.x = 14;
  anton!.y = 3;
  anton!.state = "standing";
  tanya!.id = "tanya";
  tanya!.name = "Tanya";
  tanya!.x = 13;
  tanya!.y = 4;
  tanya!.state = "sitting at her desk and working on a laptop";
  tanya!.pose = "sit";
  tanya!.prop = "laptop";
  world.order = ["anton", "tanya"];
  world.scene.objects.push(
    { id: "anton_desk", name: "Anton's desk", description: "A fresh desk.", x: 3, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false },
    { id: "tanya_desk", name: "Tanya's desk", description: "A desk.", x: 7, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false },
    { id: "anton_laptop", name: "Anton's laptop", description: "A new laptop.", x: 4, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
  );
  return world;
}

function stillSemantics(): ActionSemantics {
  return { moves: false, speaks: false, quotedSpeech: [] };
}

describe("exp6-1 destination precedence (tick 7)", () => {
  it("'his desk' with Anton named scopes to Anton, not the acting actor", () => {
    const world = antonWorld();
    // Tick-7 shape: Tanya leading Anton — "his" is Anton's, not Tanya's.
    expect(
      resolveDestinationObjectId(world, "Lead Anton toward his desk.", "tanya"),
    ).toBe("anton_desk");
  });

  it("'his desk' with no other actor named still scopes to self", () => {
    const world = antonWorld();
    expect(
      resolveDestinationObjectId(world, "Walk to his desk.", "anton"),
    ).toBe("anton_desk");
  });

  it("Phase 4: the deterministic resolver is the only destination source", () => {
    // The model-declared/effects id channel is deleted - there is nothing
    // left to outrank or contradict. The text-grounded resolver decides.
    const world = antonWorld();
    expect(
      resolveDestinationObjectId(world, "Head to Anton's desk and help him set up his laptop.", "tanya"),
    ).toBe("anton_desk");
  });
});

describe("exp6-2 quote normalization (tick 7)", () => {
  it("normalizeQuotes canonicalizes curly quotes and apostrophes", () => {
    expect(normalizeQuotes("\u201cYou\u2019re asking\u201d")).toBe("\"You're asking\"");
    expect(normalizeQuotes("\u2018single\u2019")).toBe("'single'");
  });

  it("parseActionQuotes extracts curly-quoted segments with straight apostrophes", () => {
    expect(parseActionQuotes("\u201cYou\u2019re asking about the desk\u201d")).toEqual([
      "You're asking about the desk",
    ]);
  });

  it("isQuoteGroundedInAction bridges curly-vs-straight apostrophes", () => {
    // Tick-7 shape: action used ' (U+2019), narrative used '.
    const actionText = "Tanya asks \u201cYou\u2019re asking about the desk?\u201d";
    const narrativeQuote = "You're asking about the desk?";
    expect(isQuoteGroundedInAction(narrativeQuote, actionText)).toBe(true);
  });
});

describe("exp6-3 per-turn time budget + identical-error early abort", () => {
  function stubProvider(outputs: Array<string | Error>): LLMProvider {
    let i = 0;
    return {
      name: "stub",
      complete: async () => {
        const out = outputs[Math.min(i++, outputs.length - 1)]!;
        if (out instanceof Error) throw out;
        return out;
      },
    };
  }

  it("aborts early when the identical parse error repeats (and varies strategy once)", async () => {
    const logger = createTestLogger();
    const bad = "Let me analyze this. Dana is at his desk…"; // no JSON, same every time
    const provider = stubProvider([bad, bad, bad, bad, bad]);
    const result = await completeJson({
      logger,
      provider,
      module: "consequence",
      tick: 0,
      turnIndex: 0,
      systemPrompt: "s",
      userPrompt: "u",
      maxRetries: 5,
      schema: (await import("../../src/schemas.js")).consequenceResultSchema,
      schemaText: RENDER_OUTPUT_SCHEMA,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 5 retries allowed, but the identical "no JSON object found" error
      // must stop the loop early: 2 identical failures -> 1 varied attempt -> abort.
      expect(result.attempts).toBeLessThan(6);
      expect(result.error).toMatch(/identical parse error repeated/);
      expect(result.rawAttempts.length).toBe(result.attempts);
    }
    // The varied-strategy prompt is schema-only with a first-token constraint.
    expect(minimalRepairPrompt(RENDER_OUTPUT_SCHEMA)).toMatch(/Begin your response with \{/);
  });

  it("parseErrorSignature collapses position numbers", () => {
    expect(parseErrorSignature("Expected double-quoted property name in JSON at position 37")).toBe(
      parseErrorSignature("Expected double-quoted property name in JSON at position 38"),
    );
  });

  it("resolveRender respects the turn deadline instead of hanging", async () => {
    const logger = createTestLogger();
    const world = makeTinyWorld();
    const hangingEngine = {
      resolve: () => new Promise<ConsequenceResult>(() => {}),
    } as unknown as ConsequenceEngine;
    const deps = makeTestDeps(logger, {
      consequenceEngine: hangingEngine,
      config: { ...makeTestDeps(logger).config!, turnTimeoutMs: 80, autosaveEnabled: false },
    });
    const started = Date.now();
    const out = await resolveRender(world, { actorId: "n", text: "Wave." }, deps);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10_000);
    expect(out.render.narrative).toBe("Nothing changes.");
    const events = logger.store.all().map((e) => e.event);
    expect(events).toContain("turn_deadline_exceeded");
  });
});

describe("exp6-5 state/pose/position coherence (tick 1, Phase 4)", () => {
  // Phase 4: state labels, poses, and props are engine-derived in
  // applyRenderResult — stale model-written states are impossible by
  // construction. These tests assert the structural guarantee directly.
  it("movement recomputes the state label (never the stale sitting state)", () => {
    const world = antonWorld(); // tanya: pose sit, prop laptop, rich stale state
    const tanya = world.actors.find((a) => a.id === "tanya")!;
    expect(tanya.state).toBe("sitting at her desk and working on a laptop");
    const next = applyRenderResult(
      world,
      { actorId: "tanya", text: "Stand up and walk over." },
      { narrative: "Tanya stands up and walks over.", thoughts: "Going.", reasoning: "r" },
      {
        movement: {
          from: { x: 13, y: 4 }, x: 10, y: 6,
          path: [{ x: 12, y: 5 }, { x: 10, y: 6 }],
          destination: null,
        },
        pose: "stand",
        manipulation: null,
      },
    );
    const t2 = next.actors.find((a) => a.id === "tanya")!;
    expect(t2.state).not.toBe("sitting at her desk and working on a laptop");
    expect(t2.state).toBe(describePosition(next, 10, 6, undefined, "stand"));
    expect(t2.pose).toBe("stand");
  });

  it("an engine put-down clears the prop (no stale working-on-laptop state)", () => {
    const world = antonWorld();
    const outcome = executeManipulation(world, { actorId: "tanya", text: "Put the laptop down." });
    expect(outcome).not.toBeNull();
    const next = applyRenderResult(
      world,
      { actorId: "tanya", text: "Put the laptop down." },
      { narrative: "Tanya sets the laptop down.", thoughts: "Done.", reasoning: "r" },
      { movement: null, pose: null, manipulation: outcome },
    );
    expect(next.actors.find((a) => a.id === "tanya")!.prop).toBeNull();
  });
});

describe("exp6-6 throughput engineering", () => {
  it("probeLlmEndpoint reports healthy vs dead endpoints", async () => {
    const okFetch = (async () => ({ ok: true })) as unknown as typeof fetch;
    const deadFetch = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    expect(
      await probeLlmEndpoint("https://example.com/v1", { fetchImpl: okFetch }),
    ).toBe(true);
    expect(
      await probeLlmEndpoint("https://example.com/v1", { fetchImpl: deadFetch }),
    ).toBe(false);
  });

  it("FailoverProvider fails over on transport errors, not content errors", async () => {
    const primary: LLMProvider = {
      name: "sick-primary",
      complete: async () => {
        throw new Error("sick-primary: timed out after 60000ms");
      },
    };
    const fallback: LLMProvider = {
      name: "local-fallback",
      complete: async () => '{"ok": true}',
    };
    const p = new FailoverProvider(primary, fallback);
    expect(await p.complete("s", "u")).toBe('{"ok": true}');
    expect(p.activeName).toBe("local-fallback");

    // Content/parse errors are the caller's to repair — no failover.
    const contentError: LLMProvider = {
      name: "picky-primary",
      complete: async () => {
        throw new Error("picky-primary: schema mismatch: narrative: Required");
      },
    };
    const p2 = new FailoverProvider(contentError, fallback);
    await expect(p2.complete("s", "u")).rejects.toThrow(/schema mismatch/);
    expect(p2.activeName).toBe("picky-primary");
  });

  it("per-task token budgets come from LLM_MAX_TOKENS_* env", () => {
    const cfg = resolveLlmEnv({
      LLM_MAX_TOKENS: "1500",
      LLM_MAX_TOKENS_CONSEQUENCE: "2200",
      LLM_MAX_TOKENS_SEMANTIC: "400",
    } as NodeJS.ProcessEnv);
    expect(cfg.maxTokensByTask.consequence).toBe(2200);
    expect(cfg.maxTokensByTask.semantic).toBe(400);
    expect(cfg.maxTokensByTask.proposal).toBeUndefined();
  });

  it("createProviderForTask applies the per-task token budget", () => {
    const readMaxTokens = (p: LLMProvider): number =>
      (p as unknown as { options: { maxTokens: number } }).options.maxTokens;
    const consequence = createProviderForTask(
      { LLM_BACKEND: "ollama", LLM_MAX_TOKENS_CONSEQUENCE: "2200" } as NodeJS.ProcessEnv,
      "consequence",
    );
    expect(readMaxTokens(consequence)).toBe(2200);
    // Exp-6 item 5: the global budget is doubled for thinking-class models
    // (default qwen3:14b) unless thinking is disabled — explicit per-task
    // caps always win over the multiplier.
    const semantic = createProviderForTask(
      { LLM_BACKEND: "ollama", LLM_MAX_TOKENS: "1500" } as NodeJS.ProcessEnv,
      "semantic",
    );
    expect(readMaxTokens(semantic)).toBe(3000);
    const semanticNoThink = createProviderForTask(
      { LLM_BACKEND: "ollama", LLM_MAX_TOKENS: "1500", LLM_THINK: "0" } as NodeJS.ProcessEnv,
      "semantic",
    );
    expect(readMaxTokens(semanticNoThink)).toBe(1500);
    const semanticExplicit = createProviderForTask(
      {
        LLM_BACKEND: "ollama",
        LLM_MAX_TOKENS: "1500",
        LLM_MAX_TOKENS_SEMANTIC: "400",
      } as NodeJS.ProcessEnv,
      "semantic",
    );
    expect(readMaxTokens(semanticExplicit)).toBe(400);
  });
});

describe("exp6-7 reasoning-leak guard", () => {
  it("system prompt constrains the first token and bans pipeline words", () => {
    expect(LLM_SYSTEM_PROMPT).toMatch(/Begin your response with \{/);
    expect(LLM_SYSTEM_PROMPT).toMatch(/Never write the words proposal, selection, consequence/);
  });

  it("the render suffix carries the pipeline ban", () => {
    expect(renderSuffix()).toMatch(/PIPELINE BAN/);
  });

  it("jsonMode sends response_format to the gateway", async () => {
    const captureFetch = (): { fetchImpl: typeof fetch; captured: () => Record<string, unknown> } => {
      let captured: Record<string, unknown> = {};
      const fetchImpl = (async (_url: unknown, init: unknown) => {
        captured = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }),
        };
      }) as unknown as typeof fetch;
      return { fetchImpl, captured: () => captured };
    };
    const json = captureFetch();
    const provider = new JoinGonkaProvider({ apiKey: "gk-test", jsonMode: true, fetchImpl: json.fetchImpl });
    await provider.complete("s", "u");
    expect(json.captured()["response_format"]).toEqual({ type: "json_object" });

    const plain = captureFetch();
    const plainProvider = new JoinGonkaProvider({ apiKey: "gk-test", jsonMode: false, fetchImpl: plain.fetchImpl });
    await plainProvider.complete("s", "u");
    expect("response_format" in plain.captured()).toBe(false);
  });

  it("json mode is on by default; LLM_JSON_MODE=0 disables it", async () => {
    // F13: default flipped from opt-in to opt-out.
    const captureFetch = (): { fetchImpl: typeof fetch; captured: () => Record<string, unknown> } => {
      let captured: Record<string, unknown> = {};
      const fetchImpl = (async (_url: unknown, init: unknown) => {
        captured = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }),
        };
      }) as unknown as typeof fetch;
      return { fetchImpl, captured: () => captured };
    };
    const dflt = captureFetch();
    const defaultProvider = new JoinGonkaProvider({ apiKey: "gk-test", fetchImpl: dflt.fetchImpl });
    await defaultProvider.complete("s", "u");
    expect(dflt.captured()["response_format"]).toEqual({ type: "json_object" });
  });

  it("LLM_JSON_MODE env enables json mode", () => {
    const cfg = resolveLlmEnv({ LLM_JSON_MODE: "1" } as NodeJS.ProcessEnv);
    expect(cfg.jsonMode).toBe(true);
    // F13: on by default now; explicit opt-out only.
    expect(resolveLlmEnv({} as NodeJS.ProcessEnv).jsonMode).toBe(true);
    expect(resolveLlmEnv({ LLM_JSON_MODE: "0" } as NodeJS.ProcessEnv).jsonMode).toBe(false);
    expect(resolveLlmEnv({ LLM_JSON_MODE: "false" } as NodeJS.ProcessEnv).jsonMode).toBe(false);
  });
});

describe("exp6-8 pipeline naming ban + object affordance nudge", () => {
  it("findManipulatedObjects names the laptop, not the desk, for a setup action", () => {
    const world = antonWorld();
    const found = findManipulatedObjects(world, "Walk to the desk to set up the laptop.");
    expect(found.map((o) => o.id)).toContain("anton_laptop");
    expect(found.map((o) => o.id)).not.toContain("anton_desk");
  });

  it("consequence context carries EXECUTED MANIPULATION facts (Phase 3 replaces the nudge)", () => {
    const world = antonWorld();
    // anton starts at (14,3), far from his laptop at (4,8) — walk him over.
    const anton = world.actors.find((a) => a.id === "anton")!;
    anton.x = 4; anton.y = 7;
    const action = { actorId: "anton", text: "Open the laptop and start typing." };
    const outcome = executeManipulation(world, action);
    expect(outcome).not.toBeNull();
    const ctx = buildConsequenceContext(world, action, undefined, undefined, null, null, outcome);
    expect(ctx).toContain("EXECUTED MANIPULATION");
    expect(ctx).toContain("now holds the laptop");
    expect(ctx).not.toMatch(/INCOMPLETE without its patch/);
  });

  it("consequence context states no manipulation for non-manipulation actions", () => {
    const world = antonWorld();
    const action = { actorId: "anton", text: "Walk to the door." };
    const ctx = buildConsequenceContext(world, action, undefined, undefined, null, null, null);
    expect(ctx).toContain("EXECUTED MANIPULATION: none");
  });

  it("tryCloseTruncatedJson is exported for the salvage tier", () => {
    const repaired = tryCloseTruncatedJson('{"narrative": "Hi", "actorPatches": [');
    expect(repaired).toBeDefined();
    expect(() => JSON.parse(repaired!)).not.toThrow();
    expect(() => extractJsonPayload("")).toThrow();
  });
});
