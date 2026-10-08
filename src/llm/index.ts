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
  createProviderForTaskWithFailover,
  createProviderFromEnv,
  FailoverProvider,
  parseBackend,
  resolveLlmEnv,
  resolveTaskBackend,
  type LlmBackend,
  type LlmCallOptions,
  type LLMProvider,
  type LlmTask,
} from "./provider.js";
import { LLMConsequenceEngine } from "./llmConsequenceEngine.js";
import { LLMProposalEngine } from "./llmProposalEngine.js";
import { LLMSelectionEngine } from "./llmSelectionEngine.js";
import { LLMSemanticJudge } from "./llmSemanticJudge.js";
import { readLayaRuntimeConfig } from "../config.js";
import {
  createLayaClient,
  createLayaSelectionEngine,
  createLayaSemanticJudge,
} from "../decision/wiring.js";
import type { ChatComplete } from "../decision/questionPlanner.js";

export type { LLMProvider, LlmBackend, LlmCallOptions, LlmTask };
export {
  HARD_LLM_TASKS,
  SIMPLE_LLM_TASKS,
  DEFAULT_TASK_TEMPERATURES,
  JoinGonkaProvider,
  LocalLayaProvider,
  OllamaProvider,
  FailoverProvider,
  createProviderForTask,
  createProviderForTaskWithFailover,
  createProviderFromEnv,
  isSimpleLlmTask,
  knownBackends,
  ollamaApiRoot,
  resolveLlmEnv,
  resolveTaskBackend,
  resolveTaskTemperature,
} from "./provider.js";
export { LLMConsequenceEngine, FALLBACK_CONSEQUENCE } from "./llmConsequenceEngine.js";
export { LLMProposalEngine, FALLBACK_PROPOSAL } from "./llmProposalEngine.js";
export { LLMSelectionEngine, FALLBACK_SELECTION } from "./llmSelectionEngine.js";
export { LLMSemanticJudge, buildSemanticJudgePrompt } from "./llmSemanticJudge.js";
export { LLM_SYSTEM_PROMPT } from "./prompts.js";
export { buildRosterDisciplineLine, buildRosterRetryLine, rosterExampleActors } from "./rosterDiscipline.js";
export { extractJsonPayload, parseJsonObject, formatRepairPrompt } from "./json.js";

export type LlmEngines = {
  proposalEngine: ProposalEngine;
  selectionEngine: SelectionEngine;
  consequenceEngine: ConsequenceEngine;
  semanticJudge: SemanticJudge;
  /**
   * Item C2 (exp local-8b): per-turn engine routing. NPC turns use the
   * standard tiered routing unchanged; user turns get hard-tier
   * proposal+consequence when the capable tier is enabled and differs
   * from the simple tier (selection is skipped for user turns anyway).
   * Silent fallback to the standard engines when the tiers are identical
   * or LLM_USER_CAPABLE_TIER is off.
   */
  getEnginesForTurn: (isUserTurn: boolean) => TurnEngines;
};

/** Per-turn engine set returned by getEnginesForTurn. */
export type TurnEngines = {
  proposal: ProposalEngine;
  selection: SelectionEngine;
  consequence: ConsequenceEngine;
  judge: SemanticJudge;
  /**
   * Phase 4: chat completion hook for the dynamic question planner
   * (LAYA_MODE=dynamic + LAYA_PLANNER=1). Built from the selection
   * provider when the Laya layer is on; undefined otherwise. The planner
   * prompt asks for enumeration, not choice, so no temperature override
   * is applied here (per-task temperatures already skew low for
   * selection).
   */
  plannerChatComplete?: ChatComplete;
};

/**
 * Item C2: pure capable-tier routing decision (testable without I/O).
 * Returns the hard-tier backend user turns should use, or undefined for
 * silent fallback to the standard engines: LLM_USER_CAPABLE_TIER off
 * (default ON), explicit provider instances (F12: caller-owned, backend
 * opaque), or hard tier identical to the simple tier.
 */
export function userCapableTierBackend(
  env: NodeJS.ProcessEnv,
  backends?: CreateLlmEnginesOptions["backends"],
  providers?: CreateLlmEnginesOptions["providers"],
): LlmBackend | undefined {
  const flag = env["LLM_USER_CAPABLE_TIER"];
  const enabled = flag === undefined || (flag !== "0" && flag.toLowerCase() !== "false");
  if (!enabled) return undefined;
  if (providers?.proposal !== undefined || providers?.consequence !== undefined) {
    return undefined;
  }
  const cfg = resolveLlmEnv(env);
  // The capable tier is the hard-task default backend (proposal is the
  // representative hard task), honoring an explicit per-task proposal
  // override; compared against the simple tier (selection's backend).
  const hardBackend = backends?.proposal ?? resolveTaskBackend("proposal", cfg);
  const simpleBackend = backends?.selection ?? resolveTaskBackend("selection", cfg);
  if (hardBackend === simpleBackend) return undefined;
  return hardBackend;
}

