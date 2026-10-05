import type { ProposalEngine } from "../intelligence/types.js";
import type { ProposalResult, World } from "../types.js";
import { buildProposalContext } from "../engine/contextBuilder.js";
import { getVisibleActors, getVisibleObjects, getActorById } from "../engine/perceptionHelpers.js";
import type { Logger } from "../logging/logger.js";

export type MockProposalScript = Record<string, { suggestions: string[]; reasoning: string }>;

/**
 * Deterministic mock Proposal Engine. Suggestions derive from actor id,
 * tick, nearby actors/objects unless a scripted entry matches
 * `${actorId}@tick${tick}` or the bare actorId.
 * Logs the same structure as real LLM modules (prompt, raw/parsed response).
 */
export class MockProposalEngine implements ProposalEngine {
  constructor(
    private readonly logger: Logger,
    private readonly script: MockProposalScript = {},
  ) {}

  async propose(world: World, actorId: string): Promise<ProposalResult> {
    const startedAt = Date.now();
    const prompt = buildProposalContext(world, actorId);
    this.logger.log({
      module: "proposal",
      event: "proposal_started",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      input: { actorId },
      prompt,
    });

    try {
      const actor = getActorById(world, actorId);
      if (!actor) throw new Error(`unknown actor: ${actorId}`);

      const scripted =
        this.script[`${actorId}@tick${world.tick}`] ?? this.script[actorId];
      let result: ProposalResult;
      if (scripted) {
        result = { suggestions: [...scripted.suggestions], reasoning: scripted.reasoning };
      } else {
        const nearby = getVisibleActors(world, actorId);
        const objects = getVisibleObjects(world, actorId);
        const suggestions = [
          `Stay where you are and observe the situation.`,
          nearby.length > 0
            ? `Walk toward ${nearby[0]!.name} and greet them.`
            : `Look around the room.`,
          objects.length > 0
            ? `Interact with ${objects[0]!.name}.`
            : `Wait and do nothing.`,
          `Continue pursuing your goal: ${actor.goal}`,
        ];
        result = {
          suggestions,
          reasoning: `Mock proposal for ${actorId} at tick ${world.tick} with ${nearby.length} visible actors and ${objects.length} visible objects.`,
        };
      }

      const rawResponse = JSON.stringify(result);
      this.logger.log({
        module: "proposal",
        event: "proposal_completed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
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
        module: "proposal",
        event: "proposal_failed",
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
