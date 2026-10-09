// Milestone 2 tests (plan.md §16.6): real LLM adapters with scripted providers.
// No network is used — a stub LLMProvider simulates valid JSON, invalid
// JSON, timeouts, schema mismatches, unknown ids, and impossible movement.
import { describe, expect, it } from "vitest";
import { createTestLogger } from "../../src/logging/logger.js";
import { resolveRender } from "../../src/engine/turnOrchestrator.js";
import { defaultConfig } from "../../src/config.js";
import { loadOfficeScenario, makeTinyWorld } from "../helpers.js";
import {
  extractJsonPayload,
  LLMConsequenceEngine,
  LLMIntentEngine,
  JoinGonkaProvider,
  LocalLayaProvider,
  resolveLlmEnv,
  type LLMProvider,
} from "../../src/llm/index.js";
import {
  applyInputCap,
  backoffDelayMs,
  completeJson,
  DEFAULT_MAX_INPUT_CHARS,
} from "../../src/llm/complete.js";
import { consequenceResultSchema } from "../../src/schemas.js";
import type { LlmUsage } from "../../src/logging/logTypes.js";

class StubProvider implements LLMProvider {
  readonly name = "stub";
  calls: Array<{ system: string; user: string }> = [];
  /** F31: usage returned (once) by takeLastUsage. */
  usage?: LlmUsage;

  constructor(private readonly script: Array<string | Error>) {}

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    this.calls.push({ system: systemPrompt, user: userPrompt });
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("stub provider exhausted");
    return next;
  }

  takeLastUsage(): LlmUsage | undefined {
    const u = this.usage;
    this.usage = undefined;
    return u;
  }
}

const proposalJson = JSON.stringify({
  suggestions: ["Introduce yourself to the office.", "Walk toward Ana."],
  reasoning: "Jeff wants to make a good first impression.",
});

const intentJson = JSON.stringify({
  action: "Introduce himself to the office.",
  quote: "",
});

const consequenceJson = JSON.stringify({
  narrative: "Jeff introduces himself to the office.",
  thoughts: "Hope they take it well.",
  emotion: "nervous",
  reasoning: "Speech in a shared room is heard by everyone nearby.",
});

describe("llm json extraction", () => {
  it("unwraps markdown fences and surrounding prose", () => {
    expect(extractJsonPayload("```json\n" + proposalJson + "\n```")).toBe(proposalJson);
    expect(extractJsonPayload(`Sure! Here you go:\n${proposalJson}\nDone.`)).toBe(proposalJson);
  });

  it("rejects empty and severely truncated responses", () => {
    expect(() => extractJsonPayload("   ")).toThrow();
    expect(() => extractJsonPayload('{"suggestions": ')).toThrow();
    expect(() => extractJsonPayload("no json here")).toThrow();
  });

  it("repairs max_tokens-truncated tails (unclosed final string)", () => {
    const truncated = `{"action": "Say hello.", "reasoning": "To gauge the situation without adding to his stress`;
    const payload = extractJsonPayload(truncated);
    expect(JSON.parse(payload)).toMatchObject({ action: "Say hello." });
  });
});

describe("provider configuration", () => {
  it("defaults to JoinGonka zai-org/GLM-5.3-Flash", () => {
    const cfg = resolveLlmEnv({} as NodeJS.ProcessEnv);
    expect(cfg.backend).toBe("joingonka");
    expect(cfg.joingonka.model).toBe("zai-org/GLM-5.3-Flash");
    expect(cfg.joingonka.baseUrl).toContain("joingonka");
  });

  it("JoinGonka requires an API key; Laya runs keyless locally", () => {
    expect(() => new JoinGonkaProvider({ apiKey: "" })).toThrow();
    const laya = new LocalLayaProvider();
    expect(laya.name).toBe("laya-local");
    expect(laya.model).toBe("laya");
  });

  it("surfaces rate limits and empty responses as errors", async () => {
    const rateLimited = new JoinGonkaProvider({
      apiKey: "test",
      fetchImpl: (async () => ({ ok: false, status: 429, text: async () => "" })) as unknown as typeof fetch,
    });
    await expect(rateLimited.complete("s", "u")).rejects.toThrow(/rate limited/i);

    const empty = new LocalLayaProvider({
      fetchImpl: (async () =>
        ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: " " } }] }) })) as unknown as typeof fetch,
    });
    await expect(empty.complete("s", "u")).rejects.toThrow(/empty response/i);
  });
});

