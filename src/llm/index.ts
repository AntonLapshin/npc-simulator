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
} from "../intelligence/types.js";
import {
  createProviderFromEnv,
  type LlmBackend,
  type LLMProvider,
} from "./provider.js";
import { LLMConsequenceEngine } from "./llmConsequenceEngine.js";
import { LLMProposalEngine } from "./llmProposalEngine.js";
import { LLMSelectionEngine } from "./llmSelectionEngine.js";

export type { LLMProvider, LlmBackend };
export { JoinGonkaProvider, LocalLayaProvider, createProviderFromEnv, resolveLlmEnv } from "./provider.js";
export { LLMConsequenceEngine, FALLBACK_CONSEQUENCE } from "./llmConsequenceEngine.js";
export { LLMProposalEngine, FALLBACK_PROPOSAL } from "./llmProposalEngine.js";
export { LLMSelectionEngine, FALLBACK_SELECTION } from "./llmSelectionEngine.js";
export { LLM_SYSTEM_PROMPT } from "./prompts.js";
export { extractJsonPayload, parseJsonObject, formatRepairPrompt } from "./json.js";

export type LlmEngines = {
  proposalEngine: ProposalEngine;
  selectionEngine: SelectionEngine;
  consequenceEngine: ConsequenceEngine;
};

export type CreateLlmEnginesOptions = {
  /** Per-engine providers. Defaults to one shared provider. */
  providers?: {
    proposal?: LLMProvider;
    selection?: LLMProvider;
    consequence?: LLMProvider;
  };
  /** Per-engine backends (used when `providers` is omitted). */
  backends?: {
    proposal?: LlmBackend;
    selection?: LlmBackend;
    consequence?: LlmBackend;
  };
  /** Parse-retry budget for all three engines (§16.3). Defaults to 3. */
  maxRetries?: number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Wire the three real LLM engines.
 *
 * Default: every engine uses JoinGonka (zai-org/GLM-5.3-Flash).
 * Recommended split — creative work hosted, decisions local:
 *   createLlmEngines(logger, { backends: { selection: "laya-local" } })
 * which routes Selection through the locally served Laya model while
 * Proposal/Consequence stay on JoinGonka.
 */
export function createLlmEngines(
  logger: Logger,
  options: CreateLlmEnginesOptions = {},
): LlmEngines {
  const env = options.env ?? process.env;
  const providerFor = (which: "proposal" | "selection" | "consequence"): LLMProvider => {
    const explicit = options.providers?.[which];
    if (explicit) return explicit;
    return createProviderFromEnv(env, options.backends?.[which]);
  };
  const engineOptions = { maxRetries: options.maxRetries };
  return {
    proposalEngine: new LLMProposalEngine(logger, providerFor("proposal"), engineOptions),
    selectionEngine: new LLMSelectionEngine(logger, providerFor("selection"), engineOptions),
    consequenceEngine: new LLMConsequenceEngine(logger, providerFor("consequence"), engineOptions),
  };
}
