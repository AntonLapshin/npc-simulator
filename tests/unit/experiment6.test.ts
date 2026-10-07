// Regression tests for experiment-6.md action items 1-8
// (office-anton.json, JoinGonka GLM 5.3 Flash, truncated at 9/21 turns).
import { describe, expect, it } from "vitest";
import { validateConsequence } from "../../src/engine/physicalValidator.js";
import {
  findManipulatedObjects,
  normalizeQuotes,
  parseActionQuotes,
  resolveDestinationObjectId,
} from "../../src/engine/deterministicSemantics.js";
import { isQuoteGroundedInAction } from "../../src/engine/actionSemantics.js";
import {
  buildObjectAffordanceNudge,
} from "../../src/engine/contextBuilder.js";
import {
  getHonestHistoryNote,
  resolveWithValidation,
  salvageFormatCollapse,
} from "../../src/engine/turnOrchestrator.js";
import {
  CONSEQUENCE_OUTPUT_SCHEMA,
  LLM_SYSTEM_PROMPT,
  consequenceSuffix,
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
import { makeTestDeps, makeTinyWorld } from "../helpers.js";
import type { ActionSemantics, ConsequenceResult, World } from "../../src/types.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { ConsequenceEngine } from "../../src/intelligence/types.js";

function baseResult(narrative = "Something happens."): ConsequenceResult {
  return { narrative, actorPatches: [], objectPatches: [], reasoning: "r" };
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

  it("model-declared existing id outranks the fuzzy keyword fallback", async () => {
    const world = antonWorld();
    const { resolveActionSemantics } = await import(
      "../../src/engine/actionSemantics.js"
    );
    // "Head toward the desks" — no possessive, no named desk: the generic
    // fallback misranks via the ownership heuristic (tanya_desk for Tanya).
    // The model read the full world and declared anton_desk: trust it.
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "tanya", text: "Head toward the desks." },
      {
        ...baseResult("Tanya heads toward the desks."),
        actorPatches: [],
        effects: { moved: true, spoke: false, destinationObjectId: "anton_desk" },
      },
      {
        async classify(): Promise<ActionSemantics> {
          return { moves: true, speaks: false, quotedSpeech: [] };
        },
      },
      createTestLogger(),
    );
    expect(resolved.semantics!.destinationObjectId).toBe("anton_desk");
    expect(resolved.disagreements!.join(" ")).toMatch(/kept effects/);
  });

  it("explicit text mention still beats a contradicting effects id", async () => {
    const world = antonWorld();
    const { resolveActionSemantics } = await import(
      "../../src/engine/actionSemantics.js"
    );
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "tanya", text: "Head to Anton's desk and help him set up his laptop." },
      {
        ...baseResult("Tanya walks."),
        actorPatches: [],
        effects: { moved: true, spoke: false, destinationObjectId: "tanya_desk" },
      },
      {
        async classify(): Promise<ActionSemantics> {
          return { moves: true, speaks: false, quotedSpeech: [] };
        },
      },
      createTestLogger(),
    );
    expect(resolved.semantics!.destinationObjectId).toBe("anton_desk");
    expect(resolved.disagreements!.join(" ")).toMatch(/kept grounded/);
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
      schemaText: CONSEQUENCE_OUTPUT_SCHEMA,
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
    expect(minimalRepairPrompt(CONSEQUENCE_OUTPUT_SCHEMA)).toMatch(/Begin your response with \{/);
  });

  it("parseErrorSignature collapses position numbers", () => {
    expect(parseErrorSignature("Expected double-quoted property name in JSON at position 37")).toBe(
      parseErrorSignature("Expected double-quoted property name in JSON at position 38"),
    );
  });

  it("resolveWithValidation respects the turn deadline instead of hanging", async () => {
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
    const out = await resolveWithValidation(world, { actorId: "n", text: "Wave." }, deps);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10_000);
    expect(out.narrative).toBe("Nothing changes.");
    const events = logger.store.all().map((e) => e.event);
    expect(events).toContain("turn_deadline_exceeded");
  });
});