/** Thin imperative shell over userCapableTierBackend: builds the engines. */
function resolveUserCapableTier(
  logger: Logger,
  env: NodeJS.ProcessEnv,
  options: CreateLlmEnginesOptions,
): { proposal: ProposalEngine; consequence: ConsequenceEngine } | undefined {
  const hardBackend = userCapableTierBackend(env, options.backends, options.providers);
  if (hardBackend === undefined) return undefined;
  // F12: mirror the failover wrapping of the standard routing.
  const failoverBackend = parseBackend(env["LLM_FAILOVER_BACKEND"]);
  const hardProvider = (): LLMProvider => {
    const primary = createProviderFromEnv(env, hardBackend);
    if (failoverBackend !== undefined && failoverBackend !== hardBackend) {
      return new FailoverProvider(primary, createProviderFromEnv(env, failoverBackend));
    }
    return primary;
  };
  const engineOptions = { maxRetries: options.maxRetries };
  return {
    proposal: new LLMProposalEngine(logger, hardProvider(), engineOptions),
    consequence: new LLMConsequenceEngine(logger, hardProvider(), engineOptions),
  };
}

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
 *
 * F12: when the LLM_FAILOVER_BACKEND env var names a backend, every
 * non-explicit provider is wrapped in a FailoverProvider that fails over
 * to it on transport errors (via createProviderForTaskWithFailover).
 * Explicit `providers` are used as-is (the caller owns them).
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
    // F12: LLM_FAILOVER_BACKEND wraps the primary with failover to the
    // named backend (transport errors only — content errors stay local).
    const failoverBackend = parseBackend(env["LLM_FAILOVER_BACKEND"]);
    if (backendOverride !== undefined) {
      const primary = createProviderFromEnv(env, backendOverride);
      if (failoverBackend !== undefined && failoverBackend !== backendOverride) {
        return new FailoverProvider(primary, createProviderFromEnv(env, failoverBackend));
      }
      return primary;
    }
    if (failoverBackend !== undefined) {
      return createProviderForTaskWithFailover(env, which, failoverBackend);
    }
    return createProviderForTask(env, which);
  };
  const engineOptions = { maxRetries: options.maxRetries };
  const proposalEngine = new LLMProposalEngine(logger, providerFor("proposal"), engineOptions);
  // Capture the selection provider once: it backs both the chat selection
  // engine and the dynamic planner's ChatComplete hook below.
  const selectionProvider = providerFor("selection");
  const chatSelectionEngine = new LLMSelectionEngine(logger, selectionProvider, engineOptions);
  const consequenceEngine = new LLMConsequenceEngine(logger, providerFor("consequence"), engineOptions);
  const chatSemanticJudge = new LLMSemanticJudge(logger, providerFor("semantic"), engineOptions);

  // Phase 3–4 (LAYA_PLAN.md): Laya decision-layer sourcing. Chat engines
  // remain the default — readLayaRuntimeConfig is OFF unless the owner opts
  // in via env. When LAYA_MODE≠off, the Laya engines wrap the chat engines
  // as injected fallbacks (low confidence / Laya down → chat).
  const layaConfig = readLayaRuntimeConfig(env);
  let selectionEngine: SelectionEngine = chatSelectionEngine;
  let semanticJudge: SemanticJudge = chatSemanticJudge;
  let plannerChatComplete: ChatComplete | undefined;
  if (layaConfig.mode !== "off") {
    const layaClient = createLayaClient(layaConfig);
    if (layaConfig.toggles.selection) {
      selectionEngine = createLayaSelectionEngine(
        { client: layaClient },
        layaConfig,
        chatSelectionEngine,
      );
    }
    if (layaConfig.toggles.judge) {
      semanticJudge = createLayaSemanticJudge({ client: layaClient }, layaConfig);
    }
    plannerChatComplete = (prompt: string) => selectionProvider.complete("", prompt);
  }

  const userTier = resolveUserCapableTier(logger, env, options);
  const getEnginesForTurn = (isUserTurn: boolean): TurnEngines => {
    if (isUserTurn && userTier !== undefined) {
      return {
        proposal: userTier.proposal,
        selection: selectionEngine,
        consequence: userTier.consequence,
        judge: semanticJudge,
        plannerChatComplete,
      };
    }
    return { proposal: proposalEngine, selection: selectionEngine, consequence: consequenceEngine, judge: semanticJudge, plannerChatComplete };
  };
  return { proposalEngine, selectionEngine, consequenceEngine, semanticJudge, getEnginesForTurn };
}