describe("LLM intent engine", () => {
  it("returns valid JSON output and logs prompt + raw + parsed response", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider(["Here is my answer:\n```json\n" + intentJson + "\n```"]);
    const engine = new LLMIntentEngine(logger, provider);

    const result = await engine.intent(loadOfficeScenario(), "jeff");

    expect(result.action).toBe("Introduce himself to the office.");
    expect(result.quote).toBe("");
    expect(provider.calls).toHaveLength(1);

    const events = logger.store.events();
    expect(events).toContain("intent_started");
    expect(events).toContain("intent_completed");
    const completed = logger.store.byEvent("intent_completed")[0]!;
    expect(completed.prompt).toContain("TASK:");
    expect(completed.rawResponse).toContain("action");
    expect(completed.parsedResponse).toMatchObject({ action: result.action });
  });

  it("retries invalid JSON then succeeds", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider(["definitely not json", intentJson]);
    const engine = new LLMIntentEngine(logger, provider, { maxRetries: 3 });

    const result = await engine.intent(makeTinyWorld(), "u");

    expect(result.action.length).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(2);
    // completeJson logs one per-attempt failure for the bad-JSON attempt.
    expect(logger.store.byEvent("intent_failed")).toHaveLength(1);
    // Formatting-correction retry carries the repair instruction.
    expect(provider.calls[1]!.user).toContain("not valid JSON");
  });

  it("falls back after repeated timeouts without crashing", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      new Error("stub: timed out after 60000ms"),
      new Error("stub: timed out after 60000ms"),
    ]);
    const engine = new LLMIntentEngine(logger, provider, { maxRetries: 1 });

    const result = await engine.intent(makeTinyWorld(), "u");

    expect(result.action).toBe("waits and observes the situation.");
    expect(result.quote).toBe("");
    // Two timed-out attempts (one intent_failed each) + the engine's final
    // fallback log.
    expect(logger.store.byEvent("intent_failed")).toHaveLength(3);
    expect(provider.calls).toHaveLength(2);
  });

  it("falls back on schema mismatch", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({ suggestions: ["Wave."], reasoning: "x" }),
      JSON.stringify({ nope: true }),
    ]);
    const engine = new LLMIntentEngine(logger, provider, { maxRetries: 1 });

    const result = await engine.intent(makeTinyWorld(), "u");
    expect(result.action).toBe("waits and observes the situation.");
  });
});

describe("LLM consequence engine + validation retry", () => {
  it("returns valid consequences and logs the full chain", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([consequenceJson]);
    const engine = new LLMConsequenceEngine(logger, provider);
    const world = loadOfficeScenario();

    const result = await engine.resolve(world, { actorId: "jeff", text: "Hello!" });

    expect(result.narrative).toContain("introduces himself");
    expect(logger.store.events()).toContain("consequence_started");
    expect(logger.store.events()).toContain("consequence_completed");
  });

  it("prose violation triggers validation feedback on retry, then accept-and-mark", async () => {
    const logger = createTestLogger();
    // Phase 4: the narrative claims a walk the engine never executed — a
    // prose violation (movement is engine-owned). Old-schema patch keys
    // are stripped, never validated.
    const bad = JSON.stringify({
      narrative: "U walks across the room.",
      actorPatches: [{ actorId: "ghost", emotion: "spooky" }],
      objectPatches: [],
      reasoning: "Ghost patch.",
    });
    const provider = new StubProvider([bad, bad]);
    const deps = {
      intentEngine: new LLMIntentEngine(logger, provider),
      consequenceEngine: new LLMConsequenceEngine(logger, provider),
      logger,
      config: { ...defaultConfig, autosaveEnabled: false, maxRetries: 1 },
    };
    const world = makeTinyWorld();

    const result = await resolveRender(world, { actorId: "u", text: "Wave." }, deps);

    // PLAN_V2 Phase 4: the flawed paragraph is accepted and marked honest.
    expect(result.render.narrative).toBe("U walks across the room.");
    expect(result.render.narrateAcceptedDespiteViolations).toBe(true);
    expect(provider.calls).toHaveLength(2);
    // The second attempt carries the validator's feedback (§16.3/§16.5).
    expect(provider.calls[1]!.user).toContain("movement.narrated_without_move");
    const events = logger.store.events();
    expect(events).toContain("render_failed");
    expect(events).toContain("retry_started");
    expect(events).toContain("narrate_accepted_despite_violations");
    expect(events).not.toContain("fallback_used");
  });

  it("dishonest movement narration is rejected and retried with feedback", async () => {
    const logger = createTestLogger();
    // Phase 1: the model never emits coordinates (they are stripped), so
    // "impossible movement" is now a NARRATIVE lie — the story claims a
    // walk the engine did not perform.
    const dishonest = JSON.stringify({
      narrative: "U walks across the room.",
      thoughts: "Sneaky.",
      reasoning: "Sneaky.",
    });
    const validTiny = JSON.stringify({
      narrative: "U stays put and looks around.",
      thoughts: "Calm.",
      reasoning: "No movement was needed.",
    });
    const provider = new StubProvider([dishonest, validTiny]);
    const deps = {
      intentEngine: new LLMIntentEngine(logger, provider),
      consequenceEngine: new LLMConsequenceEngine(logger, provider),
      logger,
      config: { ...defaultConfig, autosaveEnabled: false, maxRetries: 1 },
    };

    const result = await resolveRender(
      makeTinyWorld(),
      { actorId: "u", text: "Look around." },
      deps,
    );

    // Second attempt was valid, so no fallback was needed.
    expect(result.render.narrative).toContain("looks around");
    expect(provider.calls[1]!.user).toMatch(/describes movement/i);
  });
});

