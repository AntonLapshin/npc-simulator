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
import type { LlmUsage } from "../logging/logTypes.js";
import { formatRepairPrompt, parseJsonObject } from "./json.js";
import { takeConsequenceRepairNotes } from "../schemas.js";
import { errorMessage } from "../util/errors.js";

export type LlmModule = "proposal" | "selection" | "consequence" | "semantic" | "intent";

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
  /**
   * F33: protected instruction tail of the user prompt (output schema +
   * rules), kept intact when the input cap truncates the world dump.
   * Engines pass the suffix they appended; when absent, a trailing
   * instruction window is protected heuristically.
   */
  suffix?: string;
  /**
   * F33: input char cap for the rendered prompt (env LLM_MAX_INPUT_CHARS,
   * default 60000). When exceeded, the world-dump portion is truncated
   * with a note and a warning is logged.
   */
  maxInputChars?: number;
  /**
   * F28: turn-deadline AbortSignal. Forwarded to the provider so a hung
   * request is actually cancelled on timeout instead of burning tokens in
   * the background after the turn moved on.
   */
  signal?: AbortSignal;
};

export type CompleteJsonResult<T> =
  | { ok: true; raw: string; value: T; attempts: number; usage?: LlmUsage }
  | {
      ok: false;
      error: string;
      lastRaw?: string;
      attempts: number;
      /** Raw LLM outputs from every failed parse attempt, in order (Exp-6 item 4). */
      rawAttempts: string[];
      /** F31: usage reported for the last attempt, when the backend reports it. */
      usage?: LlmUsage;
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

/** Exp-6 item 5: absolute ceiling for the truncation budget raise. */
export const MAX_RAISED_BUDGET = 8000;

/**
 * Exp-6 item 5: true when the failure is a truncation AT the configured
 * budget — not a content error worth repair-prompting. Two signals:
 * the provider's finish_reason=length, or usage.completionTokens hitting
 * the effective max_tokens exactly (exp-6 tick-4: 1500 == LLM_MAX_TOKENS).
 * Pure.
 */
export function isTruncationAtBudget(
  message: string,
  usage: LlmUsage | undefined,
  budget: number | undefined,
): boolean {
  if (/finish_reason=length/.test(message)) return true;
  if (
    budget !== undefined &&
    usage?.completionTokens !== undefined &&
    usage.completionTokens >= budget
  ) {
    return true;
  }
  return false;
}

function fullPrompt(systemPrompt: string, userPrompt: string): string {
  return `${systemPrompt}\n\n${userPrompt}`;
}

/** F33: default input char cap for a rendered prompt (env LLM_MAX_INPUT_CHARS). */
export const DEFAULT_MAX_INPUT_CHARS = 60_000;

function resolveMaxInputChars(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const raw = process.env["LLM_MAX_INPUT_CHARS"];
  const n = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_MAX_INPUT_CHARS;
}

/**
 * F33: enforce the input cap on the rendered prompt. Truncates the
 * world-dump portion (the head of the user prompt) and keeps the trailing
 * instruction tail intact: the engine-supplied `suffix` when the user
 * prompt ends with it, otherwise a trailing instruction window
 * (the schema/rules tail lives at the end of every engine prompt).
 */
export function applyInputCap(
  systemPrompt: string,
  userPrompt: string,
  suffix: string | undefined,
  maxInputChars: number,
): { systemPrompt: string; userPrompt: string; truncated: boolean; originalChars: number } {
  const originalChars = systemPrompt.length + 2 + userPrompt.length;
  if (originalChars <= maxInputChars) {
    return { systemPrompt, userPrompt, truncated: false, originalChars };
  }
  const note = `[truncated: prompt exceeded LLM_MAX_INPUT_CHARS=${maxInputChars}]`;
  let head = userPrompt;
  let tail = "";
  if (suffix && suffix.length > 0 && userPrompt.endsWith(suffix)) {
    head = userPrompt.slice(0, userPrompt.length - suffix.length);
    tail = suffix;
  } else {
    const PROTECTED_TAIL_CHARS = 2000;
    if (userPrompt.length > PROTECTED_TAIL_CHARS) {
      tail = userPrompt.slice(userPrompt.length - PROTECTED_TAIL_CHARS);
      head = userPrompt.slice(0, userPrompt.length - PROTECTED_TAIL_CHARS);
    }
  }
  const keep = Math.max(
    0,
    maxInputChars - (systemPrompt.length + 2 + note.length + 4 + tail.length),
  );
  return {
    systemPrompt,
    userPrompt: `${head.slice(0, keep)}\n\n${note}\n${tail}`,
    truncated: true,
    originalChars,
  };
}

/**
 * F11: exponential backoff with jitter between completeJson attempts:
 * min(1000 * 2^attempt, 8000)ms + up-to-1s jitter. HTTP 429 honors the
 * Retry-After header (surfaced by the provider as "retry after Ns" in the
 * error text), capped at 30s; a 429 without the header backs off up to 30s.
 * Only transport failures back off — parse failures get repair prompts,
 * not delays.
 */
export function backoffDelayMs(attempt: number, err: unknown): number {
  const jitter = Math.random() * 1000;
  const msg = err instanceof Error ? err.message : String(err);
  const isRateLimited = /HTTP 429|rate limited/i.test(msg);
  const retryAfter = /retry after (\d+(?:\.\d+)?)s/i.exec(msg);
  if (retryAfter) {
    const secs = Number(retryAfter[1]);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000) + jitter;
  }
  const cap = isRateLimited ? 30_000 : 8_000;
  return Math.min(1000 * 2 ** attempt, cap) + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** F15: short fingerprint of the raw payload for the lenient-repair log. */
function payloadFingerprint(raw: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function completeJson<T>(opts: CompleteJsonOptions<T>): Promise<CompleteJsonResult<T>> {
  const { logger, provider, module } = opts;
  const startedEvent = `${module}_started` as const;
  const failedEvent = `${module}_failed` as const;

  // F33: cap the rendered prompt BEFORE logging/sending it.
  const maxInputChars = resolveMaxInputChars(opts.maxInputChars);
  const capped = applyInputCap(opts.systemPrompt, opts.userPrompt, opts.suffix, maxInputChars);
  if (capped.truncated) {
    logger.log({
      module,
      event: `${module}_prompt_truncated`,
      tick: opts.tick,
      turnIndex: opts.turnIndex,
      actorId: opts.actorId,
      input: opts.input,
      promptChars: capped.originalChars,
      error:
        `prompt was ${capped.originalChars} chars (LLM_MAX_INPUT_CHARS=${maxInputChars}); ` +
        `world-dump portion truncated, instruction tail kept intact`,
    });
  }

  logger.log({
    module,
    event: startedEvent,
    tick: opts.tick,
    turnIndex: opts.turnIndex,
    actorId: opts.actorId,
    input: opts.input,
    prompt: fullPrompt(capped.systemPrompt, capped.userPrompt),
    promptChars: capped.systemPrompt.length + 2 + capped.userPrompt.length,
  });

  const baseUserPrompt = capped.userPrompt;
  let userPrompt = baseUserPrompt;
  let lastRaw: string | undefined;
  const rawAttempts: string[] = [];
  const attempts = Math.max(1, opts.maxRetries + 1);
  const abortAfter = Math.max(1, opts.identicalErrorAbortAfter ?? 2);
  let lastErrorSignature: string | undefined;
  let identicalStreak = 0;
  let variedStrategy = false;
  /** F31: usage from the most recent attempt that received a response. */
  let lastUsage: LlmUsage | undefined;

  // Exp-6 item 6: model-aware slowness signal — warn when ONE call takes
  // longer than half its timeout (previously a sick model was discovered
  // only by burning a full timeout).
  const tuning = provider.describeTuning?.();
  const slowCallMs = Math.max(30_000, (tuning?.timeoutMs ?? 60_000) / 2);
  // Exp-6 item 5: truncation budget-raise state — "raise, don't retry".
  let effectiveBudget = tuning?.maxTokens;
  let budgetRaised = false;

  const logSlowCall = (durationMs: number, outcome: string): void => {
    if (durationMs <= slowCallMs) return;
    logger.log({
      module,
      event: `${module}_slow_call`,
      tick: opts.tick,
      turnIndex: opts.turnIndex,
      actorId: opts.actorId,
      input: opts.input,
      durationMs,
      error:
        `single ${module} call took ${(durationMs / 1000).toFixed(1)}s (${outcome}) — ` +
        `over half the ${((tuning?.timeoutMs ?? 60_000) / 1000).toFixed(0)}s timeout ` +
        `(LLM_TIMEOUT_MS). For a local model, check GPU offload (\`ollama ps\` ` +
        `should show 100% GPU) and consider LLM_THINK=0.`,
    });
  };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let raw: string;
    const attemptStart = Date.now();
    try {
      raw = await provider.complete(capped.systemPrompt, userPrompt, {
        signal: opts.signal,
        // Exp-6 item 5: after a truncation-at-budget, the raised budget
        // rides along as a per-call override.
        maxTokens: budgetRaised ? effectiveBudget : undefined,
      });
    } catch (err) {
      // Transport failure: network, timeout, rate limit, empty provider
      // response (§16.4). Nothing to repair — back off, then retry with
      // the same prompt.
      logger.log({
        module,
        event: failedEvent,
        tick: opts.tick,
        turnIndex: opts.turnIndex,
        actorId: opts.actorId,
        input: { ...(opts.input as Record<string, unknown>), attempt },
        prompt: fullPrompt(capped.systemPrompt, userPrompt),
        error: errorMessage(err),
      });
      // F11: exponential backoff with jitter between attempts — no more
      // immediate retries (Exp-6's retry-amplification: 37 timeouts in
      // 9 turns). No sleep after the final attempt.
      if (attempt < attempts) {
        await sleep(backoffDelayMs(attempt, err));
      }
      continue;
    }
    lastRaw = raw;
    // F31: per-call usage for THIS attempt (drained — one read per request).
    const usage = provider.takeLastUsage?.();
    lastUsage = usage;

    try {
      const parsed: unknown = parseJsonObject(raw);
      // F15: bracket the schema parse so lenient-repair notes belong to
      // exactly this parse (direct safeParse calls elsewhere leave notes
      // pending until the next drain).
      takeConsequenceRepairNotes();
      const validation = opts.schema.safeParse(parsed);
      const repairNotes = takeConsequenceRepairNotes();
      if (!validation.success) {
        throw new Error(
          `schema mismatch: ${validation.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        );
      }
      const extra = opts.extraCheck?.(validation.data);
      if (extra) throw new Error(extra);
      if (repairNotes.length > 0) {
        // F15: lenient repairs are logged LOUDLY — what was
        // repaired/defaulted/dropped, with a payload fingerprint.
        // (LogEntry carries no severity field; the dedicated event is the
        // warning signal.)
        logger.log({
          module,
          event: `${module}_lenient_repair`,
          tick: opts.tick,
          turnIndex: opts.turnIndex,
          actorId: opts.actorId,
          input: opts.input,
          rawResponse: raw,
          usage,
          error:
            `lenient normalization repaired/defaulted/dropped ${repairNotes.length} item(s): ` +
            `${repairNotes.join("; ")} | payload fingerprint: ${payloadFingerprint(raw)}`,
        });
      }
      logSlowCall(Date.now() - attemptStart, "completed");
      return { ok: true, raw, value: validation.data, attempts: attempt, usage };
    } catch (err) {
      // Malformed JSON, truncated response, or schema mismatch (§16.3):
      // retry with a formatting-correction prompt appended.
      const message = errorMessage(err);
      rawAttempts.push(raw);
      logSlowCall(Date.now() - attemptStart, `parse failed: ${message.slice(0, 80)}`);
      // Exp-6 item 5: truncation AT the budget is not a content error —
      // repair-prompting the same doomed budget is futile. Raise the
      // budget once (×2, capped) and retry with a minimal prompt so the
      // extra headroom goes to the payload, not to echoed bad output.
      if (
        !budgetRaised &&
        attempt < attempts &&
        effectiveBudget !== undefined &&
        effectiveBudget < MAX_RAISED_BUDGET &&
        isTruncationAtBudget(message, usage, effectiveBudget)
      ) {
        const raised = Math.min(effectiveBudget * 2, MAX_RAISED_BUDGET);
        logger.log({
          module,
          event: `${module}_budget_raised`,
          tick: opts.tick,
          turnIndex: opts.turnIndex,
          actorId: opts.actorId,
          input: opts.input,
          output: { from: effectiveBudget, to: raised },
          error:
            `output truncated at the ${effectiveBudget}-token budget ` +
            `(${message.slice(0, 120)}): raising to ${raised} for the retry instead of repair-prompting`,
        });
        effectiveBudget = raised;
        budgetRaised = true;
        userPrompt = minimalRepairPrompt(opts.schemaText);
        continue;
      }
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
        prompt: fullPrompt(capped.systemPrompt, userPrompt),
        rawResponse: raw,
        usage,
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
          usage: lastUsage,
        };
      }
      userPrompt = `${baseUserPrompt}\n\n${formatRepairPrompt(raw, message, opts.repairHint)}`;
    }
  }

  return { ok: false, error: "max retries exceeded", lastRaw, attempts, rawAttempts, usage: lastUsage };
}
