// Semantic resolution policy (refactor plan §B–C).
//
// Effects-first: the consequence LLM declares what the action did in
// `effects` alongside the narrative — the validator checks patches
// against that declaration deterministically, with NO extra LLM call.
// The independent SemanticJudge is only consulted when `effects` is
// absent (or for dispute spot-checks by the caller). When the judge is
// unavailable or fails, validation fails OPEN to physics-only checks:
// geometry, schema, and turn structure still guard coherence.

import type { Action, ActionSemantics, ConsequenceResult, World } from "../types.js";
import type { SemanticJudge } from "../intelligence/types.js";
import type { Logger } from "../logging/logger.js";

export type SemanticsSource = "effects" | "judge" | "fail-open";

/** Deterministic projection of a self-declared `effects` block to ActionSemantics. */
export function effectsToSemantics(result: ConsequenceResult): ActionSemantics | undefined {
  const fx = result.effects;
  if (!fx) return undefined;
  return {
    moves: fx.moved,
    ...(fx.destinationActorId !== undefined ? { destinationActorId: fx.destinationActorId } : {}),
    ...(fx.destinationObjectId !== undefined ? { destinationObjectId: fx.destinationObjectId } : {}),
    speaks: fx.spoke,
    quotedSpeech: fx.quotedSpeech ?? [],
    ...(fx.addresseeActorId !== undefined ? { addresseeActorId: fx.addresseeActorId } : {}),
    ...(fx.contactActorId !== undefined ? { contactActorId: fx.contactActorId } : {}),
  };
}

export type ResolvedSemantics = {
  /** Undefined means "unknown" — the caller must skip semantic gates (fail-open). */
  semantics: ActionSemantics | undefined;
  source: SemanticsSource;
};

/**
 * Resolve the meaning of an action: prefer the consequence's `effects`
 * declaration; otherwise ask the judge; otherwise fail open.
 * Never throws — judge failures resolve to fail-open with a log event.
 */
export async function resolveActionSemantics(
  world: World,
  action: Action,
  result: ConsequenceResult | undefined,
  judge: SemanticJudge | undefined,
  logger?: Logger,
): Promise<ResolvedSemantics> {
  if (result) {
    const fromEffects = effectsToSemantics(result);
    if (fromEffects) {
      logger?.log({
        module: "semantic",
        event: "semantic_resolved",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action },
        output: { source: "effects" as const, semantics: fromEffects },
      });
      return { semantics: fromEffects, source: "effects" };
    }
  }
  if (judge) {
    try {
      const semantics = await judge.classify(world, action);
      return { semantics, source: "judge" };
    } catch (err) {
      logger?.log({
        module: "semantic",
        event: "semantic_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action },
        error: `fail-open to physics-only: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { semantics: undefined, source: "fail-open" };
    }
  }
  logger?.log({
    module: "semantic",
    event: "semantic_skipped",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    input: { action },
    error: "no effects declaration and no judge — fail-open to physics-only",
  });
  return { semantics: undefined, source: "fail-open" };
}