describe("lenient consequence parsing for small models", () => {
  it("accepts missing reasoning (defaults to empty)", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({
        narrative: "U waves hello.",
        actorPatches: [{ actorId: "u", thoughts: "Friendly." }],
        objectPatches: [],
      }),
    ]);
    const engine = new LLMConsequenceEngine(logger, provider);
    const result = await engine.resolve(makeTinyWorld(), { actorId: "u", text: "Wave." });
    expect(result.narrative).toContain("waves hello");
    expect(logger.store.events()).toContain("consequence_completed");
  });

  it("accepts id aliases for actorId/objectId", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({
        narrative: "U looks around.",
        actorPatches: [{ id: "u", thoughts: "Quiet room." }],
        objectPatches: [],
        reasoning: "No movement needed.",
      }),
    ]);
    const engine = new LLMConsequenceEngine(logger, provider);
    const result = await engine.resolve(makeTinyWorld(), { actorId: "u", text: "Look." });
    expect(result.narrative).toContain("looks around");
    expect(logger.store.events()).toContain("consequence_completed");
  });

  it("accepts stringified patch arrays", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({
        narrative: "U nods.",
        actorPatches: JSON.stringify([{ actorId: "u", thoughts: "Agreed." }]),
        objectPatches: "[]",
        reasoning: "A nod is silent.",
      }),
    ]);
    const engine = new LLMConsequenceEngine(logger, provider);
    const result = await engine.resolve(makeTinyWorld(), { actorId: "u", text: "Nod." });
    expect(result.narrative).toContain("nods");
    expect(logger.store.events()).toContain("consequence_completed");
  });

  it("hoists objectPatches nested inside an actor patch element", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({
        narrative: "U nods.",
        actorPatches: [{ actorId: "u", thoughts: "Agreed.", objectPatches: [] }],
        objectPatches: [],
        reasoning: "A nod is silent.",
      }),
    ]);
    const engine = new LLMConsequenceEngine(logger, provider);
    const result = await engine.resolve(makeTinyWorld(), { actorId: "u", text: "Nod." });
    expect(result.narrative).toContain("nods");
    expect(logger.store.events()).toContain("consequence_completed");
  });

  it("extracts doubled key-delimiter quotes ([{\"\"actorId\"\"...}])", () => {
    const raw = '{"narrative": "U nods.", "actorPatches": [{""actorId"": "u"}], "objectPatches": [], "reasoning": "ok"}';
    const payload = extractJsonPayload(raw);
    expect(JSON.parse(payload)).toMatchObject({ narrative: "U nods." });
  });
});

describe("subjective vs objective contexts (§16.6)", () => {
  it("intent hides other actors' private knowledge; narrate sees executed facts, not far privates", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([intentJson, consequenceJson]);
    const world = loadOfficeScenario();
    const intent = new LLMIntentEngine(logger, provider);
    const consequence = new LLMConsequenceEngine(logger, provider);

    await intent.intent(world, "jeff");
    await consequence.resolve(world, { actorId: "jeff", text: "Hello!" });

    const intentPrompt = provider.calls[0]!.user;
    const narratePrompt = provider.calls[1]!.user;

    // Dan's private beliefs/goals must not leak into Jeff's intent prompt.
    expect(intentPrompt).not.toContain("The design deadline is close.");
    expect(intentPrompt).not.toContain("Finish an urgent design draft.");
    // The narrate prompt carries executed facts and positions, not
    // compounding private lists of far actors (Dan is ~14 cells away).
    expect(narratePrompt).toContain("All actor positions");
    expect(narratePrompt).not.toContain("The design deadline is close.");
  });
});

