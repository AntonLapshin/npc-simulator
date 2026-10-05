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

export interface LLMProvider {
  /** Complete a system+user prompt pair. Resolves with raw text (JSON expected). */
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
  /** Human-readable backend id for logs (never includes secrets). */
  readonly name: string;
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
  /** Extra fetch init (custom headers, dispatcher, ...). */
  fetchImpl?: typeof fetch;
};

export const DEFAULT_TIMEOUT_MS = 60_000;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

  constructor(name: string, options: OpenAICompatibleOptions) {
    this.name = name;
    this.options = {
      baseUrl: options.baseUrl,
      model: options.model,
      temperature: options.temperature ?? 0.9,
      repeatPenalty: options.repeatPenalty ?? 1.1,
      maxTokens: options.maxTokens ?? 1500,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
    };
  }

  get model(): string {
    return this.options.model;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const fetchImpl = this.options.fetchImpl ?? fetch;
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
        }),
      });
      if (res.status === 429) {
        throw new Error(`${this.name}: rate limited (HTTP 429)`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `${this.name}: request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        );
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        const reason = data.choices?.[0]?.finish_reason ?? "unknown";
        throw new Error(`${this.name}: empty response (finish_reason=${reason})`);
      }
      return content;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`${this.name}: timed out after ${this.options.timeoutMs}ms`);
      }
      throw err instanceof Error ? err : new Error(`${this.name}: ${errorMessage(err)}`);
    } finally {
      clearTimeout(timer);
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
      fetchImpl: options.fetchImpl,
    });
  }
}

/** Locally served model via Ollama (OpenAI-compatible endpoint). */
export class OllamaProvider extends OpenAICompatibleProvider {
  static readonly DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
  /** Native Ollama API root derived from the OpenAI-compatible base URL. */
  static readonly DEFAULT_API_URL = "http://127.0.0.1:11434";
  /** Recommended uncensored models (see scripts/setup-ollama.sh). */
  static readonly RECOMMENDED_MODELS = [
    "fluffy/l3-8b-stheno-v3.2",
    "huihui_ai/llama3.2-abliterate:3b",
  ] as const;
  /** Default model: the more capable 8B roleplay model. */
  static readonly DEFAULT_MODEL = "fluffy/l3-8b-stheno-v3.2";

  constructor(options: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    temperature?: number;
    repeatPenalty?: number;
    maxTokens?: number;
    timeoutMs?: number;
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

export type LlmEnvConfig = {
  backend: LlmBackend;
  joingonka: { apiKey?: string; baseUrl: string; model: string };
  laya: { baseUrl: string; model: string; apiKey?: string };
  ollama: { baseUrl: string; model: string; apiKey?: string };
  timeoutMs: number;
  temperature: number;
  repeatPenalty: number;
  maxTokens: number;
};

const KNOWN_BACKENDS: LlmBackend[] = ["joingonka", "laya-local", "ollama"];

/** Read backend configuration from environment (no secrets are ever logged). */
export function resolveLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  const raw = env["LLM_BACKEND"];
  const backend: LlmBackend =
    raw === "laya-local" || raw === "ollama" || raw === "joingonka" ? raw : "joingonka";
  return {
    backend,
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
  };
}

/** Backends accepted by LLM_BACKEND / --provider. */
export function knownBackends(): LlmBackend[] {
  return [...KNOWN_BACKENDS];
}

/**
 * Build the default provider from env. Recommended split (§16):
 * creative work (proposal/consequence) on JoinGonka, fast local
 * decisions (selection) on Laya — pass `backend: "laya-local"` to
 * route a specific engine at construction time.
 */
export function createProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  backend?: LlmBackend,
): LLMProvider {
  const cfg = resolveLlmEnv(env);
  const which = backend ?? cfg.backend;
  if (which === "laya-local") {
    return new LocalLayaProvider({
      baseUrl: cfg.laya.baseUrl,
      model: cfg.laya.model,
      apiKey: cfg.laya.apiKey,
      temperature: cfg.temperature,
      repeatPenalty: cfg.repeatPenalty,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.timeoutMs,
    });
  }
  if (which === "ollama") {
    return new OllamaProvider({
      baseUrl: cfg.ollama.baseUrl,
      model: cfg.ollama.model,
      apiKey: cfg.ollama.apiKey,
      temperature: cfg.temperature,
      repeatPenalty: cfg.repeatPenalty,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.timeoutMs,
    });
  }
  if (!cfg.joingonka.apiKey) {
    throw new Error("JOINGONKA_API_KEY is not set (see https://gate.joingonka.ai/dashboard)");
  }
  return new JoinGonkaProvider({
    apiKey: cfg.joingonka.apiKey,
    baseUrl: cfg.joingonka.baseUrl,
    model: cfg.joingonka.model,
    temperature: cfg.temperature,
    repeatPenalty: cfg.repeatPenalty,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
  });
}
