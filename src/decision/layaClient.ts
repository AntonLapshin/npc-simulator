// Thin imperative shell over the pure wire-protocol utils: typed
// POST /v1/systemone client with timeout + AbortSignal.

import type { LayaAnswer, LayaQuestion } from "./decisionTypes.js";
import {
  buildSystemOnePayload,
  LayaProtocolError,
  parseSystemOneResponse,
} from "./utils/layaProtocol.js";

export class LayaUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LayaUnavailableError";
  }
}

export type LayaClientOptions = {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 5000;

export class LayaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LayaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get url(): string {
    return this.baseUrl;
  }

  /**
   * Send state + questions in one forward pass. Throws LayaUnavailableError
   * on network failure, timeout, non-2xx, or an unusable response body —
   * callers treat all of these as "fall back".
   */
  async decide(
    state: string,
    questions: Record<string, LayaQuestion>,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, LayaAnswer>> {
    const payload = buildSystemOnePayload(state, questions);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: opts?.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new LayaUnavailableError(`laya request failed: ${messageOf(err)}`, { cause: err });
    }
    if (!res.ok) {
      throw new LayaUnavailableError(`laya answered HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new LayaUnavailableError("laya answered with non-JSON body", { cause: err });
    }
    try {
      return parseSystemOneResponse(body, questions);
    } catch (err) {
      if (err instanceof LayaProtocolError) {
        throw new LayaUnavailableError(`laya protocol error: ${err.message}`, { cause: err });
      }
      throw err;
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