describe("F11 retry backoff", () => {
  it("backoffDelayMs is exponential with jitter, capped at 8s", () => {
    const d1 = backoffDelayMs(1, new Error("x: timed out after 60000ms"));
    expect(d1).toBeGreaterThanOrEqual(2000);
    expect(d1).toBeLessThan(3000);
    const d2 = backoffDelayMs(2, new Error("socket hang up"));
    expect(d2).toBeGreaterThanOrEqual(4000);
    expect(d2).toBeLessThan(5000);
    const d10 = backoffDelayMs(10, new Error("fetch failed"));
    expect(d10).toBeGreaterThanOrEqual(8000);
    expect(d10).toBeLessThan(9000);
  });

  it("HTTP 429 honors Retry-After (capped at 30s); without it, backs off up to 30s", () => {
    const withHeader = backoffDelayMs(1, new Error("gw: rate limited (HTTP 429, retry after 5s)"));
    expect(withHeader).toBeGreaterThanOrEqual(5000);
    expect(withHeader).toBeLessThan(6000);
    const huge = backoffDelayMs(1, new Error("gw: rate limited (HTTP 429, retry after 120s)"));
    expect(huge).toBeGreaterThanOrEqual(30_000);
    expect(huge).toBeLessThan(31_000);
    const noHeader = backoffDelayMs(1, new Error("gw: rate limited (HTTP 429)"));
    expect(noHeader).toBeGreaterThanOrEqual(2000);
    expect(noHeader).toBeLessThan(31_000);
    const late = backoffDelayMs(9, new Error("gw: rate limited (HTTP 429)"));
    expect(late).toBeGreaterThanOrEqual(30_000);
    expect(late).toBeLessThan(31_000);
  });

  it("completeJson sleeps between transport-failure attempts", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      new Error("stub: timed out after 60000ms"),
      consequenceJson,
    ]);
    const started = Date.now();
    const result = await completeJson({
      logger,
      provider,
      module: "consequence",
      tick: 0,
      turnIndex: 0,
      systemPrompt: "s",
      userPrompt: "u",
      maxRetries: 1,
      schema: consequenceResultSchema,
    });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    // One backoff between the two attempts: min(1000 * 2^1, 8000) + jitter.
    expect(elapsed).toBeGreaterThanOrEqual(1900);
  });
});

describe("F15 lenient-repair logging", () => {
  it("logs a consequence_lenient_repair record naming repairs with a payload fingerprint", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({
        narrative: "U waves.",
        thoughts: "Friendly.",
        actorPatches: [{ id: "u", thoughts: "Friendly.", bogus: 1 }],
        objectPatches: [],
        // reasoning omitted on purpose → defaulted
      }),
    ]);
    const result = await completeJson({
      logger,
      provider,
      module: "consequence",
      tick: 0,
      turnIndex: 0,
      systemPrompt: "s",
      userPrompt: "u",
      maxRetries: 0,
      schema: consequenceResultSchema,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.thoughts).toBe("Friendly.");
      expect(result.value).not.toHaveProperty("actorPatches");
    }
    const repairs = logger.store.byEvent("consequence_lenient_repair");
    expect(repairs).toHaveLength(1);
    const error = repairs[0]!.error ?? "";
    expect(error).toMatch(/dropped unknown key "actorPatches"/);
    expect(error).toMatch(/dropped unknown key "objectPatches"/);
    expect(error).toMatch(/defaulted missing\/non-string reasoning/);
    expect(error).toMatch(/payload fingerprint: [0-9a-f]{8}/);
  });

  it("warns loudly on unknown old-schema keys and strips them", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({
        narrative: "U waves.",
        actorPatches: [],
        objectPatches: [],
        reasoning: "r",
        effects: "this is not json",
      }),
    ]);
    const result = await completeJson({
      logger,
      provider,
      module: "consequence",
      tick: 0,
      turnIndex: 0,
      systemPrompt: "s",
      userPrompt: "u",
      maxRetries: 0,
      schema: consequenceResultSchema,
    });
    // Still parses: the prose contract keeps narrative/reasoning.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.narrative).toBe("U waves.");
      expect(result.value).not.toHaveProperty("effects");
    }
    const repairs = logger.store.byEvent("consequence_lenient_repair");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.error ?? "").toMatch(/dropped unknown key "effects"/);
  });

  it("stays silent when nothing was repaired", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([consequenceJson]);
    const result = await completeJson({
      logger,
      provider,
      module: "consequence",
      tick: 0,
      turnIndex: 0,
      systemPrompt: "s",
      userPrompt: "u",
      maxRetries: 0,
      schema: consequenceResultSchema,
    });
    expect(result.ok).toBe(true);
    expect(logger.store.byEvent("consequence_lenient_repair")).toHaveLength(0);
  });
});

