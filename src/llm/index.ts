// Public surface of the isolated LLM layer.
//
// PLAN_V2 Phase 6: proposal+selection are deleted — the v2 turn loop is
// intent (1 LLM call) → Laya parse → engine execute/clamp → narrate
// (1 LLM call). This module wires the two remaining LLM engines (intent +
// consequence) plus the hosted semantic judge. Nothing outside src/llm/
// is modified by this module — engines consume World/Action types and the
// Context Builder only as inputs, and report back through the
// intelligence interfaces + Logger.

import type { Logger } from "../logging/logger.js";
import type {
  ConsequenceEngine,
  IntentEngine,
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
  resolveTaskModel,
  type LlmBackend,
  type LlmCallOptions,
  type LLMProvider,
  type LlmTask,
} from "./provider.js";
import { LLMConsequenceEngine } from "./llmConsequenceEngine.js";
import { LLMSemanticJudge } from "./llmSemanticJudge.js";
import { LLMIntentEngine } from "./llmIntentEngine.js";

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
  defaultTimeoutMsFor,
  isSimpleLlmTask,
  isThinkingModel,
  knownBackends,
  latencyCachePath,
  ollamaApiRoot,
  readModelLatencyMs,
  recordModelLatencyMs,
  resolveLlmEnv,
  resolveTaskBackend,
  resolveTaskModel,
  resolveTaskTemperature,
} from "./provider.js";
export { LLMConsequenceEngine, FALLBACK_CONSEQUENCE } from "./llmConsequenceEngine.js";
export { LLMIntentEngine, buildIntentPrompt } from "./llmIntentEngine.js";
export type { IntentEngine } from "../intelligence/types.js";
export { LLMSemanticJudge, buildSemanticJudgePrompt } from "./llmSemanticJudge.js";
export { LLM_SYSTEM_PROMPT } from "./prompts.js";
export { buildRosterDisciplineLine, buildRosterRetryLine, rosterExampleActors } from "./rosterDiscipline.js";
export { extractJsonPayload, parseJsonObject, formatRepairPrompt } from "./json.js";

export type LlmEngines = {
  consequenceEngine: ConsequenceEngine;
  semanticJudge: SemanticJudge;
  /**
   * PLAN_V2 Phase 1: the intent call (single structured call deciding the
   * actor's next action). Simple-tier routing — the intent call is scene
   * understanding, not hard reasoning.
   */
  intentEngine: IntentEngine;
  /**
   * Item C2 (exp local-8b): per-turn engine routing. NPC turns use the
   * standard tiered routing unchanged; user turns get the hard-tier
   * consequence engine when the capable tier is enabled and differs from
   * the simple tier (the intent call never runs for user turns anyway).
   * Silent fallback to the standard engines when the tiers are identical
   * or LLM_USER_CAPABLE_TIER is off.
   */
  getEnginesForTurn: (isUserTurn: boolean) => TurnEngines;
};

/**
 * Per-turn engine set returned by getEnginesForTurn. The turn loop's only
 * LLM engine is the narrator (consequence); the intent call runs on the
 * standard simple tier for NPC turns and is skipped for user turns.
 */
export type TurnEngines = {
  consequence: ConsequenceEngine;
};

/**
 * Item C2: pure capable-tier routing decision (testable without I/O).
 * Returns the hard-tier backend user turns should use, or undefined for
 * silent fallback to the standard engines: LLM_USER_CAPABLE_TIER off
 * (default ON), explicit provider instances (F12: caller-owned, backend
 * opaque), or hard tier identical to the simple tier.
 *
 * Exp-4 item 2 (S1): the identical-tier check compares provider AND model
 * (LLM_USER_CAPABLE_TIER=1 with both tiers on the same local 8B is a
 * no-op — the env flag alone changes nothing). Callers that want the
 * reason should use capableTierNoopReason().
 */
export function userCapableTierBackend(
  env: NodeJS.ProcessEnv,
  backends?: CreateLlmEnginesOptions["backends"],
  providers?: CreateLlmEnginesOptions["providers"],
): LlmBackend | undefined {
  const flag = env["LLM_USER_CAPABLE_TIER"];
  const enabled = flag === undefined || (flag !== "0" && flag.toLowerCase() !== "false");
  if (!enabled) return undefined;
  if (providers?.consequence !== undefined) {
    return undefined;
  }
  if (capableTierNoopReason(env, backends) !== undefined) return undefined;
  const cfg = resolveLlmEnv(env);
  // The capable tier is the hard-task default backend (consequence is the
  // representative hard task), honoring an explicit per-task consequence
  // override; compared against the simple tier (intent's backend).
  return backends?.consequence ?? resolveTaskBackend("consequence", cfg);
}

