// Real Selection (decision) Engine backed by an LLM (Milestone 2, §16.2).
//
// Chooses the actor's final action text from the candidate suggestions
// (or a better-fitting new action). Runs on the subjective actor context.
// This is the engine the locally installed Laya decision model
// (https://huggingface.co/convaiinnovations/laya) is intended for:
// point it at a LocalLayaProvider. Empty action text is treated as a
// failure (§16.4) and retried, then replaced by the §16.5 fallback.

import type { SelectionEngine } from "../intelligence/types.js";
import type { SelectionResult, World } from "../types.js";
import { selectionResultSchema } from "../schemas.js";
import { buildSelectionContext } from "../engine/contextBuilder.js";
import type { Logger } from "../logging/logger.js";
import type { LLMProvider } from "./provider.js";
import { LLM_SYSTEM_PROMPT, selectionSuffix } from "./prompts.js";
import { completeJson } from "./complete.js";

export const FALLBACK_SELECTION: SelectionResult = {
  action: "Stay where you are and observe the situation.",
  reasoning: "Fallback due to Selection Engine failure.",
};

export type LlmSelectionEngineOptions = {
  /** Parse-retry budget (§16.3). Defaults to 3 (matches default EngineConfig). */
  maxRetries?: number;
};

export class LLMSelectionEngine implements SelectionEngine {
  constructor(
    private readonly logger: Logger,
    private readonly provider: LLMProvider,
    private readonly options: LlmSelectionEngineOptions = {},
  ) {}

  async select(world: World, actorId: string, suggestions: string[]): Promise<SelectionResult> {
    const startedAt = Date.now();
    const maxRetries = this.options.maxRetries ?? 3;

    let userPrompt: string;
    try {
      userPrompt = `${buildSelectionContext(world, actorId, suggestions)}\n\n${selectionSuffix()}`;
    } catch (err) {
      this.logger.log({
        module: "selection",
        event: "selection_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        input: { actorId, suggestions },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
      return structuredClone(FALLBACK_SELECTION);
    }

    const result = await completeJson({
      logger: this.logger,
      provider: this.provider,
      module: "selection",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      systemPrompt: LLM_SYSTEM_PROMPT,
      userPrompt,
      input: { actorId, suggestions },
      maxRetries,
      schema: selectionResultSchema,
      extraCheck: (value) =>
        value.action.trim().length === 0 ? "empty action text" : undefined,
    });

    if (!result.ok) {
      this.logger.log({
        module: "selection",
        event: "selection_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        input: { actorId, suggestions },
        prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
        rawResponse: result.lastRaw,
        error: `fallback: ${result.error}`,
        durationMs: Date.now() - startedAt,
      });
      return structuredClone(FALLBACK_SELECTION);
    }

    this.logger.log({
      module: "selection",
      event: "selection_completed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
      rawResponse: result.raw,
      parsedResponse: result.value,
      reasoning: result.value.reasoning,
      output: result.value,
      durationMs: Date.now() - startedAt,
    });
    // Strip echoed candidate numbering ("3. Do X" -> "Do X").
    const cleaned = result.value.action.replace(/^\s*\d+\s*[.)]\s*/, "").trimStart();
    return { ...result.value, action: cleaned };
  }
}