describe("F31 usage capture", () => {
  function usageFetch(usage: unknown): typeof fetch {
    return (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }],
        usage,
      }),
    })) as unknown as typeof fetch;
  }

  it("captures prompt/completion/total tokens from the chat-completions response", async () => {
    const provider = new JoinGonkaProvider({
      apiKey: "gk-test",
      fetchImpl: usageFetch({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }),
    });
    await provider.complete("s", "u");
    expect(provider.takeLastUsage()).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
    });
    // Drained on read.
    expect(provider.takeLastUsage()).toBeUndefined();
  });

  it("derives total tokens when the backend omits it; undefined when no usage block", async () => {
    const derived = new JoinGonkaProvider({
      apiKey: "gk-test",
      fetchImpl: usageFetch({ prompt_tokens: 100, completion_tokens: 25 }),
    });
    await derived.complete("s", "u");
    expect(derived.takeLastUsage()).toEqual({
      promptTokens: 100,
      completionTokens: 25,
      totalTokens: 125,
    });
    const none = new JoinGonkaProvider({
      apiKey: "gk-test",
      fetchImpl: usageFetch(undefined),
    });
    await none.complete("s", "u");
    expect(none.takeLastUsage()).toBeUndefined();
  });

  it("logs per-call usage on the completed record", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([consequenceJson]);
    provider.usage = { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 };
    const engine = new LLMConsequenceEngine(logger, provider);
    await engine.resolve(makeTinyWorld(), { actorId: "u", text: "Wave." });
    const completed = logger.store.byEvent("consequence_completed")[0]!;
    expect(completed.usage).toEqual({
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1200,
    });
  });
});

describe("F33 input cap", () => {
  it("leaves prompts under the cap untouched", () => {
    const out = applyInputCap("sys", "user", "tail", DEFAULT_MAX_INPUT_CHARS);
    expect(out.truncated).toBe(false);
    expect(out.userPrompt).toBe("user");
  });

  it("truncates the world-dump head but keeps the engine suffix intact", () => {
    const suffix = "\n\nReturn JSON only.";
    const user = `${"world dump ".repeat(500)}${suffix}`;
    const out = applyInputCap("sys", user, suffix, 1000);
    expect(out.truncated).toBe(true);
    expect(out.originalChars).toBe("sys".length + 2 + user.length);
    expect(out.userPrompt.endsWith(suffix)).toBe(true);
    expect(out.userPrompt).toContain("[truncated: prompt exceeded LLM_MAX_INPUT_CHARS=1000]");
    expect(out.userPrompt.length).toBeLessThanOrEqual(1000);
  });

  it("without a clean section boundary, protects a trailing instruction window", () => {
    const user = `${"a".repeat(5000)}TAIL${"b".repeat(500)}`;
    const out = applyInputCap("sys", user, undefined, 1000);
    expect(out.truncated).toBe(true);
    expect(out.userPrompt.endsWith(`TAIL${"b".repeat(500)}`)).toBe(true);
    expect(out.userPrompt).toContain("[truncated: prompt exceeded LLM_MAX_INPUT_CHARS=");
  });

  it("completeJson logs a truncation warning and sends the truncated prompt", async () => {
    const logger = createTestLogger();
    const suffix = "\n\nReturn JSON only.";
    const user = `${"world dump ".repeat(500)}${suffix}`;
    const provider = new StubProvider([consequenceJson]);
    const result = await completeJson({
      logger,
      provider,
      module: "consequence",
      tick: 0,
      turnIndex: 0,
      systemPrompt: "s",
      userPrompt: user,
      suffix,
      maxInputChars: 1000,
      maxRetries: 0,
      schema: consequenceResultSchema,
    });
    expect(result.ok).toBe(true);
    const warnings = logger.store.byEvent("consequence_prompt_truncated");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.error ?? "").toMatch(/LLM_MAX_INPUT_CHARS=1000/);
    const sent = provider.calls[0]!.user;
    expect(sent).toContain("[truncated: prompt exceeded LLM_MAX_INPUT_CHARS=1000]");
    expect(sent.endsWith(suffix)).toBe(true);
  });
});
