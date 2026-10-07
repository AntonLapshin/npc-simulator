// Tiered LLM routing: hard tasks (proposal/consequence) on the hosted
// large model, simple tasks (selection/semantic) on the local small model.
import { describe, expect, it } from "vitest";
import { createTestLogger } from "../../src/logging/logger.js";
import {
  createLlmEngines,
  createProviderForTask,
  isSimpleLlmTask,
  resolveLlmEnv,
  resolveTaskBackend,
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
