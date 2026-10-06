// Real Proposal Engine backed by an LLM (Milestone 2, §16.2).
//
// Builds the subjective actor context (only what this actor perceives,
// remembers, believes, and knows), calls the provider, parses/validates
// the JSON, retries on parse failure, and falls back to §16.5
// suggestions so the simulation never deadlocks.

import type { ProposalEngine } from "../intelligence/types.js";
import type { ProposalResult, World } from "../types.js";
import { proposalResultSchema } from "../schemas.js";
import { buildProposalContext } from "../engine/contextBuilder.js";
import type { Logger } from "../logging/logger.js";
import type { LLMProvider } from "./provider.js";
import { LLM_SYSTEM_PROMPT, proposalSuffix } from "./prompts.js";
import { completeJson } from "./complete.js";

export const FALLBACK_PROPOSAL: ProposalResult = {
  suggestions: ["Stay where you are.", "Look around.", "Do nothing."],
  reasoning: "Fallback due to Proposal Engine failure.",
};

export type LlmProposalEngineOptions = {
  /** Parse-retry budget (§16.3). Defaults to 3 (matches default EngineConfig). */
  maxRetries?: number;
  /** Recent-history entries in the proposal prompt. Defaults to proposalHistoryLimit (20). */
  historyLimit?: number;
  /** Max suggestions requested. Defaults to maxProposalSuggestions (10). */
  maxSuggestions?: number;
};

export class LLMProposalEngine implements ProposalEngine {
  constructor(
    private readonly logger: Logger,
    private readonly provider: LLMProvider,
    private readonly options: LlmProposalEngineOptions = {},
  ) {}

  async propose(world: World, actorId: string): Promise<ProposalResult> {
    const startedAt = Date.now();
    const maxRetries = this.options.maxRetries ?? 3;

    let userPrompt: string;
    try {
      userPrompt = `${buildProposalContext(world, actorId, { historyLimit: this.options.historyLimit, maxSuggestions: this.options.maxSuggestions })}\n\n${proposalSuffix()}`;
    } catch (err) {
      this.logger.log({
        module: "proposal",
        event: "proposal_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        input: { actorId },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
      return structuredClone(FALLBACK_PROPOSAL);
    }

    const result = await completeJson({
      logger: this.logger,
      provider: this.provider,
      module: "proposal",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      systemPrompt: LLM_SYSTEM_PROMPT,
      userPrompt,
      input: { actorId },
      maxRetries,
      schema: proposalResultSchema,
    });

    if (!result.ok) {
      this.logger.log({
        module: "proposal",
        event: "proposal_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        input: { actorId },
        prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
        rawResponse: result.lastRaw,
        error: `fallback: ${result.error}`,
        durationMs: Date.now() - startedAt,
      });
      return structuredClone(FALLBACK_PROPOSAL);
    }

    const fullPrompt = `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`;
    this.logger.log({
      module: "proposal",
      event: "proposal_completed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      prompt: fullPrompt,
      promptChars: fullPrompt.length,
      promptTokensEstimate: Math.ceil(fullPrompt.length / 4),
      rawResponse: result.raw,
      parsedResponse: result.value,
      reasoning: result.value.reasoning,
      output: result.value,
      durationMs: Date.now() - startedAt,
    });
    return result.value;
  }
}
