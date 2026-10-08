// Pluggable LLM provider adapter (Milestone 2, §16.1).
//
// All engines in this folder talk to LLMs ONLY through the LLMProvider
// interface, so swapping backends never touches engine code:
//
//   - JoinGonkaProvider — hosted OpenAI-compatible gateway.
//     Default model: zai-org/GLM-5.3-Flash (see https://gate.joingonka.ai/dashboard).
//     Get an API key from the dashboard, then:
//       JOINGONKA_API_KEY=gk-... JOINGONKA_MODEL=zai-org/GLM-5.3-Flash
//
//   - LocalLayaProvider — a locally served Decision-AI model
//     (https://huggingface.co/convaiinnovations/laya) behind any
//     OpenAI-compatible server (llama.cpp `--server`, Ollama, vLLM, ...).
//     Install the weights with `npm run setup:laya`, serve them with
//     `npm run serve:laya`, then point LAYA_BASE_URL at your
//     OpenAI-compatible endpoint, e.g.:
//       LAYA_BASE_URL=http://127.0.0.1:8080/v1 LAYA_MODEL=laya
//     Note: `laya-serve` itself exposes the Jev-compatible typed-decisions
//     API (POST /v1/systemone), not OpenAI Chat Completions, so it is not
//     a valid LAYA_BASE_URL target — see .env.example for details.
//
//   - OllamaProvider — any model served by local Ollama
//     (https://ollama.com) via its OpenAI-compatible endpoint
//     (http://127.0.0.1:11434/v1 by default). Install with
//     `npm run setup:ollama` (pulls the two recommended models, see
//     scripts/setup-ollama.sh), then:
//       LLM_BACKEND=ollama OLLAMA_MODEL=fluffy/l3-8b-stheno-v3.2
//
// Both speak the OpenAI Chat Completions dialect; only defaults differ.
//
// Tiered routing (default): hard tasks (proposal/consequence — creative,
// long-context, memory/belief/relationship compounding) run on LLM_BACKEND
// (default joingonka, e.g. zai-org/GLM-5.3-Flash or DeepSeek). Simple tasks
// (selection/semantic — single-pick decisions, moves/speaks classification)
// run on LLM_SIMPLE_BACKEND (default ollama, local small model).
// Per-task overrides: LLM_BACKEND_{PROPOSAL,SELECTION,CONSEQUENCE,SEMANTIC}.
// Simple-tier model override: LLM_SIMPLE_MODEL.

import { errorMessage } from "../util/errors.js";
import type { LlmUsage } from "../logging/logTypes.js";

/** F28: per-call options for LLMProvider.complete. Additive/optional. */
export type LlmCallOptions = {
  /**
   * Abort the in-flight request (e.g. the engine's turn deadline fired).
   * The provider links it to its own timeout controller; a caller abort
   * surfaces as an "aborted by caller" error, distinct from a timeout.
   */
  signal?: AbortSignal;
};

export interface LLMProvider {
  /** Complete a system+user prompt pair. Resolves with raw text (JSON expected). */
  complete(systemPrompt: string, userPrompt: string, opts?: LlmCallOptions): Promise<string>;
  /** Human-readable backend id for logs (never includes secrets). */
  readonly name: string;
  /**
   * F31: per-call usage from the most recent request (the OpenAI `usage`
   * block), when the backend reports it. Drained on read — call once per
   * request. Optional: providers that cannot report usage omit it.
   */
  takeLastUsage?(): LlmUsage | undefined;
}

export type OpenAICompatibleOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  /** Repeat penalty (1.0 = disabled). Helps prevent repetitive RP prose. */
  repeatPenalty?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Exp-6 item 7: request structured output from the gateway
   * (`response_format: {type: "json_object"}`) — the single highest-ROI
   * fix for the "Let me analyze this…" format-collapse failures, when the
   * backend honors it. ON by default; env LLM_JSON_MODE=0 (or "false")
   * disables it.
   */
  jsonMode?: boolean;
  /** Extra fetch init (custom headers, dispatcher, ...). */
  fetchImpl?: typeof fetch;
};

export const DEFAULT_TIMEOUT_MS = 60_000;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function toNonNegativeInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * F31: normalize the OpenAI chat-completions `usage` block into LlmUsage.
 * Tolerates missing fields (derives total = prompt + completion when the
 * backend omits it); returns undefined when nothing usable is present.
 */
