// Milestone 2 tests (plan.md §16.6): real LLM adapters with scripted providers.
// No network is used — a stub LLMProvider simulates valid JSON, invalid
// JSON, timeouts, schema mismatches, unknown ids, and impossible movement.
import { describe, expect, it } from "vitest";
import { createTestLogger } from "../../src/logging/logger.js";
import { resolveWithValidation } from "../../src/engine/turnOrchestrator.js";
import { defaultConfig } from "../../src/config.js";
import { loadOfficeScenario, makeTinyWorld } from "../helpers.js";
import {
  extractJsonPayload,
  LLMConsequenceEngine,
  LLMProposalEngine,
  LLMSelectionEngine,
  JoinGonkaProvider,
  LocalLayaProvider,
  resolveLlmEnv,
  type LLMProvider,
} from "../../src/llm/index.js";

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

const proposalJson = JSON.stringify({
  suggestions: ["Introduce yourself to the office.", "Walk toward Ana."],
  reasoning: "Jeff wants to make a good first impression.",
});

const selectionJson = JSON.stringify({
  action: "Introduce yourself to the office.",
  reasoning: "Breaking the silence fits Jeff's goal.",
});

const consequenceJson = JSON.stringify({
  narrative: "Jeff introduces himself to the office.",
  actorPatches: [
    {
      actorId: "jeff",
      memoriesAppend: ["Introduced himself aloud to the office."],
    },
  ],
  objectPatches: [],
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

describe("LLM proposal engine", () => {
  it("returns valid JSON output and logs prompt + raw + parsed response", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider(["Here is my answer:\n```json\n" + proposalJson + "\n```"]);
    const engine = new LLMProposalEngine(logger, provider);

    const result = await engine.propose(loadOfficeScenario(), "jeff");

    expect(result.suggestions).toHaveLength(2);
    expect(result.reasoning).toContain("first impression");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.system).toContain("uncensored");

    const events = logger.store.events();
    expect(events).toContain("proposal_started");
    expect(events).toContain("proposal_completed");
    const completed = logger.store.byEvent("proposal_completed")[0]!;
    expect(completed.prompt).toContain("Current Actor");
    expect(completed.rawResponse).toContain("suggestions");
    expect(completed.parsedResponse).toMatchObject({ reasoning: result.reasoning });
  });

  it("retries invalid JSON then succeeds", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider(["definitely not json", proposalJson]);
    const engine = new LLMProposalEngine(logger, provider, { maxRetries: 3 });

    const result = await engine.propose(makeTinyWorld(), "u");

    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(2);
    expect(logger.store.byEvent("proposal_failed")).toHaveLength(1);
    // Formatting-correction retry carries the repair instruction.
    expect(provider.calls[1]!.user).toContain("not valid JSON");
  });

  it("falls back after repeated timeouts without crashing", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      new Error("stub: timed out after 60000ms"),
      new Error("stub: timed out after 60000ms"),
    ]);
    const engine = new LLMProposalEngine(logger, provider, { maxRetries: 1 });

    const result = await engine.propose(makeTinyWorld(), "u");

    expect(result.suggestions).toEqual(["Stay where you are.", "Look around.", "Do nothing."]);
    expect(result.reasoning).toContain("Fallback");
    expect(provider.calls).toHaveLength(2);
  });

  it("falls back on schema mismatch", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({ suggestions: "not-an-array", reasoning: "x" }),
      JSON.stringify({ nope: true }),
    ]);
    const engine = new LLMProposalEngine(logger, provider, { maxRetries: 1 });

    const result = await engine.propose(makeTinyWorld(), "u");
    expect(result.reasoning).toContain("Fallback");
  });
});

