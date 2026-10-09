import type { ConsequenceEngine, ConsequenceResolveOpts } from "../intelligence/types.js";
import type { Action, ConsequenceResult, World } from "../types.js";
import { buildConsequenceContext } from "../engine/contextBuilder.js";
import type { Logger } from "../logging/logger.js";

/**
 * Phase 4: scripted render results (prose only). Keys are the normalized
 * action text (or `${actorId}::${text}`).
 */
export type MockConsequenceScript = Record<string, Pick<ConsequenceResult, "narrative" | "thoughts" | "emotion" | "reasoning">>;

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Deterministic mock Consequence (render) Engine. Returns the scripted
 * prose whose key matches the normalized action text (or
 * `${actorId}::${text}`), otherwise a generic acknowledgement. Logs
 * prompt / raw / parsed response like the real LLM module.
 */
export class MockConsequenceEngine implements ConsequenceEngine {
  /**
   * Phase 6: mocks are local by default (not counted by the turn
   * budget). Tests simulating a provider-backed engine pass
   * `{ providerBacked: true }`.
   */
  readonly providerBacked: boolean;

  constructor(
    private readonly logger: Logger,
    private readonly script: MockConsequenceScript = {},
    opts: { providerBacked?: boolean } = {},
  ) {
    this.providerBacked = opts.providerBacked ?? false;
  }

  async resolve(
    world: World,
    action: Action,
    feedback?: string,
    opts?: ConsequenceResolveOpts,
  ): Promise<ConsequenceResult> {
    const startedAt = Date.now();
    // Phase 1: like the real engine, the mock's context carries the
    // already-executed movement as facts to narrate.
    // Phase 2: like the real engine, the mock's context carries the
    // engine-dictated exact quote as the verbatim contract.
    // Phase 3: like the real engine, the mock's context carries the
    // already-executed manipulation as facts to narrate.
    const prompt = buildConsequenceContext(
      world,
      action,
      feedback,
      undefined,
      opts?.engineMovement,
      opts?.exactQuote,
      opts?.engineManipulation,
    );
    this.logger.log({
      module: "consequence",
      event: "consequence_started",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, feedback },
      prompt,
    });

    try {
      const key = normalize(action.text);
      const scopedKey = `${action.actorId}::${key}`;
      const scripted = this.script[scopedKey] ?? this.script[key];

      const actor = world.actors.find((a) => a.id === action.actorId);
      const actorName = actor?.name ?? action.actorId;
      const result: ConsequenceResult = scripted
        ? { ...structuredClone(scripted) }
        : {
            narrative: `${actorName} acts: ${action.text}`,
            thoughts: "Doing what needs doing.",
            reasoning: `Mock consequence fallback for ${action.actorId}.`,
          };

      const rawResponse = JSON.stringify(result);
      this.logger.log({
        module: "consequence",
        event: "consequence_completed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
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
        module: "consequence",
        event: "consequence_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        prompt,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }
}
