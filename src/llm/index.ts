// Public surface of the isolated LLM layer (Milestone 2).
//
// Everything the rest of the app needs lives here: providers
// (hosted JoinGonka, local Laya), the three LLM engines, prompts, and
// JSON utilities. Nothing outside src/llm/ is modified by this module —
// engines consume World/Action types and the Context Builder only as
// inputs, and report back through the intelligence interfaces + Logger.

import type { Logger } from "../logging/logger.js";
import type {
  ConsequenceEngine,
  ProposalEngine,
  SelectionEngine,
  SemanticJudge,
} from "../intelligence/types.js";
import {
  createProviderForTask,
  createProviderFromEnv,
  type LlmBackend,
  type LLMProvider,
  type LlmTask,
} from "./provider.js";
import { LLMConsequenceEngine } from "./llmConsequenceEngine.js";
import { LLMProposalEngine } from "./llmProposalEngine.js";
import { LLMSelectionEngine } from "./llmSelectionEngine.js";
import { LLMSemanticJudge } from "./llmSemanticJudge.js";

export type { LLMProvider, LlmBackend, LlmTask };
export {
  HARD_LLM_TASKS,
  SIMPLE_LLM_TASKS,
  JoinGonkaProvider,
  LocalLayaProvider,
  OllamaProvider,
  createProviderForTask,
  createProviderFromEnv,
  isSimpleLlmTask,
  knownBackends,
  ollamaApiRoot,
  resolveLlmEnv,
  resolveTaskBackend,
} from "./provider.js";
export { LLMConsequenceEngine, FALLBACK_CONSEQUENCE } from "./llmConsequenceEngine.js";
export { LLMProposalEngine, FALLBACK_PROPOSAL } from "./llmProposalEngine.js";
export { LLMSelectionEngine, FALLBACK_SELECTION } from "./llmSelectionEngine.js";
export { LLMSemanticJudge, buildSemanticJudgePrompt } from "./llmSemanticJudge.js";
export { LLM_SYSTEM_PROMPT } from "./prompts.js";
export { extractJsonPayload, parseJsonObject, formatRepairPrompt } from "./json.js";

export type LlmEngines = {
  proposalEngine: ProposalEngine;
  selectionEngine: SelectionEngine;
  consequenceEngine: ConsequenceEngine;
  semanticJudge: SemanticJudge;
};

export type CreateLlmEnginesOptions = {
  /** Per-task providers. Defaults to tier routing (hard → hosted, simple → local). */
  providers?: {
    proposal?: LLMProvider;
    selection?: LLMProvider;
    consequence?: LLMProvider;
    semantic?: LLMProvider;
  };
  /** Per-task backends (used when `providers` is omitted; wins over tier defaults). */
  backends?: {
    proposal?: LlmBackend;
    selection?: LlmBackend;
    consequence?: LlmBackend;
    semantic?: LlmBackend;
  };
  /** Parse-retry budget for all engines (§16.3). Defaults to 3. */
  maxRetries?: number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Wire the real LLM engines with tiered routing.
 *
 * Default split — large hosted models only for hard tasks:
 *   proposal/consequence → LLM_BACKEND (default joingonka)
 *   selection/semantic  → LLM_SIMPLE_BACKEND (default ollama, local)
 * Per-task overrides: LLM_BACKEND_{PROPOSAL,SELECTION,CONSEQUENCE,SEMANTIC},
 * LLM_SIMPLE_MODEL (model override for simple tasks), or the `backends` /
 * `providers` options (explicit option wins over env).
 */
export function createLlmEngines(
  logger: Logger,
  options: CreateLlmEnginesOptions = {},
): LlmEngines {
  const env = options.env ?? process.env;
  const providerFor = (which: LlmTask): LLMProvider => {
    const explicit =
      which === "semantic"
        ? options.providers?.semantic
        : options.providers?.[which as "proposal" | "selection" | "consequence"];
    if (explicit) return explicit;
    const backendOverride =
      which === "semantic"
        ? options.backends?.semantic
        : options.backends?.[which as "proposal" | "selection" | "consequence"];
    if (backendOverride !== undefined) return createProviderFromEnv(env, backendOverride);
    return createProviderForTask(env, which);
  };
  const engineOptions = { maxRetries: options.maxRetries };
  return {
    proposalEngine: new LLMProposalEngine(logger, providerFor("proposal"), engineOptions),
    selectionEngine: new LLMSelectionEngine(logger, providerFor("selection"), engineOptions),
    consequenceEngine: new LLMConsequenceEngine(logger, providerFor("consequence"), engineOptions),
    semanticJudge: new LLMSemanticJudge(logger, providerFor("semantic"), engineOptions),
  };
}
