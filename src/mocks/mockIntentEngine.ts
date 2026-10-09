import type { IntentEngine } from "../intelligence/types.js";
import type { World } from "../types.js";
import { FALLBACK_INTENT, type IntentResult } from "../core/intent.js";
import { buildIntentPrompt } from "../llm/llmIntentEngine.js";
import type { Logger } from "../logging/logger.js";

/**
 * PLAN_V2 Phase 1: scripted intent results. Keys are the actor id (or
 * `${actorId}@tick${world.tick}`). The mock logs the real prompt like the
 * LLM module so tests assert on grounded content.
 */
export type MockIntentScript = Record<string, IntentResult>;

/**
 * Deterministic mock Intent Engine. Returns the scripted intent whose key
 * matches the actor (or the tick-qualified key), otherwise the
 * deterministic fallback. Logs prompt / raw / parsed response like the
 * real LLM module.
 */
export class MockIntentEngine implements IntentEngine {
  /**
   * Phase 6: mocks are local by default (not counted by the turn
   * budget). Tests simulating a provider-backed engine pass
   * `{ providerBacked: true }`.
   */
  readonly providerBacked: boolean;

  constructor(
    private readonly logger: Logger,
    private readonly script: MockIntentScript = {},
    opts: { providerBacked?: boolean } = {},
  ) {
    this.providerBacked = opts.providerBacked ?? false;
  }

  async intent(world: World, actorId: string): Promise<IntentResult> {
    const startedAt = Date.now();
    // PLAN_V2 Phase 1: like the real engine, the mock's prompt carries the
    // physical facts (positions, holding, reachability) + identity.
    const prompt = buildIntentPrompt(world, actorId);
    this.logger.log({
      module: "intent",
      event: "intent_started",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      input: { actorId },
      prompt,
    });

    try {
      const scripted =
        this.script[`${actorId}@tick${world.tick}`] ?? this.script[actorId];
      const result: IntentResult = scripted
        ? { action: scripted.action, quote: scripted.quote }
        : structuredClone(FALLBACK_INTENT);

      const rawResponse = JSON.stringify(result);
      this.logger.log({
        module: "intent",
        event: "intent_completed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        prompt,
        promptChars: prompt.length,
        promptTokensEstimate: Math.ceil(prompt.length / 4),
        rawResponse,
        parsedResponse: result,
        output: result,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      this.logger.log({
        module: "intent",
        event: "intent_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        prompt,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }
}
