// Tiered LLM routing: hard tasks (consequence) on the hosted large
// model, simple tasks (intent/semantic) on the local small model.
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
    expect(resolveTaskBackend("consequence", cfg)).toBe("joingonka");
    expect(resolveTaskBackend("intent", cfg)).toBe("ollama");
    expect(resolveTaskBackend("semantic", cfg)).toBe("ollama");
    expect(isSimpleLlmTask("intent")).toBe(true);
    expect(isSimpleLlmTask("semantic")).toBe(true);
    expect(isSimpleLlmTask("consequence")).toBe(false);
  });

  it("per-task LLM_BACKEND_* overrides win over tier defaults", () => {
    const cfg = resolveLlmEnv({
      LLM_BACKEND: "joingonka",
      LLM_SIMPLE_BACKEND: "ollama",
      LLM_BACKEND_INTENT: "laya-local",
      LLM_BACKEND_SEMANTIC: "joingonka",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.taskBackends.intent).toBe("laya-local");
    expect(cfg.taskBackends.semantic).toBe("joingonka");
    expect(resolveTaskBackend("intent", cfg)).toBe("laya-local");
    expect(resolveTaskBackend("semantic", cfg)).toBe("joingonka");
    // Untouched tasks keep tier defaults.
    expect(resolveTaskBackend("consequence", cfg)).toBe("joingonka");
  });

  it("LLM_SIMPLE_MODEL overrides the model for simple tasks only", () => {
    const cfg = resolveLlmEnv({
      LLM_SIMPLE_MODEL: "huihui_ai/llama3.2-abliterate:3b",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.simpleModel).toBe("huihui_ai/llama3.2-abliterate:3b");
  });

  it("createProviderForTask builds a local provider for simple tasks by default", () => {
    const simple = createProviderForTask({} as NodeJS.ProcessEnv, "intent");
    expect(simple.name).toBe("ollama");
    const semantic = createProviderForTask({} as NodeJS.ProcessEnv, "semantic");
    expect(semantic.name).toBe("ollama");
  });

  it("createProviderForTask applies LLM_SIMPLE_MODEL to simple tasks", () => {
    const env = {
      LLM_SIMPLE_MODEL: "huihui_ai/llama3.2-abliterate:3b",
    } as unknown as NodeJS.ProcessEnv;
    const provider = createProviderForTask(env, "intent") as OllamaProvider;
    expect(provider.name).toBe("ollama");
    expect(provider.model).toBe("huihui_ai/llama3.2-abliterate:3b");
  });

  it("createLlmEngines wires the engines and honors explicit per-task providers", async () => {
    const logger = createTestLogger();
    const intentStub = new StubProvider(JSON.stringify({ action: "Wave.", quote: "" }));
    const consequenceStub = new StubProvider(
      JSON.stringify({ narrative: "U waves.", actorPatches: [], objectPatches: [], reasoning: "test" }),
    );
    const semanticStub = new StubProvider(
      JSON.stringify({ moves: false, speaks: false, quotedSpeech: [] }),
    );
    const engines = createLlmEngines(logger, {
      providers: {
        intent: intentStub,
        consequence: consequenceStub,
        semantic: semanticStub,
      },
    });
    expect(engines.semanticJudge).toBeDefined();
    expect(engines.intentEngine).toBeDefined();
    const { makeTinyWorld } = await import("../helpers.js");
    const world = makeTinyWorld();
    await expect(engines.intentEngine.intent(world, "u")).resolves.toMatchObject({
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
      providers: { consequence: stub, intent: stub, semantic: stub },
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

  it("built-in defaults: consequence 0.9, intent/semantic 0.2", () => {
    expect(DEFAULT_TASK_TEMPERATURES).toMatchObject({
      consequence: 0.9,
      intent: 0.2,
      semantic: 0.2,
    });
    const cfg = resolveLlmEnv({} as NodeJS.ProcessEnv);
    expect(resolveTaskTemperature("consequence", cfg)).toBe(0.9);
    expect(resolveTaskTemperature("intent", cfg)).toBe(0.2);
    expect(resolveTaskTemperature("semantic", cfg)).toBe(0.2);
    // Temperature is task-resolved, backend-independent — use a keyless backend.
    const localEnv = { LLM_BACKEND: "ollama" } as unknown as NodeJS.ProcessEnv;
    expect(readTemperature(createProviderForTask(localEnv, "consequence"))).toBe(0.9);
    expect(readTemperature(createProviderForTask(localEnv, "intent"))).toBe(0.2);
    expect(readTemperature(createProviderForTask(localEnv, "semantic"))).toBe(0.2);
  });

  it("LLM_TEMPERATURE_* overrides win; unset tasks fall back to LLM_TEMPERATURE", () => {
    const cfg = resolveLlmEnv({
      LLM_TEMPERATURE: "0.5",
      LLM_TEMPERATURE_INTENT: "0.1",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.temperatureByTask.intent).toBe(0.1);
    expect(cfg.temperatureByTask.consequence).toBe(0.5);
    expect(cfg.temperatureByTask.semantic).toBe(0.5);
    expect(resolveTaskTemperature("intent", cfg)).toBe(0.1);
    expect(resolveTaskTemperature("consequence", cfg)).toBe(0.5);
  });

  it("temperature 0 is accepted (deterministic); invalid values are ignored", () => {
    const cfg = resolveLlmEnv({
      LLM_TEMPERATURE_SEMANTIC: "0",
      LLM_TEMPERATURE_INTENT: "banana",
      LLM_TEMPERATURE_CONSEQUENCE: "-1",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.temperatureByTask.semantic).toBe(0);
    expect(cfg.temperatureByTask.intent).toBeUndefined();
    expect(cfg.temperatureByTask.consequence).toBeUndefined();
    expect(resolveTaskTemperature("semantic", cfg)).toBe(0);
    // Invalid per-task values fall through to the built-in default.
    expect(resolveTaskTemperature("intent", cfg)).toBe(0.2);
  });

  it("createProviderForTask applies the per-task temperature", () => {
    const provider = createProviderForTask(
      { LLM_BACKEND: "ollama", LLM_TEMPERATURE_SEMANTIC: "0.05" } as unknown as NodeJS.ProcessEnv,
      "semantic",
    );
    expect(readTemperature(provider)).toBe(0.05);
  });
});
