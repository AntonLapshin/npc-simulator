// Intent Engine backed by an LLM (PLAN_V2 Phase 1).
//
// Replaces proposal+selection on the v2 turn path with a single structured
// call: the prompt states the physical facts (who stands where, who holds
// what, what is within reach) and asks for one thing —
// { action: "one sentence, third person", quote: "exact words or empty" }.
// The engine validates deterministically, retries exactly once on failure,
// and falls back to FALLBACK_INTENT so the simulation never deadlocks.

import type { IntentEngine } from "../intelligence/types.js";
import type { World } from "../types.js";
import {
  FALLBACK_INTENT,
  validateIntentValue,
  type IntentResult,
} from "../core/intent.js";
import { intentResultSchema } from "../schemas.js";
import {
  buildIdentityAnchor,
  formatHistoryForPrompt,
  historyVisibleTo,
} from "../engine/contextBuilder.js";
import { buildPhysicalFacts } from "../decision/decisionState.js";
import type { Logger } from "../logging/logger.js";
import type { LLMProvider } from "./provider.js";
import { INTENT_OUTPUT_SCHEMA, LLM_SYSTEM_PROMPT, intentSuffix } from "./prompts.js";
import { completeJson } from "./complete.js";

export type LlmIntentEngineOptions = {
  /** Parse-retry budget. Defaults to 1 (PLAN_V2: exactly 1 retry, then the deterministic fallback). */
  maxRetries?: number;
  /** Recent-history entries in the intent prompt. Defaults to 5 (slim — the intent needs what just happened, not the archive). */
  historyLimit?: number;
};

/**
 * The intent prompt: identity + physical facts + what just happened +
 * the task. Reuses the contextBuilder/decisionState builders — no new
 * scene text is invented here. Pure — exported for unit tests.
 */
export function buildIntentPrompt(
  world: World,
  actorId: string,
  opts: { historyLimit?: number } = {},
): string {
  const actor = world.actors.find((a) => a.id === actorId);
  const name = actor?.name ?? actorId;
  // F6: the prompt sees only what this actor perceived or authored.
  const recentHistory = formatHistoryForPrompt(
    historyVisibleTo(world, actorId),
    opts.historyLimit ?? 5,
  );
  return [
    buildIdentityAnchor(world, actorId),
    "",
    "Ground your answer ONLY in the physical facts below — do not invent people, objects, or positions that are not listed.",
    "",
    "PHYSICAL FACTS (the real scene right now):",
    "",
    buildPhysicalFacts(world, actorId),
    // PLAN_V2 Phase 5 (the director): the injected incident is a world
    // fact — the engine decided drama happens; the actor decides how to
    // engage with it.
    ...(world.directorPendingIncident !== undefined
      ? [
          "",
          "WORLD FACT — NEW INCIDENT:",
          "",
          world.directorPendingIncident.text,
          "",
          "Treat this as a real event happening in the scene right now — every character would notice it. " +
            "Your action should engage with it in character rather than ignoring it.",
        ]
      : []),
    "",
    "WHAT JUST HAPPENED:",
    "",
    recentHistory,
    "",
    "TASK:",
    "",
    `Decide the ONE thing ${name} does next — one clear beat: move, speak, use an object, gesture, or quietly wait and observe.`,
    `Describe exactly what ${name} DOES in "action": one third-person sentence the engine executes literally (no teleporting, no invented props).`,
    `If ${name} speaks, put their EXACT words in "quote" — copied word-for-word from the action, never paraphrased; otherwise "quote" is "".`,
    "",
    intentSuffix(),
  ].join("\n");
}

export class LLMIntentEngine implements IntentEngine {
  /** Phase 6: intent() performs provider calls — counted in the turn budget's proposal slot. */
  readonly providerBacked = true;

  constructor(
    private readonly logger: Logger,
    private readonly provider: LLMProvider,
    private readonly options: LlmIntentEngineOptions = {},
  ) {}

  async intent(world: World, actorId: string): Promise<IntentResult> {
    const startedAt = Date.now();
    // PLAN_V2 Phase 1: exactly 1 retry on validation failure, then the
    // deterministic fallback (completeJson attempts = maxRetries + 1).
    const maxRetries = this.options.maxRetries ?? 1;

    let userPrompt: string;
    let suffix: string;
    try {
      suffix = intentSuffix();
      userPrompt = buildIntentPrompt(world, actorId, {
        historyLimit: this.options.historyLimit,
      });
    } catch (err) {
      this.logger.log({
        module: "intent",
        event: "intent_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        input: { actorId },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
      return structuredClone(FALLBACK_INTENT);
    }

    const result = await completeJson({
      logger: this.logger,
      provider: this.provider,
      module: "intent",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      systemPrompt: LLM_SYSTEM_PROMPT,
      userPrompt,
      input: { actorId },
      maxRetries,
      schema: intentResultSchema,
      schemaText: INTENT_OUTPUT_SCHEMA,
      // F33: protected instruction tail — kept intact if the input cap
      // truncates the world-dump portion of the prompt.
      suffix,
      extraCheck: (value) => {
        const validation = validateIntentValue(value);
        return validation.ok ? undefined : validation.error;
      },
      repairHint:
        "the payload must be exactly { action, quote }: " +
        '"action" is ONE non-empty third-person sentence (max 600 chars); ' +
        '"quote" is a string — the exact words spoken, or "" when the actor says nothing (max 600 chars).',
    });

    if (!result.ok) {
      this.logger.log({
        module: "intent",
        event: "intent_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        input: { actorId },
        prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
        rawResponse: result.lastRaw,
        // F31: usage from the last attempt, when the backend reported it.
        usage: result.usage,
        error: `fallback: ${result.error}`,
        durationMs: Date.now() - startedAt,
      });
      return structuredClone(FALLBACK_INTENT);
    }

    const fullPrompt = `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`;
    this.logger.log({
      module: "intent",
      event: "intent_completed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      prompt: fullPrompt,
      promptChars: fullPrompt.length,
      promptTokensEstimate: Math.ceil(fullPrompt.length / 4),
      rawResponse: result.raw,
      parsedResponse: result.value,
      // F31: per-call usage captured from the chat-completions response.
      usage: result.usage,
      output: result.value,
      durationMs: Date.now() - startedAt,
    });
    return result.value;
  }
}