function parseLlmUsage(raw: unknown): LlmUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const promptTokens = toNonNegativeInt(r["prompt_tokens"]);
  const completionTokens = toNonNegativeInt(r["completion_tokens"]);
  const totalTokens = toNonNegativeInt(r["total_tokens"]);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
  };
}

/**
 * Shared OpenAI-compatible Chat Completions client with timeout,
 * rate-limit / refusal surfacing, and empty-response detection.
 * All provider errors are thrown as Errors (engines log + retry them).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  protected readonly options: Required<Omit<OpenAICompatibleOptions, "apiKey" | "fetchImpl">> &
    Pick<OpenAICompatibleOptions, "apiKey" | "fetchImpl">;
  /** F31: usage reported by the most recent request (drained by takeLastUsage). */
  private lastUsage: LlmUsage | undefined;

  constructor(name: string, options: OpenAICompatibleOptions) {
    this.name = name;
    this.options = {
      baseUrl: options.baseUrl,
      model: options.model,
      temperature: options.temperature ?? 0.9,
      repeatPenalty: options.repeatPenalty ?? 1.1,
      maxTokens: options.maxTokens ?? 1500,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // F13: JSON mode is ON by default (LLM_JSON_MODE=0 disables it).
      jsonMode: options.jsonMode ?? true,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
    };
  }

  get model(): string {
    return this.options.model;
  }

  /** Base URL of the OpenAI-compatible endpoint (for health probing). */
  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /**
   * F31: usage from the most recent completed request (the OpenAI `usage`
   * block), when the backend reports it. Drained on read.
   */
  takeLastUsage(): LlmUsage | undefined {
    const usage = this.lastUsage;
    this.lastUsage = undefined;
    return usage;
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    opts?: LlmCallOptions,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    // F28: link the caller's signal (e.g. the engine's turn deadline) to
    // the in-flight request so a late result stops burning tokens.
    const externalSignal = opts?.signal;
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    // A new request invalidates any previous usage reading.
    this.lastUsage = undefined;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.options.apiKey) headers["Authorization"] = `Bearer ${this.options.apiKey}`;
      const res = await fetchImpl(joinUrl(this.options.baseUrl, "/chat/completions"), {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: this.options.temperature,
          repeat_penalty: this.options.repeatPenalty,
          max_tokens: this.options.maxTokens,
          // Exp-6 item 7: ask the gateway for a JSON object directly.
          ...(this.options.jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
      });
      if (res.status === 429) {
        // F11: surface Retry-After so the retry loop can honor it.
        const retryAfter = res.headers?.get?.("retry-after")?.trim();
        const secs = retryAfter ? Number(retryAfter) : NaN;
        const hint =
          Number.isFinite(secs) && secs >= 0 ? `, retry after ${secs}s` : "";
        throw new Error(`${this.name}: rate limited (HTTP 429${hint})`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `${this.name}: request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        );
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
      };
      // F31: capture per-call usage for cost tracking.
      const usage = parseLlmUsage(data.usage);
      if (usage) this.lastUsage = usage;
      const content = data.choices?.[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        const reason = data.choices?.[0]?.finish_reason ?? "unknown";
        throw new Error(`${this.name}: empty response (finish_reason=${reason})`);
      }
      return content;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // F28: a caller abort (turn deadline) is not a provider timeout.
        if (externalSignal?.aborted) throw new Error(`${this.name}: aborted by caller`);
        throw new Error(`${this.name}: timed out after ${this.options.timeoutMs}ms`);
      }
      throw err instanceof Error ? err : new Error(`${this.name}: ${errorMessage(err)}`);
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/** Hosted JoinGonka gateway (OpenAI-compatible). */
export class JoinGonkaProvider extends OpenAICompatibleProvider {
  static readonly DEFAULT_BASE_URL = "https://gate.joingonka.ai/v1";
  static readonly DEFAULT_MODEL = "zai-org/GLM-5.3-Flash";

  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    repeatPenalty?: number;
    maxTokens?: number;
    timeoutMs?: number;
    jsonMode?: boolean;
    fetchImpl?: typeof fetch;
  }) {
    if (!options.apiKey) throw new Error("JoinGonkaProvider requires an API key");
    super("joingonka", {
      baseUrl: options.baseUrl ?? JoinGonkaProvider.DEFAULT_BASE_URL,
      model: options.model ?? JoinGonkaProvider.DEFAULT_MODEL,
      apiKey: options.apiKey,
      temperature: options.temperature,
      repeatPenalty: options.repeatPenalty,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      jsonMode: options.jsonMode,
      fetchImpl: options.fetchImpl,
    });
  }
}

/** Locally served Laya decision-AI model (OpenAI-compatible server). */
export class LocalLayaProvider extends OpenAICompatibleProvider {
  static readonly DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
  /** Local server model id (the HF repo is convaiinnovations/laya). */
  static readonly DEFAULT_MODEL = "laya";

  constructor(options: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    temperature?: number;
    repeatPenalty?: number;
    maxTokens?: number;
    timeoutMs?: number;
    jsonMode?: boolean;
    fetchImpl?: typeof fetch;
  } = {}) {
    super("laya-local", {
      baseUrl: options.baseUrl ?? LocalLayaProvider.DEFAULT_BASE_URL,
      model: options.model ?? LocalLayaProvider.DEFAULT_MODEL,
      apiKey: options.apiKey,
      temperature: options.temperature,
      repeatPenalty: options.repeatPenalty,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      jsonMode: options.jsonMode,
      fetchImpl: options.fetchImpl,
    });
  }
}

/** Locally served model via Ollama (OpenAI-compatible endpoint). */
export class OllamaProvider extends OpenAICompatibleProvider {
  static readonly DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
  /** Native Ollama API root derived from the OpenAI-compatible base URL. */
  static readonly DEFAULT_API_URL = "http://127.0.0.1:11434";
  /** Recommended models (see scripts/setup-ollama.sh). */
  static readonly RECOMMENDED_MODELS = [
    "qwen3:14b",
    "fluffy/l3-8b-stheno-v3.2",
    "huihui_ai/llama3.2-abliterate:3b",
  ] as const;
  /** Default model: Qwen3 14B (Exp-6 default). */
  static readonly DEFAULT_MODEL = "qwen3:14b";

  constructor(options: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    temperature?: number;
    repeatPenalty?: number;
    maxTokens?: number;
    timeoutMs?: number;
    jsonMode?: boolean;
    fetchImpl?: typeof fetch;
  } = {}) {
    super("ollama", {
      baseUrl: options.baseUrl ?? OllamaProvider.DEFAULT_BASE_URL,
      model: options.model ?? OllamaProvider.DEFAULT_MODEL,
      apiKey: options.apiKey,
      temperature: options.temperature,
      repeatPenalty: options.repeatPenalty,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      jsonMode: options.jsonMode,
      fetchImpl: options.fetchImpl,
    });
  }
}

/** Derive the native Ollama API root (…:11434) from any base URL form. */
export function ollamaApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  // OpenAI-compatible form ends with /v1 → strip it; native form stays.
  return trimmed.replace(/\/v1$/, "") || OllamaProvider.DEFAULT_API_URL;
}

export type LlmBackend = "joingonka" | "laya-local" | "ollama";

/**
 * LLM task kinds routed to providers.
 * - hard (large/hosted): proposal, consequence — creative, long-context,
 *   physics + roster discipline, memory/belief/relationship compounding.
 * - simple (small/local): selection, semantic — short classification /
 *   single-pick decisions over an already-built candidate set.
 */
export type LlmTask = "proposal" | "selection" | "consequence" | "semantic";

/** Tasks that default to the large hosted model (worth the cost). */
export const HARD_LLM_TASKS: readonly LlmTask[] = ["proposal", "consequence"] as const;
/** Tasks that default to the small local model (cheap, fast, good enough). */
export const SIMPLE_LLM_TASKS: readonly LlmTask[] = ["selection", "semantic"] as const;

export function isSimpleLlmTask(task: LlmTask): boolean {
  return (SIMPLE_LLM_TASKS as readonly string[]).includes(task);
}

export type LlmEnvConfig = {
  /** Default backend for HARD tasks (proposal/consequence). */
  backend: LlmBackend;
  /** Default backend for SIMPLE tasks (selection/semantic). Defaults to local. */
  simpleBackend: LlmBackend;
  /** Per-task backend overrides (LLM_BACKEND_{PROPOSAL,SELECTION,CONSEQUENCE,SEMANTIC}). */
  taskBackends: Partial<Record<LlmTask, LlmBackend>>;
  /** Optional model override applied to SIMPLE tasks only (LLM_SIMPLE_MODEL). */
  simpleModel?: string;
  joingonka: { apiKey?: string; baseUrl: string; model: string };
  laya: { baseUrl: string; model: string; apiKey?: string };
  ollama: { baseUrl: string; model: string; apiKey?: string };
  timeoutMs: number;
  temperature: number;
  repeatPenalty: number;
  maxTokens: number;
  /**
   * Exp-6 item 7: request gateway JSON-mode responses. ON by default;
   * LLM_JSON_MODE=0 (or "false") disables it.
   */
  jsonMode: boolean;
  /**
   * F14: per-task temperatures (LLM_TEMPERATURE_{PROPOSAL,SELECTION,
   * CONSEQUENCE,SEMANTIC}), each falling back to LLM_TEMPERATURE.
   * Entries are present only when the corresponding env var (or the
   * global LLM_TEMPERATURE) is set; unset tasks use
   * DEFAULT_TASK_TEMPERATURES. Mirrors the LLM_MAX_TOKENS_* pattern,
   * except temperature 0 is valid (deterministic) while maxTokens 0 is not.
   */
  temperatureByTask: Partial<Record<LlmTask, number>>;
  /**
   * Exp-6 item 6: token budgets proportional to payload
   * (LLM_MAX_TOKENS_{PROPOSAL,SELECTION,CONSEQUENCE,SEMANTIC}) — the
   * consequence prompt is the long pole, the semantic judge the short one.
   */
  maxTokensByTask: Partial<Record<LlmTask, number>>;
};

const KNOWN_BACKENDS: LlmBackend[] = ["joingonka", "laya-local", "ollama"];

/** F12: parse a backend name for LLM_FAILOVER_BACKEND (exported for createLlmEngines). */
export function parseBackend(raw: string | undefined): LlmBackend | undefined {
  return raw === "laya-local" || raw === "ollama" || raw === "joingonka" ? raw : undefined;
}

/** Read backend configuration from environment (no secrets are ever logged). */
export function resolveLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  const backend = parseBackend(env["LLM_BACKEND"]) ?? "joingonka";
  // Simple tasks default to local — goal is to run large hosted models
  // only for hard tasks that are worth it.
  const simpleBackend = parseBackend(env["LLM_SIMPLE_BACKEND"]) ?? "ollama";
  const taskBackends: Partial<Record<LlmTask, LlmBackend>> = {};
  const proposal = parseBackend(env["LLM_BACKEND_PROPOSAL"]);
  const selection = parseBackend(env["LLM_BACKEND_SELECTION"]);
  const consequence = parseBackend(env["LLM_BACKEND_CONSEQUENCE"]);
  const semantic = parseBackend(env["LLM_BACKEND_SEMANTIC"]);
  if (proposal) taskBackends.proposal = proposal;
  if (selection) taskBackends.selection = selection;
  if (consequence) taskBackends.consequence = consequence;
  if (semantic) taskBackends.semantic = semantic;
  const simpleModel = env["LLM_SIMPLE_MODEL"]?.trim() || undefined;
  // Exp-6 item 6: token budgets proportional to payload
  // (LLM_MAX_TOKENS_{PROPOSAL,SELECTION,CONSEQUENCE,SEMANTIC}).
  const maxTokensByTask: Partial<Record<LlmTask, number>> = {};
  for (const task of ["proposal", "selection", "consequence", "semantic"] as const) {
    const raw = env[`LLM_MAX_TOKENS_${task.toUpperCase()}`];
    const n = raw !== undefined && raw !== "" ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) maxTokensByTask[task] = Math.floor(n);
  }
  // F14: per-task temperatures (LLM_TEMPERATURE_{PROPOSAL,SELECTION,
  // CONSEQUENCE,SEMANTIC}), each falling back to LLM_TEMPERATURE. Chain:
  // LLM_TEMPERATURE_<TASK> → LLM_TEMPERATURE → DEFAULT_TASK_TEMPERATURES.
  // Unlike maxTokens, temperature 0 is meaningful (deterministic), so the
  // validity floor is >= 0 rather than > 0.
  const globalTempRaw = env["LLM_TEMPERATURE"];
  const globalTempN =
    globalTempRaw !== undefined && globalTempRaw !== "" ? Number(globalTempRaw) : NaN;
  const globalTempValid = Number.isFinite(globalTempN) && globalTempN >= 0;
  const temperatureByTask: Partial<Record<LlmTask, number>> = {};
  for (const task of ["proposal", "selection", "consequence", "semantic"] as const) {
    const raw = env[`LLM_TEMPERATURE_${task.toUpperCase()}`];
    const n = raw !== undefined && raw !== "" ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 0) temperatureByTask[task] = n;
    else if (globalTempValid) temperatureByTask[task] = globalTempN;
  }
  return {
    backend,
    simpleBackend,
    taskBackends,
    simpleModel,
    joingonka: {
      apiKey: env["JOINGONKA_API_KEY"],
      baseUrl: env["JOINGONKA_BASE_URL"] ?? JoinGonkaProvider.DEFAULT_BASE_URL,
      model: env["JOINGONKA_MODEL"] ?? JoinGonkaProvider.DEFAULT_MODEL,
    },
    laya: {
      baseUrl: env["LAYA_BASE_URL"] ?? LocalLayaProvider.DEFAULT_BASE_URL,
      model: env["LAYA_MODEL"] ?? LocalLayaProvider.DEFAULT_MODEL,
      apiKey: env["LAYA_API_KEY"],
    },
    ollama: {
      baseUrl: env["OLLAMA_BASE_URL"] ?? OllamaProvider.DEFAULT_BASE_URL,
      model: env["OLLAMA_MODEL"] ?? OllamaProvider.DEFAULT_MODEL,
      apiKey: env["OLLAMA_API_KEY"],
    },
    timeoutMs: Number(env["LLM_TIMEOUT_MS"] ?? DEFAULT_TIMEOUT_MS),
    temperature: Number(env["LLM_TEMPERATURE"] ?? 0.9),
    repeatPenalty: Number(env["LLM_REPEAT_PENALTY"] ?? 1.1),
    maxTokens: Number(env["LLM_MAX_TOKENS"] ?? 1500),
    // F13: JSON mode is ON by default; LLM_JSON_MODE=0 (or "false") disables it.
    jsonMode: env["LLM_JSON_MODE"] !== "0" && env["LLM_JSON_MODE"]?.toLowerCase() !== "false",
    maxTokensByTask,
    temperatureByTask,
  };
}

/** Resolve which backend serves a task: per-task override → tier default. */
export function resolveTaskBackend(task: LlmTask, cfg: LlmEnvConfig): LlmBackend {
  return cfg.taskBackends[task] ?? (isSimpleLlmTask(task) ? cfg.simpleBackend : cfg.backend);
}

/**
 * Exp-4 item 2 (S1): effective model name for a task, mirroring
 * createProviderForTask's resolution (per-task LLM_BACKEND_* override →
 * tier default; LLM_SIMPLE_MODEL applies to simple tasks). Used to detect
 * a no-op capable tier (same provider AND same model as the simple tier).
 * Pure.
 */
export function resolveTaskModel(task: LlmTask, cfg: LlmEnvConfig): string {
  const which = resolveTaskBackend(task, cfg);
  if (isSimpleLlmTask(task) && cfg.simpleModel) return cfg.simpleModel;
  if (which === "laya-local") return cfg.laya.model;
  if (which === "ollama") return cfg.ollama.model;
  return cfg.joingonka.model;
}

/** Backends accepted by LLM_BACKEND / --provider. */
export function knownBackends(): LlmBackend[] {
  return [...KNOWN_BACKENDS];
}

/**
 * Build the default provider from env. Tiered split (default):
 * hard tasks (proposal/consequence) on JoinGonka, simple tasks
 * (selection/semantic) on the local backend — pass `backend:
 * "laya-local"` to route a specific engine at construction time,
 * or use createProviderForTask() for tier-aware routing.
 */
export function createProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  backend?: LlmBackend,
): LLMProvider {
  const cfg = resolveLlmEnv(env);
  const which = backend ?? cfg.backend;
  return buildProviderForBackend(cfg, which);
}

/**
 * F14: built-in per-task temperature defaults, used when neither
 * LLM_TEMPERATURE_<TASK> nor LLM_TEMPERATURE is set. Classification tasks
 * (selection, semantic) want determinism; creative tasks keep 0.9.
 */
export const DEFAULT_TASK_TEMPERATURES: Record<LlmTask, number> = {
  proposal: 0.9,
  selection: 0.2,
  consequence: 0.9,
  semantic: 0.2,
};

/**
 * F14: effective temperature for a task. Chain: LLM_TEMPERATURE_<TASK> →
 * LLM_TEMPERATURE (both baked into cfg.temperatureByTask by resolveLlmEnv)
 * → built-in per-task default.
 */
export function resolveTaskTemperature(task: LlmTask, cfg: LlmEnvConfig): number {
  return cfg.temperatureByTask[task] ?? DEFAULT_TASK_TEMPERATURES[task];
}

function buildProviderForBackend(
  cfg: LlmEnvConfig,
  which: LlmBackend,
  modelOverride?: string,
  task?: LlmTask,
): LLMProvider {
  // Exp-6 item 6: token budgets proportional to payload — the per-task
  // LLM_MAX_TOKENS_* override wins over the global LLM_MAX_TOKENS.
  const maxTokens = (task !== undefined ? cfg.maxTokensByTask[task] : undefined) ?? cfg.maxTokens;
  // F14: per-task temperature — the per-task LLM_TEMPERATURE_* override
  // wins over the global LLM_TEMPERATURE (which itself falls back to the
  // built-in per-task defaults in resolveTaskTemperature).
  const temperature = task !== undefined ? resolveTaskTemperature(task, cfg) : cfg.temperature;
  if (which === "laya-local") {
    return new LocalLayaProvider({
      baseUrl: cfg.laya.baseUrl,
      model: modelOverride ?? cfg.laya.model,
      apiKey: cfg.laya.apiKey,
      temperature,
      repeatPenalty: cfg.repeatPenalty,
      maxTokens,
      timeoutMs: cfg.timeoutMs,
      jsonMode: cfg.jsonMode,
    });
  }
  if (which === "ollama") {
    return new OllamaProvider({
      baseUrl: cfg.ollama.baseUrl,
      model: modelOverride ?? cfg.ollama.model,
      apiKey: cfg.ollama.apiKey,
      temperature,
      repeatPenalty: cfg.repeatPenalty,
      maxTokens,
      timeoutMs: cfg.timeoutMs,
      jsonMode: cfg.jsonMode,
    });
  }
  if (!cfg.joingonka.apiKey) {
    throw new Error("JOINGONKA_API_KEY is not set (see https://gate.joingonka.ai/dashboard)");
  }
  return new JoinGonkaProvider({
    apiKey: cfg.joingonka.apiKey,
    baseUrl: cfg.joingonka.baseUrl,
    model: modelOverride ?? cfg.joingonka.model,
    temperature,
    repeatPenalty: cfg.repeatPenalty,
    maxTokens,
    timeoutMs: cfg.timeoutMs,
    jsonMode: cfg.jsonMode,
  });
}

/**
 * Tier-aware provider builder: resolves the backend for `task`
 * (per-task LLM_BACKEND_* override → tier default) and applies
 * LLM_SIMPLE_MODEL to simple tasks when set.
 */
export function createProviderForTask(
  env: NodeJS.ProcessEnv = process.env,
  task: LlmTask = "consequence",
): LLMProvider {
  const cfg = resolveLlmEnv(env);
  const which = resolveTaskBackend(task, cfg);
  const modelOverride = isSimpleLlmTask(task) ? cfg.simpleModel : undefined;
  return buildProviderForBackend(cfg, which, modelOverride, task);
}

/**
 * Exp-6 item 6: provider health probing with model fallback.
 *
 * The Exp-6 run burned 37 transport timeouts in 9 turns against a sick
 * gateway before any turn completed. Probe the OpenAI-compatible
 * `/models` endpoint with a short timeout; false means "don't send the
 * next turn's 8 LLM calls here".
 */
export async function probeLlmEndpoint(
  baseUrl: string,
  opts: { apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const headers: Record<string, string> = {};
    if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;
    const res = await fetchImpl(joinUrl(baseUrl, "/models"), {
      headers,
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function isTransportError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timed out|rate limited|HTTP 429|HTTP 5\d\d|socket|ECONN|ENOTFOUND|fetch failed|empty response/i.test(
    msg,
  );
}

/**
 * Exp-6 item 6: failover wrapper. Sends every call to `primary`; on a
 * transport-class failure (timeout, 429, 5xx, socket) it probes both
 * backends once and fails over to `fallback` for subsequent calls until
 * the primary probes healthy again. Content/parse errors are NOT failed
 * over — those are the caller's to repair, not the backend's fault.
 */
export class FailoverProvider implements LLMProvider {
  readonly name: string;
  private useFallback = false;
  private lastProbeAt = 0;
  private readonly probeCacheMs: number;
  /** F31: the provider that served the most recent call (for usage delegation). */
  private lastServed: LLMProvider | undefined;

  constructor(
    private readonly primary: LLMProvider,
    private readonly fallback: LLMProvider,
    opts: { probeCacheMs?: number } = {},
  ) {
    this.name = `failover(${primary.name}→${fallback.name})`;
    this.probeCacheMs = opts.probeCacheMs ?? 60_000;
  }

  /** Which backend the next call will use (for logs/tests). */
  get activeName(): string {
    return this.useFallback ? this.fallback.name : this.primary.name;
  }

  /** F31: usage from whichever backend served the last call. Drained on read. */
  takeLastUsage(): LlmUsage | undefined {
    return this.lastServed?.takeLastUsage?.();
  }

  private endpointBaseUrl(p: LLMProvider): string | undefined {
    // OpenAICompatibleProvider exposes baseUrl; foreign providers probe
    // as healthy (failover still triggers on their transport errors).
    return p instanceof OpenAICompatibleProvider ? p.baseUrl : undefined;
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    opts?: LlmCallOptions,
  ): Promise<string> {
    const active = (): LLMProvider => (this.useFallback ? this.fallback : this.primary);
    this.lastServed = active();
    try {
      return await this.lastServed.complete(systemPrompt, userPrompt, opts);
    } catch (err) {
      if (!isTransportError(err)) throw err;
      // Transport failure is real signal: fail over immediately for the
      // retry. The cached probe below only refines stickiness when it has
      // real endpoint signal (OpenAI-compatible backends); providers
      // without a probeable endpoint keep the error-driven choice.
      this.useFallback = !this.useFallback;
      const now = Date.now();
      if (now - this.lastProbeAt > this.probeCacheMs) {
        this.lastProbeAt = now;
        const primaryUrl = this.endpointBaseUrl(this.primary);
        const fallbackUrl = this.endpointBaseUrl(this.fallback);
        const [primaryOk, fallbackOk] = await Promise.all([
          primaryUrl ? probeLlmEndpoint(primaryUrl) : Promise.resolve(undefined),
          fallbackUrl ? probeLlmEndpoint(fallbackUrl) : Promise.resolve(undefined),
        ]);
        if (primaryOk === true) this.useFallback = false;
        else if (primaryOk === false && fallbackOk === true) this.useFallback = true;
      }
      this.lastServed = active();
      try {
        return await this.lastServed.complete(systemPrompt, userPrompt, opts);
      } catch {
        // Both backends failed — surface the first error (it carries the
        // original context); the caller retries per its own policy.
        throw err;
      }
    }
  }
}

/**
 * Exp-6 item 6: tier-aware provider with a fallback backend. The fallback
 * defaults to the *other* tier's backend (hosted ⇄ local) so a sick
 * gateway degrades to local models instead of stalling the session —
 * pass `fallbackBackend` explicitly to choose.
 */
export function createProviderForTaskWithFailover(
  env: NodeJS.ProcessEnv = process.env,
  task: LlmTask = "consequence",
  fallbackBackend?: LlmBackend,
): LLMProvider {
  const cfg = resolveLlmEnv(env);
  const which = resolveTaskBackend(task, cfg);
  const modelOverride = isSimpleLlmTask(task) ? cfg.simpleModel : undefined;
  const primary = buildProviderForBackend(cfg, which, modelOverride, task);
  const fallbackWhich =
    fallbackBackend ?? (isSimpleLlmTask(task) ? cfg.backend : cfg.simpleBackend);
  if (fallbackWhich === which) return primary;
  const fallback = buildProviderForBackend(cfg, fallbackWhich, undefined, task);
  return new FailoverProvider(primary, fallback);
}
