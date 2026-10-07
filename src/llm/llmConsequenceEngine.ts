// Real Consequence Engine backed by an LLM (Milestone 2, §16.2).
//
// Interprets free-form action text against the FULL objective world and
// returns narrative + actor/object patches. The optional `feedback`
// carries validation errors from a previous attempt (§16.5 / turn
// orchestrator retry loop) and is embedded in the context, so the model
// can correct unknown ids or impossible movement. Parse failures retry
// internally; physically invalid output is retried by the orchestrator;
// total failure yields the §16.5 "Nothing changes." fallback.

import type { ConsequenceEngine } from "../intelligence/types.js";
import type { Action, ConsequenceResult, World } from "../types.js";
import { consequenceResultSchema } from "../schemas.js";
import { buildConsequenceContext } from "../engine/contextBuilder.js";
import type { Logger } from "../logging/logger.js";
import type { LLMProvider } from "./provider.js";
import { LLM_SYSTEM_PROMPT, consequenceSuffix } from "./prompts.js";
import { completeJson } from "./complete.js";

export const FALLBACK_CONSEQUENCE: ConsequenceResult = {
  narrative: "Nothing changes.",
  actorPatches: [],
  objectPatches: [],
  reasoning: "Fallback due to Consequence Engine failure.",
};

export type LlmConsequenceEngineOptions = {
  /** Parse-retry budget (§16.3). Defaults to 3 (matches default EngineConfig). */
  maxRetries?: number;
};

export class LLMConsequenceEngine implements ConsequenceEngine {
  constructor(
    private readonly logger: Logger,
    private readonly provider: LLMProvider,
    private readonly options: LlmConsequenceEngineOptions = {},
  ) {}

  async resolve(world: World, action: Action, feedback?: string): Promise<ConsequenceResult> {
    const startedAt = Date.now();
    const maxRetries = this.options.maxRetries ?? 3;
    // Exp-3 item 12: first attempts get the short core prompt (identity +
    // roster + movement + speech + turn discipline + minimal field rules);
    // retries get the full rule text plus validation feedback, where the
    // rarely-firing rules (arrival radius, mask lists) actually help.
    const userPrompt = `${buildConsequenceContext(world, action, feedback)}\n\n${consequenceSuffix(feedback ? "full" : "short")}`;

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
      repairHint:
        "Field rules: actorPatches must be an array of {\"actorId\": ...} (never \"id\", never a quoted string); " +
        "objectPatches must be an array of {\"objectId\": ...} (never \"id\", never a quoted string); " +
        "\"reasoning\" is required; do not nest objectPatches inside actorPatches.",
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
        error: `fallback: ${result.error}`,
        durationMs: Date.now() - startedAt,
      });
      return structuredClone(FALLBACK_CONSEQUENCE);
    }

    this.logger.log({
      module: "consequence",
      event: "consequence_completed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
      rawResponse: result.raw,
      parsedResponse: result.value,
      reasoning: result.value.reasoning,
      output: result.value,
      durationMs: Date.now() - startedAt,
    });
    return result.value;
  }
}
