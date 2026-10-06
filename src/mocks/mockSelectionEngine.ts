import type { SelectionEngine } from "../intelligence/types.js";
import type { SelectionResult, World } from "../types.js";
import { buildSelectionContext } from "../engine/contextBuilder.js";
import type { Logger } from "../logging/logger.js";

export type MockSelectionScript = Record<string, { action: string; reasoning: string }>;

/**
 * Deterministic mock Selection Engine: picks the scripted action for
 * `${actorId}@tick${tick}` / actorId, otherwise the first suggestion
 * (or a fallback sentence when no suggestions exist).
 */
export class MockSelectionEngine implements SelectionEngine {
  constructor(
    private readonly logger: Logger,
    private readonly script: MockSelectionScript = {},
  ) {}

  async select(
    world: World,
    actorId: string,
    suggestions: string[],
  ): Promise<SelectionResult> {
    const startedAt = Date.now();
    const prompt = buildSelectionContext(world, actorId, suggestions);
    this.logger.log({
      module: "selection",
      event: "selection_started",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      input: { actorId, suggestions },
      prompt,
    });

    try {
      const scripted =
        this.script[`${actorId}@tick${world.tick}`] ?? this.script[actorId];
      const result: SelectionResult = scripted
        ? { action: scripted.action, reasoning: scripted.reasoning }
        : suggestions.length > 0
          ? {
              action: suggestions[0]!,
              reasoning: `Mock selection for ${actorId}: chose the first suggestion.`,
            }
          : {
              action: "Stay where you are and observe the situation.",
              reasoning: "Mock selection fallback: no suggestions provided.",
            };

      const rawResponse = JSON.stringify(result);
      this.logger.log({
        module: "selection",
        event: "selection_completed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        prompt,
        promptChars: prompt.length,
        promptTokensEstimate: Math.ceil(prompt.length / 4),
        rawResponse,
        parsedResponse: result,
        reasoning: result.reasoning,
        output: result,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      this.logger.log({
        module: "selection",
        event: "selection_failed",
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
