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

export type SemanticsSource = "effects" | "judge" | "merged" | "fail-open";

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
 * Merge a consequence self-declaration with an independent classification
 * of the ACTION text (exp-2 item 4). Requirement flags (moves/speaks) use OR
 * — a consequence that declares moved=false for a "walk toward Dana" action
 * must not dodge the movement gate. Quoted speech is unioned. Resolved ids
 * prefer the declaration, falling back to the judge. Without both inputs
 * this degrades to whichever is available, then fail-open.
 */
export function mergeSemantics(
  fromEffects: ActionSemantics | undefined,
  fromJudge: ActionSemantics | undefined,
): { semantics: ActionSemantics | undefined; source: SemanticsSource } {
  if (fromEffects && !fromJudge) return { semantics: fromEffects, source: "effects" };
  if (fromJudge && !fromEffects) return { semantics: fromJudge, source: "judge" };
  if (!fromEffects || !fromJudge) return { semantics: undefined, source: "fail-open" };
  const quoted = [...fromEffects.quotedSpeech];
  for (const q of fromJudge.quotedSpeech) {
    if (!quoted.includes(q)) quoted.push(q);
  }
  const merged: ActionSemantics = {
    moves: fromEffects.moves || fromJudge.moves,
    speaks: fromEffects.speaks || fromJudge.speaks,
    quotedSpeech: quoted,
    ...(fromEffects.destinationActorId ?? fromJudge.destinationActorId !== undefined
      ? { destinationActorId: (fromEffects.destinationActorId ?? fromJudge.destinationActorId)! }
      : {}),
    ...(fromEffects.destinationObjectId ?? fromJudge.destinationObjectId !== undefined
      ? { destinationObjectId: (fromEffects.destinationObjectId ?? fromJudge.destinationObjectId)! }
      : {}),
    ...(fromEffects.addresseeActorId ?? fromJudge.addresseeActorId !== undefined
      ? { addresseeActorId: (fromEffects.addresseeActorId ?? fromJudge.addresseeActorId)! }
      : {}),
    ...(fromEffects.contactActorId ?? fromJudge.contactActorId !== undefined
      ? { contactActorId: (fromEffects.contactActorId ?? fromJudge.contactActorId)! }
      : {}),
  };
  const widened =
    merged.moves !== fromEffects.moves ||
    merged.speaks !== fromEffects.speaks ||
    merged.quotedSpeech.length !== fromEffects.quotedSpeech.length;
  return { semantics: merged, source: widened ? "merged" : "effects" };
}

/**
 * Resolve the meaning of an action: the consequence's `effects`
 * declaration is checked against an independent classification of the
 * ACTION text and merged (OR for requirement flags), so a consequence
 * cannot talk its way out of movement/speech/addressee gates by declaring
 * moved=false/spoke=false. The judge runs on every turn with effects —
 * one compact classification call — because deterministic gates on every
 * turn (user turns included) matter more than saving that call.
 * Judge failure degrades to effects-only; with neither, fail-open to
 * physics-only validation.
 */
export async function resolveActionSemantics(
  world: World,
  action: Action,
  result: ConsequenceResult | undefined,
  judge: SemanticJudge | undefined,
  logger?: Logger,
): Promise<ResolvedSemantics> {
  const fromEffects = result ? effectsToSemantics(result) : undefined;
  let fromJudge: ActionSemantics | undefined;
  if (judge) {
    try {
      fromJudge = await judge.classify(world, action);
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
    }
  }
  const { semantics, source } = mergeSemantics(fromEffects, fromJudge);
  if (semantics) {
    logger?.log({
      module: "semantic",
      event: "semantic_resolved",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action },
      output: { source, semantics },
    });
    return { semantics, source };
  }
  if (!judge && !fromEffects) {
    logger?.log({
      module: "semantic",
      event: "semantic_skipped",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action },
      error: "no effects declaration and no judge — fail-open to physics-only",
    });
  }
  return { semantics: undefined, source: "fail-open" };
}
