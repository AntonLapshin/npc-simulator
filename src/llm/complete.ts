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
import { errorMessage } from "../util/errors.js";

export type LlmModule = "proposal" | "selection" | "consequence" | "semantic";

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
  /**
   * Exp-6 item 3: consecutive identical parse-error failures before the
   * loop varies its strategy (one minimal schema-only attempt with no
   * echoed bad output — re-prompting identically is futile: the model
   * re-emits the same collapsed shape 4/4). Defaults to 2.
   */
  identicalErrorAbortAfter?: number;
  /** Expected output shape text, used to build the minimal repair prompt. */
  schemaText?: string;
};

export type CompleteJsonResult<T> =
  | { ok: true; raw: string; value: T; attempts: number }
  | {
      ok: false;
      error: string;
      lastRaw?: string;
      attempts: number;
      /** Raw LLM outputs from every failed parse attempt, in order (Exp-6 item 4). */
      rawAttempts: string[];
    };

/**
 * Exp-6 item 3: normalize a parse error into a repeat signature. Digit
 * runs collapse so "position 37" and "position 38" (the systematic
 * template quirk from the Exp-6 run) count as the same failure.
 */
export function parseErrorSignature(message: string): string {
  return message.toLowerCase().replace(/\s+/g, " ").replace(/\d+/g, "#").slice(0, 160);
}

/** Exp-6 item 3: minimal schema-only repair prompt — no echoed bad output. */
export function minimalRepairPrompt(schemaText?: string): string {
  const lines = [
    "Return ONLY the JSON object now.",
    "Begin your response with { — no analysis, no preamble, no markdown, no commentary.",
  ];
  if (schemaText) {
    lines.push("It must match this schema:", schemaText);
  }
  lines.push("Return COMPACT single-line JSON (no pretty-printing).");
  return lines.join("\n");
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
  const rawAttempts: string[] = [];
  const attempts = Math.max(1, opts.maxRetries + 1);
  const abortAfter = Math.max(1, opts.identicalErrorAbortAfter ?? 2);
  let lastErrorSignature: string | undefined;
  let identicalStreak = 0;
  let variedStrategy = false;

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
        error: errorMessage(err),
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
      const message = errorMessage(err);
      rawAttempts.push(raw);
      const signature = parseErrorSignature(message);
      identicalStreak = signature === lastErrorSignature ? identicalStreak + 1 : 1;
      lastErrorSignature = signature;
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
      if (identicalStreak >= abortAfter && !variedStrategy) {
        // Exp-6 item 3: the repair prompt never converges — the same error
        // repeats, so the model re-emits the same collapsed shape.
        // Expecting a different result from an identical prompt is the
        // loop's design flaw: vary the strategy once (minimal schema-only
        // prompt, no echoed bad output to anchor on) instead of burning
        // the remaining attempts identically.
        variedStrategy = true;
        userPrompt = minimalRepairPrompt(opts.schemaText);
        logger.log({
          module,
          event: failedEvent,
          tick: opts.tick,
          turnIndex: opts.turnIndex,
          actorId: opts.actorId,
          input: { ...(opts.input as Record<string, unknown>), attempt },
          error: `identical parse error repeated ${identicalStreak}x — varying strategy to minimal schema-only prompt`,
        });
        continue;
      }
      if (identicalStreak > abortAfter) {
        // The varied strategy failed identically too — stop burning calls.
        return {
          ok: false,
          error: `aborted: identical parse error repeated ${identicalStreak} times ("${signature}")`,
          lastRaw,
          attempts: attempt,
          rawAttempts,
        };
      }
      userPrompt = `${baseUserPrompt}\n\n${formatRepairPrompt(raw, message, opts.repairHint)}`;
    }
  }

  return { ok: false, error: "max retries exceeded", lastRaw, attempts, rawAttempts };
}
