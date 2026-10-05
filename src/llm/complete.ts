// Shared LLM call loop for the real engines (Milestone 2, §16.3-16.4).
//
// Every engine must: call the provider, log the prompt, log the raw
// response, parse JSON, validate the schema, retry on parse failure with
// a formatting-correction prompt (up to maxRetries), and signal failure
// so the caller can return its §16.5 fallback. Nothing here judges
// content — only transport errors, JSON validity, and schema validity.

import type { z } from "zod";
import type { Logger } from "../logging/logger.js";
import type { LLMProvider } from "./provider.js";
import { formatRepairPrompt, parseJsonObject } from "./json.js";

export type LlmModule = "proposal" | "selection" | "consequence";

export type CompleteJsonOptions<T> = {
  logger: Logger;
  provider: LLMProvider;
  module: LlmModule;
  tick: number;
  turnIndex: number;
  actorId?: string;
  systemPrompt: string;
  userPrompt: string;
  input?: unknown;
  maxRetries: number;
  schema: z.ZodType<T>;
  /** Extra semantic check. Return an error message when the value is unusable. */
  extraCheck?: (value: T) => string | undefined;
  /** Module-specific field rules appended to the formatting-retry prompt. */
  repairHint?: string;
};

export type CompleteJsonResult<T> =
  | { ok: true; raw: string; value: T; attempts: number }
  | { ok: false; error: string; lastRaw?: string; attempts: number };

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fullPrompt(systemPrompt: string, userPrompt: string): string {
  return `${systemPrompt}\n\n${userPrompt}`;
}

export async function completeJson<T>(opts: CompleteJsonOptions<T>): Promise<CompleteJsonResult<T>> {
  const { logger, provider, module } = opts;
  const startedEvent = `${module}_started` as const;
  const failedEvent = `${module}_failed` as const;

  logger.log({
    module,
    event: startedEvent,
    tick: opts.tick,
    turnIndex: opts.turnIndex,
    actorId: opts.actorId,
    input: opts.input,
    prompt: fullPrompt(opts.systemPrompt, opts.userPrompt),
  });

  const baseUserPrompt = opts.userPrompt;
  let userPrompt = baseUserPrompt;
  let lastRaw: string | undefined;
  const attempts = Math.max(1, opts.maxRetries + 1);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let raw: string;
    try {
      raw = await provider.complete(opts.systemPrompt, userPrompt);
    } catch (err) {
      // Transport failure: network, timeout, rate limit, empty provider
      // response (§16.4). Nothing to repair — retry with the same prompt.
      logger.log({
        module,
        event: failedEvent,
        tick: opts.tick,
        turnIndex: opts.turnIndex,
        actorId: opts.actorId,
        input: { ...(opts.input as Record<string, unknown>), attempt },
        prompt: fullPrompt(opts.systemPrompt, userPrompt),
        error: errMsg(err),
      });
      continue;
    }
    lastRaw = raw;

    try {
      const parsed: unknown = parseJsonObject(raw);
      const validation = opts.schema.safeParse(parsed);
      if (!validation.success) {
        throw new Error(
          `schema mismatch: ${validation.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        );
      }
      const extra = opts.extraCheck?.(validation.data);
      if (extra) throw new Error(extra);
      return { ok: true, raw, value: validation.data, attempts: attempt };
    } catch (err) {
      // Malformed JSON, truncated response, or schema mismatch (§16.3):
      // retry with a formatting-correction prompt appended.
      const message = errMsg(err);
      logger.log({
        module,
        event: failedEvent,
        tick: opts.tick,
        turnIndex: opts.turnIndex,
        actorId: opts.actorId,
        input: { ...(opts.input as Record<string, unknown>), attempt },
        prompt: fullPrompt(opts.systemPrompt, userPrompt),
        rawResponse: raw,
        error: message,
      });
      userPrompt = `${baseUserPrompt}\n\n${formatRepairPrompt(raw, message, opts.repairHint)}`;
    }
  }

  return { ok: false, error: "max retries exceeded", lastRaw, attempts };
}