describe("exp6-4 valid-JSON-at-all-costs salvage tier", () => {
  it("salvageFormatCollapse builds a degraded payload from collapsed output", () => {
    const world = antonWorld();
    const raws = [
      'Let me analyze this. Tanya is at her desk… {"narrative": "Tanya thinks about the deadline.", "thoughts": "Need to finish this report."',
      "no JSON object found here at all",
    ];
    const salvaged = salvageFormatCollapse(
      world,
      { actorId: "tanya", text: "Glance at the clock and sigh." },
      raws,
    );
    expect(salvaged).not.toBeNull();
    expect(salvaged!.narrative).not.toBe("Nothing changes.");
    // Narrative is action-derived (never the collapsed preamble)…
    expect(salvaged!.narrative).not.toMatch(/Let me analyze/i);
    // …while donor thoughts are recovered.
    expect(
      salvaged!.actorPatches.find((p) => p.actorId === "tanya")?.thoughts,
    ).toMatch(/finish this report/);
    expect(getHonestHistoryNote(salvaged!)).toMatch(/format-collapse salvage/);
  });

  it("salvageFormatCollapse preserves action quotes verbatim", () => {
    const world = antonWorld();
    const salvaged = salvageFormatCollapse(
      world,
      { actorId: "anton", text: "Ask Tanya \u201cWhere is my desk?\u201d" },
      ["total garbage, no json"],
    );
    expect(salvaged!.narrative).toContain("Where is my desk?");
  });

  it("salvageFormatCollapse returns null with no raw attempts", () => {
    expect(
      salvageFormatCollapse(antonWorld(), { actorId: "anton", text: "Wave." }, []),
    ).toBeNull();
  });

  it("resolveWithValidation salvages a format-collapsed turn instead of falling back", async () => {
    const logger = createTestLogger();
    const world = antonWorld();
    let calls = 0;
    const collapsingEngine = {
      resolve: async () => {
        calls++;
        // Engine never parses: returns the canonical fallback husk.
        const { FALLBACK_CONSEQUENCE } = await import(
          "../../src/llm/llmConsequenceEngine.js"
        );
        return structuredClone(FALLBACK_CONSEQUENCE);
      },
      getLastRawAttempts: () => [
        'Let me analyze this. {"narrative": "broken", "thoughts": "Ugh, the gateway is slow."',
      ],
      lastResolveParsed: () => false,
    } as unknown as ConsequenceEngine;
    const deps = makeTestDeps(logger, {
      consequenceEngine: collapsingEngine,
      config: { ...makeTestDeps(logger).config!, maxRetries: 3, autosaveEnabled: false },
    });
    const out = await resolveWithValidation(
      world,
      { actorId: "tanya", text: "Glance at the clock and sigh." },
      deps,
    );
    expect(out.narrative).not.toBe("Nothing changes.");
    // Two consecutive parse failures stop the outer retry loop early —
    // no point burning all 4 engine calls on a collapsing model.
    expect(calls).toBe(2);
    const events = logger.store.all().map((e) => e.event);
    expect(events).toContain("format_salvage_applied");
  });
});

describe("exp6-5 state/pose/position coherence (tick 1)", () => {
  it("rejects a rich stale state when pose changes to stand", () => {
    const world = antonWorld(); // tanya: pose sit, prop laptop, rich state
    const v = validateConsequence(
      world,
      {
        ...baseResult("Tanya stands up and walks over."),
        actorPatches: [
          { actorId: "tanya", x: 10, y: 6, pose: "stand", prop: null, thoughts: "Going." },
        ],
        effects: { moved: true, spoke: false },
      },
      { actorId: "tanya", text: "Stand up, put the laptop down, and walk over." },
      { moves: true, speaks: false, quotedSpeech: [] },
    );
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/state still reads/);
  });

  it("rejects a stale working-on-laptop state when the prop is put down", () => {
    const world = antonWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("Tanya sets the laptop down."),
        actorPatches: [{ actorId: "tanya", prop: null, thoughts: "Done." }],
        effects: { moved: false, spoke: false },
      },
      { actorId: "tanya", text: "Put the laptop down." },
      stillSemantics(),
    );
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/prop changed/);
  });

  it("accepts a release phrasing that already describes the put-down", () => {
    const world = antonWorld();
    world.actors.find((a) => a.id === "tanya")!.state = "puts the laptop on the desk";
    const v = validateConsequence(
      world,
      {
        ...baseResult("Tanya sets the laptop down."),
        actorPatches: [{ actorId: "tanya", prop: null, thoughts: "Done." }],
        effects: { moved: false, spoke: false },
      },
      { actorId: "tanya", text: "Put the laptop down." },
      stillSemantics(),
    );
    expect(v.valid).toBe(true);
  });

  it("leaves a bare posture-word state alone (existing sit/settle contract)", () => {
    const world = makeTinyWorld(); // u: state "standing"
    const v = validateConsequence(
      world,
      {
        ...baseResult("U sits down."),
        actorPatches: [{ actorId: "u", x: 2, y: 1, pose: "sit", thoughts: "Resting." }],
        effects: { moved: false, spoke: false },
      },
      { actorId: "u", text: "Sit down." },
      stillSemantics(),
    );
    expect(v).toEqual({ valid: true, errors: [] });
  });
});