describe("LLM selection engine", () => {
  it("retries empty action text then accepts a real action", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({ action: "   ", reasoning: "empty" }),
      selectionJson,
    ]);
    const engine = new LLMSelectionEngine(logger, provider);

    const result = await engine.select(loadOfficeScenario(), "jeff", ["Introduce yourself."]);

    expect(result.action).toBe("Introduce yourself to the office.");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.user).toContain("empty action text");
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

  it("unknown actor id triggers validation feedback on retry, then fallback", async () => {
    const logger = createTestLogger();
    const bad = JSON.stringify({
      narrative: "A ghost acts.",
      actorPatches: [{ actorId: "ghost", emotion: "spooky" }],
      objectPatches: [],
      reasoning: "Ghost patch.",
    });
    const provider = new StubProvider([bad, bad]);
    const deps = {
      proposalEngine: new LLMProposalEngine(logger, provider),
      selectionEngine: new LLMSelectionEngine(logger, provider),
      consequenceEngine: new LLMConsequenceEngine(logger, provider),
      logger,
      config: { ...defaultConfig, autosaveEnabled: false, maxRetries: 1 },
    };
    const world = makeTinyWorld();

    const result = await resolveWithValidation(world, { actorId: "u", text: "Wave." }, deps);

    expect(result.narrative).toBe("Nothing changes.");
    expect(provider.calls).toHaveLength(2);
    // The second attempt carries the validator's feedback (§16.3/§16.5).
    expect(provider.calls[1]!.user).toContain("unknown actor id: ghost");
    const events = logger.store.events();
    expect(events).toContain("validation_failed");
    expect(events).toContain("retry_started");
    expect(events).toContain("fallback_used");
  });

  it("impossible movement is rejected and retried with feedback", async () => {
    const logger = createTestLogger();
    const teleport = JSON.stringify({
      narrative: "U teleports across the map.",
      actorPatches: [{ actorId: "u", x: 999, y: 999 }],
      objectPatches: [],
      reasoning: "Teleport.",
    });
    const validTiny = JSON.stringify({
      narrative: "U stays put and looks around.",
      actorPatches: [{ actorId: "u", memoriesAppend: ["Looked around the room."] }],
      objectPatches: [],
      reasoning: "No movement was needed.",
    });
    const provider = new StubProvider([teleport, validTiny]);
    const deps = {
      proposalEngine: new LLMProposalEngine(logger, provider),
      selectionEngine: new LLMSelectionEngine(logger, provider),
      consequenceEngine: new LLMConsequenceEngine(logger, provider),
      logger,
      config: { ...defaultConfig, autosaveEnabled: false, maxRetries: 1 },
    };

    const result = await resolveWithValidation(
      makeTinyWorld(),
      { actorId: "u", text: "Teleport." },
      deps,
    );

    // Second attempt was valid, so no fallback was needed.
    expect(result.narrative).toContain("looks around");
    expect(provider.calls[1]!.user).toMatch(/outside scene bounds|no valid path/i);
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
  it("proposal/selection hide other actors' private knowledge; consequence sees all", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([proposalJson, selectionJson, consequenceJson]);
    const world = loadOfficeScenario();
    const proposal = new LLMProposalEngine(logger, provider);
    const selection = new LLMSelectionEngine(logger, provider);
    const consequence = new LLMConsequenceEngine(logger, provider);

    await proposal.propose(world, "jeff");
    await selection.select(world, "jeff", ["Introduce yourself."]);
    await consequence.resolve(world, { actorId: "jeff", text: "Hello!" });

    const proposalPrompt = provider.calls[0]!.user;
    const selectionPrompt = provider.calls[1]!.user;
    const consequencePrompt = provider.calls[2]!.user;

    // Dan's private beliefs/goals must not leak into Jeff's subjective context.
    for (const prompt of [proposalPrompt, selectionPrompt]) {
      expect(prompt).not.toContain("The design deadline is close.");
      expect(prompt).not.toContain("Finish an urgent design draft.");
    }
    // The consequence engine receives the full objective world.
    expect(consequencePrompt).toContain("The design deadline is close.");
    expect(consequencePrompt).toContain("Finish an urgent design draft.");
  });
});
