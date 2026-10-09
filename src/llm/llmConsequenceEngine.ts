// Render engine backed by an LLM (Phase 4 of the renderer architecture).
//
// Prose in, prose out: the engine has already executed this turn's
// movement, speech quote, manipulation, and pose (Phases 1–3) — the model
// narrates the executed facts, never emits patches or coordinates. The
// optional `feedback` carries prose-validation errors from a rejected
// first attempt and is embedded in the context; parse failures retry
// internally via completeJson; total failure yields the "Nothing changes."
// fallback.

import type { ConsequenceEngine, ConsequenceResolveOpts } from "../intelligence/types.js";
import type { Action, ConsequenceResult, World } from "../types.js";
import { consequenceResultSchema } from "../schemas.js";
import { buildConsequenceContext } from "../engine/contextBuilder.js";
import type { Logger } from "../logging/logger.js";
import type { LLMProvider } from "./provider.js";
import { LLM_SYSTEM_PROMPT, RENDER_OUTPUT_SCHEMA, renderSuffix } from "./prompts.js";
import { completeJson } from "./complete.js";

export const FALLBACK_CONSEQUENCE: ConsequenceResult = {
  narrative: "Nothing changes.",
  reasoning: "Fallback due to engine failure.",
};

export type LlmConsequenceEngineOptions = {
  /** Parse-retry budget (§16.3). Defaults to 3 (matches default EngineConfig). */
  maxRetries?: number;
};

export class LLMConsequenceEngine implements ConsequenceEngine {
  /** Phase 6: resolve() performs provider calls — counted by the turn budget. */
  readonly providerBacked = true;

  constructor(
    private readonly logger: Logger,
    private readonly provider: LLMProvider,
    private readonly options: LlmConsequenceEngineOptions = {},
  ) {}

  /**
   * Exp-6 item 2 (S3): user-turn directive. User turns bypass the
   * proposal/selection pipeline entirely — the action text IS the human
   * player's own words, not a suggestion to improve. Say so up front so
   * the writer preserves quoted/uttered speech verbatim instead of
   * substituting a generic beat (exp-6: 0/10 user turns kept their typed
   * speech; the stub attractor filled the gap).
   */
  static readonly USER_TURN_DIRECTIVE =
    "USER TURN: the action text below was typed by the human player — it is the ground truth " +
    "for this turn, not a suggestion. Preserve their uttered/quoted words VERBATIM in the " +
    "narrative (never substitute a generic greeting or different dialogue); narrate their " +
    "movement honestly from their text. Their speech outranks any example phrasing in these instructions.";

  /**
   * Phase 4: one render call. The executed facts (movement, exact quote,
   * manipulation) arrive via opts — computed by the turn orchestrator
   * before this call — and are surfaced to the model as the source of
   * truth to narrate. Old-schema keys (actorPatches/objectPatches/
   * effects) in the response are stripped by the schema and named in the
   * lenient-repair log — ignored, never validated.
   */
  async resolve(
    world: World,
    action: Action,
    feedback?: string,
    opts?: ConsequenceResolveOpts,
  ): Promise<ConsequenceResult> {
    const startedAt = Date.now();
    const maxRetries = this.options.maxRetries ?? 3;
    // Item C1: pass the real roster ids so the suffix carries the
    // roster-discipline line (retrieval beats recall for small models).
    const suffix = renderSuffix(world.actors.map((a) => a.id));
    const context = buildConsequenceContext(
      world,
      action,
      feedback,
      undefined,
      opts?.engineMovement,
      opts?.exactQuote,
      opts?.engineManipulation,
    );
    // Exp-6 item 2: user-turn directive leads the prompt (before the
    // world dump) so the writer treats the player's words as sacred.
    const userTurnPrefix =
      opts?.isUserTurn === true ? `${LLMConsequenceEngine.USER_TURN_DIRECTIVE}\n\n` : "";
    const userPrompt = `${userTurnPrefix}${context}\n\n${suffix}`;

    const result = await completeJson({
      logger: this.logger,
      provider: this.provider,
      module: "consequence",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      systemPrompt: LLM_SYSTEM_PROMPT,
      userPrompt,
      input: { action, feedback },
      maxRetries,
      schema: consequenceResultSchema,
      schemaText: RENDER_OUTPUT_SCHEMA,
      // F33: protected instruction tail — kept intact if the input cap
      // truncates the world-dump portion of the prompt.
      suffix,
      // F28: turn-deadline signal — aborts the hung provider call on timeout.
      signal: opts?.signal,
      repairHint:
        "Field rules: the render contract is prose-only — return ONLY " +
        '"narrative", "thoughts", "emotion", and "reasoning". Never emit ' +
        "actorPatches, objectPatches, effects, coordinates, or prop changes.",
    });
    if (!result.ok) {
      this.logger.log({
        module: "consequence",
        event: "consequence_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, feedback },
        prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
        rawResponse: result.lastRaw,
        // F31: usage from the last attempt, when the backend reported it.
        usage: result.usage,
        error: `fallback: ${result.error}`,
        durationMs: Date.now() - startedAt,
      });
      const fallback = structuredClone(FALLBACK_CONSEQUENCE);
      fallback.fallback = true;
      return fallback;
    }

    this.logger.log({
      module: "consequence",
      event: "consequence_completed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
      promptChars: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`.length,
      promptTokensEstimate: Math.ceil(`${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`.length / 4),
      rawResponse: result.raw,
      parsedResponse: result.value,
      reasoning: result.value.reasoning,
      // F31: per-call usage captured from the chat-completions response.
      usage: result.usage,
      output: result.value,
      durationMs: Date.now() - startedAt,
    });
    return result.value;
  }
}
