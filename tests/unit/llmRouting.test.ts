// Tiered LLM routing: hard tasks (proposal/consequence) on the hosted
// large model, simple tasks (selection/semantic) on the local small model.
import { describe, expect, it } from "vitest";
import { createTestLogger } from "../../src/logging/logger.js";
import {
  createLlmEngines,
  createProviderForTask,
  createProviderForTaskWithFailover,
  DEFAULT_TASK_TEMPERATURES,
  FailoverProvider,
  isSimpleLlmTask,
  resolveLlmEnv,
  resolveTaskBackend,
  resolveTaskTemperature,
  type LLMProvider,
} from "../../src/llm/index.js";
import { OllamaProvider } from "../../src/llm/provider.js";

class StubProvider implements LLMProvider {
  readonly name = "stub";
  constructor(private readonly reply: string) {}
  async complete(): Promise<string> {
    return this.reply;
  }
}

describe("tiered routing defaults", () => {
  it("hard tasks default to LLM_BACKEND, simple tasks to LLM_SIMPLE_BACKEND (local)", () => {
    const cfg = resolveLlmEnv({} as NodeJS.ProcessEnv);
    expect(cfg.backend).toBe("joingonka");
    expect(cfg.simpleBackend).toBe("ollama");
    expect(resolveTaskBackend("proposal", cfg)).toBe("joingonka");
    expect(resolveTaskBackend("consequence", cfg)).toBe("joingonka");
    expect(resolveTaskBackend("selection", cfg)).toBe("ollama");
    expect(resolveTaskBackend("semantic", cfg)).toBe("ollama");
    expect(isSimpleLlmTask("selection")).toBe(true);
    expect(isSimpleLlmTask("semantic")).toBe(true);
    expect(isSimpleLlmTask("proposal")).toBe(false);
    expect(isSimpleLlmTask("consequence")).toBe(false);
  });

  it("per-task LLM_BACKEND_* overrides win over tier defaults", () => {
    const cfg = resolveLlmEnv({
      LLM_BACKEND: "joingonka",
      LLM_SIMPLE_BACKEND: "ollama",
      LLM_BACKEND_SELECTION: "laya-local",
      LLM_BACKEND_SEMANTIC: "joingonka",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.taskBackends.selection).toBe("laya-local");
    expect(cfg.taskBackends.semantic).toBe("joingonka");
    expect(resolveTaskBackend("selection", cfg)).toBe("laya-local");
    expect(resolveTaskBackend("semantic", cfg)).toBe("joingonka");
    // Untouched tasks keep tier defaults.
    expect(resolveTaskBackend("proposal", cfg)).toBe("joingonka");
    expect(resolveTaskBackend("consequence", cfg)).toBe("joingonka");
  });

  it("LLM_SIMPLE_MODEL overrides the model for simple tasks only", () => {
    const cfg = resolveLlmEnv({
      LLM_SIMPLE_MODEL: "huihui_ai/llama3.2-abliterate:3b",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.simpleModel).toBe("huihui_ai/llama3.2-abliterate:3b");
  });

  it("createProviderForTask builds a local provider for simple tasks by default", () => {
    const simple = createProviderForTask({} as NodeJS.ProcessEnv, "selection");
    expect(simple.name).toBe("ollama");
    const semantic = createProviderForTask({} as NodeJS.ProcessEnv, "semantic");
    expect(semantic.name).toBe("ollama");
  });

  it("createProviderForTask applies LLM_SIMPLE_MODEL to simple tasks", () => {
    const env = {
      LLM_SIMPLE_MODEL: "huihui_ai/llama3.2-abliterate:3b",
    } as unknown as NodeJS.ProcessEnv;
    const provider = createProviderForTask(env, "selection") as OllamaProvider;
    expect(provider.name).toBe("ollama");
    expect(provider.model).toBe("huihui_ai/llama3.2-abliterate:3b");
  });

  it("createLlmEngines wires all four engines and honors explicit per-task providers", async () => {
    const logger = createTestLogger();
    const proposalStub = new StubProvider(
      JSON.stringify({ suggestions: ["Wave.", "Nod."], reasoning: "test" }),
    );
    const selectionStub = new StubProvider(JSON.stringify({ action: "Wave.", reasoning: "test" }));
    const consequenceStub = new StubProvider(
      JSON.stringify({ narrative: "U waves.", actorPatches: [], objectPatches: [], reasoning: "test" }),
    );
    const semanticStub = new StubProvider(
      JSON.stringify({ moves: false, speaks: false, quotedSpeech: [] }),
    );
    const engines = createLlmEngines(logger, {
      providers: {
        proposal: proposalStub,
        selection: selectionStub,
        consequence: consequenceStub,
        semantic: semanticStub,
      },
    });
    expect(engines.semanticJudge).toBeDefined();
    const { makeTinyWorld } = await import("../helpers.js");
    const world = makeTinyWorld();
    await expect(engines.proposalEngine.propose(world, "u")).resolves.toMatchObject({
      suggestions: ["Wave.", "Nod."],
    });
    await expect(engines.selectionEngine.select(world, "u", ["Wave."])).resolves.toMatchObject({
      action: "Wave.",
    });
    await expect(
      engines.consequenceEngine.resolve(world, { actorId: "u", text: "Wave." }),
    ).resolves.toMatchObject({ narrative: "U waves." });
    await expect(
      engines.semanticJudge.classify(world, { actorId: "u", text: "Wave." }),
    ).resolves.toMatchObject({ moves: false });
  });
});

describe("F12 failover wiring", () => {
  it("FailoverProvider and createProviderForTaskWithFailover are exported from the llm index", () => {
    expect(typeof FailoverProvider).toBe("function");
    expect(typeof createProviderForTaskWithFailover).toBe("function");
  });

  it("createLlmEngines wraps providers with failover when LLM_FAILOVER_BACKEND is set", () => {
    const logger = createTestLogger();
    const env = {
      JOINGONKA_API_KEY: "gk-test",
      LLM_FAILOVER_BACKEND: "laya-local",
    } as unknown as NodeJS.ProcessEnv;
    const engines = createLlmEngines(logger, { env });
    // Consequence is a hard task: primary joingonka, failover laya-local.
    const consequenceProvider = (engines.consequenceEngine as unknown as { provider: LLMProvider })
      .provider;
    expect(consequenceProvider).toBeInstanceOf(FailoverProvider);
    expect(consequenceProvider.name).toBe("failover(joingonka→laya-local)");
    // Semantic is a simple task: primary ollama, failover laya-local.
    const semanticProvider = (engines.semanticJudge as unknown as { provider: LLMProvider }).provider;
    expect(semanticProvider).toBeInstanceOf(FailoverProvider);
    expect(semanticProvider.name).toBe("failover(ollama→laya-local)");
  });

  it("no wrapper when the failover backend equals the task's resolved backend", () => {
    const logger = createTestLogger();
    const env = {
      JOINGONKA_API_KEY: "gk-test",
      LLM_FAILOVER_BACKEND: "ollama",
    } as unknown as NodeJS.ProcessEnv;
    const engines = createLlmEngines(logger, { env });
    // Semantic already resolves to ollama — nothing distinct to fail over to.
    const semanticProvider = (engines.semanticJudge as unknown as { provider: LLMProvider }).provider;
    expect(semanticProvider).not.toBeInstanceOf(FailoverProvider);
    expect(semanticProvider.name).toBe("ollama");
  });

  it("no failover wrapper without LLM_FAILOVER_BACKEND", () => {
    const logger = createTestLogger();
    const env = { JOINGONKA_API_KEY: "gk-test" } as unknown as NodeJS.ProcessEnv;
    const engines = createLlmEngines(logger, { env });
    const provider = (engines.consequenceEngine as unknown as { provider: LLMProvider }).provider;
    expect(provider).not.toBeInstanceOf(FailoverProvider);
    expect(provider.name).toBe("joingonka");
  });

  it("an invalid LLM_FAILOVER_BACKEND value disables failover", () => {
    const logger = createTestLogger();
    const env = {
      JOINGONKA_API_KEY: "gk-test",
      LLM_FAILOVER_BACKEND: "not-a-backend",
    } as unknown as NodeJS.ProcessEnv;
    const engines = createLlmEngines(logger, { env });
    const provider = (engines.consequenceEngine as unknown as { provider: LLMProvider }).provider;
    expect(provider).not.toBeInstanceOf(FailoverProvider);
  });

  it("explicit providers are never wrapped with failover", () => {
    const logger = createTestLogger();
    const stub = new StubProvider('{"ok": true}');
    const env = {
      JOINGONKA_API_KEY: "gk-test",
      LLM_FAILOVER_BACKEND: "ollama",
    } as unknown as NodeJS.ProcessEnv;
    const engines = createLlmEngines(logger, {
      env,
      providers: { consequence: stub, proposal: stub, selection: stub, semantic: stub },
    });
    const provider = (engines.consequenceEngine as unknown as { provider: LLMProvider }).provider;
    expect(provider).toBe(stub);
  });

  it("failover applies to explicit backend overrides too", () => {
    const logger = createTestLogger();
    const env = {
      JOINGONKA_API_KEY: "gk-test",
      LLM_FAILOVER_BACKEND: "ollama",
    } as unknown as NodeJS.ProcessEnv;
    const engines = createLlmEngines(logger, { env, backends: { consequence: "laya-local" } });
    const provider = (engines.consequenceEngine as unknown as { provider: LLMProvider }).provider;
    expect(provider).toBeInstanceOf(FailoverProvider);
    expect(provider.name).toBe("failover(laya-local→ollama)");
  });
});

describe("F14 per-task temperatures", () => {
  const readTemperature = (p: LLMProvider): number =>
    (p as unknown as { options: { temperature: number } }).options.temperature;

  it("built-in defaults: proposal/consequence 0.9, selection/semantic 0.2", () => {
    expect(DEFAULT_TASK_TEMPERATURES).toMatchObject({
      proposal: 0.9,
      consequence: 0.9,
      selection: 0.2,
      semantic: 0.2,
    });
    const cfg = resolveLlmEnv({} as NodeJS.ProcessEnv);
    expect(resolveTaskTemperature("proposal", cfg)).toBe(0.9);
    expect(resolveTaskTemperature("consequence", cfg)).toBe(0.9);
    expect(resolveTaskTemperature("selection", cfg)).toBe(0.2);
    expect(resolveTaskTemperature("semantic", cfg)).toBe(0.2);
    // Temperature is task-resolved, backend-independent — use a keyless backend.
    const localEnv = { LLM_BACKEND: "ollama" } as unknown as NodeJS.ProcessEnv;
    expect(readTemperature(createProviderForTask(localEnv, "proposal"))).toBe(0.9);
    expect(readTemperature(createProviderForTask(localEnv, "selection"))).toBe(0.2);
    expect(readTemperature(createProviderForTask(localEnv, "consequence"))).toBe(0.9);
    expect(readTemperature(createProviderForTask(localEnv, "semantic"))).toBe(0.2);
  });

  it("LLM_TEMPERATURE_* overrides win; unset tasks fall back to LLM_TEMPERATURE", () => {
    const cfg = resolveLlmEnv({
      LLM_TEMPERATURE: "0.5",
      LLM_TEMPERATURE_SELECTION: "0.1",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.temperatureByTask.selection).toBe(0.1);
    expect(cfg.temperatureByTask.proposal).toBe(0.5);
    expect(cfg.temperatureByTask.consequence).toBe(0.5);
    expect(cfg.temperatureByTask.semantic).toBe(0.5);
    expect(resolveTaskTemperature("selection", cfg)).toBe(0.1);
    expect(resolveTaskTemperature("proposal", cfg)).toBe(0.5);
  });

  it("temperature 0 is accepted (deterministic); invalid values are ignored", () => {
    const cfg = resolveLlmEnv({
      LLM_TEMPERATURE_SEMANTIC: "0",
      LLM_TEMPERATURE_SELECTION: "banana",
      LLM_TEMPERATURE_PROPOSAL: "-1",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.temperatureByTask.semantic).toBe(0);
    expect(cfg.temperatureByTask.selection).toBeUndefined();
    expect(cfg.temperatureByTask.proposal).toBeUndefined();
    expect(resolveTaskTemperature("semantic", cfg)).toBe(0);
    // Invalid per-task values fall through to the built-in default.
    expect(resolveTaskTemperature("selection", cfg)).toBe(0.2);
  });

  it("createProviderForTask applies the per-task temperature", () => {
    const provider = createProviderForTask(
      { LLM_BACKEND: "ollama", LLM_TEMPERATURE_SEMANTIC: "0.05" } as unknown as NodeJS.ProcessEnv,
      "semantic",
    );
    expect(readTemperature(provider)).toBe(0.05);
  });
});
