import type { ConsequenceEngine } from "../intelligence/types.js";
import type { Action, ConsequenceResult, World } from "../types.js";
import { buildConsequenceContext } from "../engine/contextBuilder.js";
import { mockClassifyAction } from "./mockSemanticJudge.js";
import type { Logger } from "../logging/logger.js";

export type MockConsequenceScript = Record<string, ConsequenceResult>;

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Deterministic mock Consequence Engine. Returns the scripted result whose
 * key matches the normalized action text (or `${actorId}::${text}`),
 * otherwise a generic acknowledgement patch for the acting actor.
 * Logs prompt / raw / parsed response like the real LLM module.
 */
export class MockConsequenceEngine implements ConsequenceEngine {
  constructor(
    private readonly logger: Logger,
    private readonly script: MockConsequenceScript = {},
  ) {}

  async resolve(world: World, action: Action, feedback?: string): Promise<ConsequenceResult> {
    const startedAt = Date.now();
    const prompt = buildConsequenceContext(world, action, feedback);
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
        ? structuredClone(scripted)
        : {
            narrative: `${actorName} acts: ${action.text}`,
            actorPatches: [
              {
                actorId: action.actorId,
                memoriesAppend: [`Did the following: ${action.text}`],
              },
            ],
            objectPatches: [],
            reasoning: `Mock consequence fallback for ${action.actorId}.`,
          };

      // Model the self-declared `effects` block the real consequence LLM
      // emits: synthesize it from the mock judge when the script omits it,
      // so mock runs exercise the effects-first validation path.
      if (!result.effects) {
        const semantics = mockClassifyAction(world, action);
        result.effects = {
          moved: semantics.moves,
          spoke: semantics.speaks,
          ...(semantics.quotedSpeech.length > 0 ? { quotedSpeech: semantics.quotedSpeech } : {}),
          ...(semantics.destinationActorId !== undefined
            ? { destinationActorId: semantics.destinationActorId }
            : {}),
        };
      }
      const rawResponse = JSON.stringify(result);
      this.logger.log({
        module: "consequence",
        event: "consequence_completed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        prompt,
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