describe("exp6-6 throughput engineering", () => {
  it("the semantic judge is classified once per turn, not per retry attempt", async () => {
    const logger = createTestLogger();
    const world = makeTinyWorld();
    let judgeCalls = 0;
    let engineCalls = 0;
    const invalidThenValid: ConsequenceResult[] = [
      {
        ...baseResult("U waves."),
        actorPatches: [], // invalid: moves claimed by judge? no — make it speech-invalid instead
        effects: { moved: false, spoke: true, quotedSpeech: ["Hello there"] },
      },
      {
        ...baseResult('U says "Hello there."'),
        actorPatches: [{ actorId: "u", thoughts: "Friendly." }],
        effects: { moved: false, spoke: true, quotedSpeech: ["Hello there"] },
      },
    ];
    const deps = makeTestDeps(logger, {
      consequenceEngine: {
        resolve: async () => structuredClone(invalidThenValid[Math.min(engineCalls++, 1)]!),
      } as unknown as ConsequenceEngine,
      semanticJudge: {
        classify: async (): Promise<ActionSemantics> => {
          judgeCalls++;
          return { moves: false, speaks: true, quotedSpeech: ["Hello there"] };
        },
      },
      config: { ...makeTestDeps(logger).config!, maxRetries: 3, autosaveEnabled: false },
    });
    const out = await resolveWithValidation(world, { actorId: "u", text: 'Say "Hello there".' }, deps);
    expect(out.narrative).toContain("Hello there");
    expect(engineCalls).toBe(2); // one retry happened…
    expect(judgeCalls).toBe(1); // …but the judge ran only once
  });

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
    const semantic = createProviderForTask(
      { LLM_BACKEND: "ollama", LLM_MAX_TOKENS: "1500" } as NodeJS.ProcessEnv,
      "semantic",
    );
    expect(readMaxTokens(semantic)).toBe(1500);
  });
});

describe("exp6-7 reasoning-leak guard", () => {
  it("system prompt constrains the first token and bans pipeline words", () => {
    expect(LLM_SYSTEM_PROMPT).toMatch(/Begin your response with \{/);
    expect(LLM_SYSTEM_PROMPT).toMatch(/Never write the words proposal, selection, consequence/);
  });

  it("consequence suffixes carry the pipeline ban", () => {
    expect(consequenceSuffix("short")).toMatch(/PIPELINE BAN/);
    expect(consequenceSuffix("full")).toMatch(/PIPELINE BAN/);
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
    const plainProvider = new JoinGonkaProvider({ apiKey: "gk-test", fetchImpl: plain.fetchImpl });
    await plainProvider.complete("s", "u");
    expect("response_format" in plain.captured()).toBe(false);
  });

  it("LLM_JSON_MODE env enables json mode", () => {
    const cfg = resolveLlmEnv({ LLM_JSON_MODE: "1" } as NodeJS.ProcessEnv);
    expect(cfg.jsonMode).toBe(true);
    expect(resolveLlmEnv({} as NodeJS.ProcessEnv).jsonMode).toBe(false);
  });
});

describe("exp6-8 pipeline naming ban + object affordance nudge", () => {
  it("findManipulatedObjects names the laptop, not the desk, for a setup action", () => {
    const world = antonWorld();
    const found = findManipulatedObjects(world, "Walk to the desk to set up the laptop.");
    expect(found.map((o) => o.id)).toContain("anton_laptop");
    expect(found.map((o) => o.id)).not.toContain("anton_desk");
  });

  it("buildObjectAffordanceNudge demands the exact patch for a named object", () => {
    const world = antonWorld();
    const nudge = buildObjectAffordanceNudge(world, {
      actorId: "anton",
      text: "Open the laptop and start typing.",
    });
    expect(nudge).toContain("anton_laptop");
    expect(nudge).toMatch(/INCOMPLETE without its patch/);
  });

  it("buildObjectAffordanceNudge stays silent for non-manipulation actions", () => {
    const world = antonWorld();
    expect(
      buildObjectAffordanceNudge(world, { actorId: "anton", text: "Walk to the door." }),
    ).toBeUndefined();
  });

  it("tryCloseTruncatedJson is exported for the salvage tier", () => {
    const repaired = tryCloseTruncatedJson('{"narrative": "Hi", "actorPatches": [');
    expect(repaired).toBeDefined();
    expect(() => JSON.parse(repaired!)).not.toThrow();
    expect(() => extractJsonPayload("")).toThrow();
  });
});