/**
 * Exp-4 item 2 (S1): why the capable tier is a no-op, or undefined when it
 * applies. Pure — the imperative shell logs the reason as a warning.
 */
export function capableTierNoopReason(
  env: NodeJS.ProcessEnv,
  backends?: CreateLlmEnginesOptions["backends"],
): string | undefined {
  const cfg = resolveLlmEnv(env);
  const hardBackend = backends?.consequence ?? resolveTaskBackend("consequence", cfg);
  const simpleBackend = backends?.intent ?? resolveTaskBackend("intent", cfg);
  const hardModel = resolveTaskModel("consequence", cfg);
  const simpleModel = resolveTaskModel("intent", cfg);
  if (hardBackend === simpleBackend && hardModel === simpleModel) {
    return (
      `LLM_USER_CAPABLE_TIER is enabled but the hard tier resolves to the same provider+model as the simple tier ` +
      `(${hardBackend}:${hardModel}) — user turns silently use the standard engines`
    );
  }
  return undefined;
}

/** Thin imperative shell over userCapableTierBackend: builds the engines. */
function resolveUserCapableTier(
  logger: Logger,
  env: NodeJS.ProcessEnv,
  options: CreateLlmEnginesOptions,
): { consequence: ConsequenceEngine } | undefined {
  const hardBackend = userCapableTierBackend(env, options.backends, options.providers);
  if (hardBackend === undefined) {
    // Exp-4 item 2 (S1): the flag alone is a no-op when both tiers resolve
    // to the same provider+model (exp-4: LLM_USER_CAPABLE_TIER=1, both
    // tiers on the same local 8B) — say so loudly instead of silently
    // falling back.
    const reason = capableTierNoopReason(env, options.backends);
    if (reason !== undefined) {
      logger.log({
        module: "llm",
        event: "user_capable_tier_noop",
        // Startup-time warning: no turn context yet.
        tick: -1,
        turnIndex: -1,
        input: { LLM_USER_CAPABLE_TIER: env["LLM_USER_CAPABLE_TIER"] },
        error: reason,
      });
    }
    return undefined;
  }
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
    consequence: new LLMConsequenceEngine(logger, hardProvider(), engineOptions),
  };
}

export type CreateLlmEnginesOptions = {
  /** Per-task providers. Defaults to tier routing (hard → hosted, simple → local). */
  providers?: {
    intent?: LLMProvider;
    consequence?: LLMProvider;
    semantic?: LLMProvider;
  };
  /** Per-task backends (used when `providers` is omitted; wins over tier defaults). */
  backends?: {
    intent?: LlmBackend;
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
 *   consequence → LLM_BACKEND (default joingonka)
 *   intent/semantic → LLM_SIMPLE_BACKEND (default ollama, local)
 * Per-task overrides: LLM_BACKEND_{INTENT,CONSEQUENCE,SEMANTIC},
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
    const explicit = options.providers?.[which as "intent" | "consequence" | "semantic"];
    if (explicit) return explicit;
    const backendOverride = options.backends?.[which as "intent" | "consequence" | "semantic"];
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
  const consequenceEngine = new LLMConsequenceEngine(logger, providerFor("consequence"), engineOptions);
  const semanticJudge = new LLMSemanticJudge(logger, providerFor("semantic"), engineOptions);
  // PLAN_V2 Phase 1: the intent call rides the simple tier (scene
  // understanding on the local model, not hard reasoning on the hosted
  // tier).
  const intentEngine = new LLMIntentEngine(logger, providerFor("intent"), engineOptions);

  const userTier = resolveUserCapableTier(logger, env, options);
  const getEnginesForTurn = (isUserTurn: boolean): TurnEngines => {
    if (isUserTurn && userTier !== undefined) {
      return { consequence: userTier.consequence };
    }
    return { consequence: consequenceEngine };
  };
  return { consequenceEngine, semanticJudge, intentEngine, getEnginesForTurn };
}
