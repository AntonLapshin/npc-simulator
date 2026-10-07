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
import {
  hasDisplacementToken,
  isActorMentioned,
  parseActionQuotes,
  resolveDeterministicSemantics,
} from "./deterministicSemantics.js";

export { parseActionQuotes };

export type SemanticsSource = "effects" | "judge" | "merged" | "fail-open";

function normActionText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Exp-3 item 1: is a declared/judged quote grounded in the ACTION text?
 * Ground truth comes from parsing the action text itself — a judge/effects
 * quote counts only when it is a (normalized) substring of the action
 * text. A quote appearing in neither ("Good to see you again, Jeff" for a
 * desk question) is a hallucination and must never become a validation
 * requirement. Paraphrases do NOT count here: how the narrative renders
 * speech is judged leniently downstream (validateSpeechPreservation), but
 * what counts as *said* is exact.
 */
export function isQuoteGroundedInAction(quote: string, actionText: string): boolean {
  const q = normActionText(quote);
  if (q.length === 0) return false;
  return normActionText(actionText).includes(q);
}

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
  /**
   * Exp-3 item 8c: per-turn judge-vs-effects disagreement notes. Non-empty
   * when quotes were dropped as ungrounded, non-roster ids were filtered,
   * judge-only ids failed deterministic resolution, or effects and judge
   * conflicted on moves/speaks — always logged as a
   * `judge_vs_effects_disagreement` event (even when empty) so the session
   * disagreement rate is computable from the JSONL trace.
   */
  disagreements?: string[];
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
 * Exp-3 items 1+8: deterministic grounding of merged semantics against the
 * ACTION text (no LLM). Role split: the deterministic judge owns quotes
 * and destinations (parsed from the action text + roster/landmark lookup);
 * the LLM/effects own only the moves/speaks/contact flags. The judge runs
 * on the same weak model as the consequence engine and invents quotes
 * ("Good to see you again, Jeff") and destinations (tanya-as-destination
 * for a desk walk, Jeff-as-destination for a coffee run) that merged-OR
 * then forces the validator to demand — circular grading.
 *
 * Grounding rules:
 * - Quotes: action-text parse is ground truth; declared/judged quotes
 *   survive only as substrings of the action text.
 * - Ids from `effects`: must name a roster actor / scene object. (The
 *   consequence describes what it did; the validator then verifies the
 *   patches match, so a valid id only strengthens checks.)
 * - Ids from the judge alone: must additionally match the deterministic
 *   resolution (movement-toward mention for destinations, any mention for
 *   addressees). A judge that can invent Jeff — or promote a "Thanks
 *   Tanya!" addressee to a destination — cannot ground such requirements.
 * - contactActorId stays LLM-owned: roster/object validity only.
 * - moves (Phase 2 / exp-3 item 3): requires a destination-or-displacement
 *   token in the action text (explicit displacement verb or proximity
 *   phrase). A `moves=true` verdict on "glance up" / "ask" / "sip" /
 *   "review" / "prepare" / "type" text is ungrounded — perception and
 *   cognition are never locomotion — so it is downgraded to false and any
 *   destination requirement goes with it (destinations are meaningless
 *   without movement). speaks/contact are untouched.
 *
 * Returns the grounded semantics plus a disagreement list (empty when
 * everything agreed).
 */
export function applyDeterministicGrounding(
  world: World,
  action: Action,
  merged: ActionSemantics | undefined,
  fromEffects: ActionSemantics | undefined,
  fromJudge: ActionSemantics | undefined,
): { semantics: ActionSemantics | undefined; disagreements: string[] } {
  const disagreements: string[] = [];
  if (!merged) return { semantics: undefined, disagreements };

  const rosterIds = new Set(world.actors.map((a) => a.id));
  const objectIds = new Set(world.scene.objects.map((o) => o.id));
  const det = resolveDeterministicSemantics(world, action);

  // Quotes: action-text parse is ground truth; keep declared/judged quotes
  // only when they are substrings of the action text.
  const actionQuotes = det.quotedSpeech;
  const groundedQuotes: string[] = [...actionQuotes];
  for (const q of merged.quotedSpeech) {
    if (groundedQuotes.includes(q)) continue;
    if (isQuoteGroundedInAction(q, action.text)) {
      groundedQuotes.push(q);
    } else {
      disagreements.push(`dropped ungrounded quote "${q.slice(0, 60)}" (not in action text)`);
    }
  }

  // Ids: must name someone/something that exists. A judge that can invent
  // Jeff cannot ground a Jeff check.
  const groundActorId = (
    label: string,
    value: string | undefined,
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (rosterIds.has(value)) return value;
    disagreements.push(`dropped unknown ${label} "${value}" (not on roster)`);
    return undefined;
  };
  const groundObjectId = (
    label: string,
    value: string | undefined,
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (objectIds.has(value)) return value;
    disagreements.push(`dropped unknown ${label} "${value}" (not in scene)`);
    return undefined;
  };

  // Judge-only ids must match the deterministic resolution: the judge may
  // not promote unmentioned actors (or mere addressees) to destinations.
  // Effects-corroborated ids skip this check — effects describes what the
  // consequence did, and the validator verifies the patches match.
  const groundJudgeActorDestination = (
    value: string | undefined,
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (!rosterIds.has(value)) {
      disagreements.push(`dropped unknown destinationActorId "${value}" (not on roster)`);
      return undefined;
    }
    if (fromEffects?.destinationActorId === value) return value; // corroborated
    if (det.destinationActorId === value) return value;
    disagreements.push(
      `dropped judge destinationActorId "${value}" (not named as a movement target in the action text)`,
    );
    return undefined;
  };
  const groundJudgeObjectDestination = (
    value: string | undefined,
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (!objectIds.has(value)) {
      disagreements.push(`dropped unknown destinationObjectId "${value}" (not in scene)`);
      return undefined;
    }
    if (fromEffects?.destinationObjectId === value) return value; // corroborated
    if (det.destinationObjectId === value) return value;
    disagreements.push(
      `dropped judge destinationObjectId "${value}" (not named as a movement target in the action text)`,
    );
    return undefined;
  };
  const groundJudgeAddressee = (
    value: string | undefined,
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (!rosterIds.has(value)) {
      disagreements.push(`dropped unknown addresseeActorId "${value}" (not on roster)`);
      return undefined;
    }
    if (fromEffects?.addresseeActorId === value) return value; // corroborated
    if (det.addresseeActorId === value) return value;
    if (merged.speaks && isActorMentioned(world, action.text, value)) return value;
    disagreements.push(
      `dropped judge addresseeActorId "${value}" (not addressed in the action text)`,
    );
    return undefined;
  };

  const useJudgeDestination =
    fromEffects?.destinationActorId === undefined && fromJudge?.destinationActorId !== undefined;
  const useJudgeObjectDestination =
    fromEffects?.destinationObjectId === undefined && fromJudge?.destinationObjectId !== undefined;
  const useJudgeAddressee =
    fromEffects?.addresseeActorId === undefined && fromJudge?.addresseeActorId !== undefined;

  const destinationActorId = useJudgeDestination
    ? groundJudgeActorDestination(merged.destinationActorId)
    : groundActorId("destinationActorId", merged.destinationActorId);
  const destinationObjectId = useJudgeObjectDestination
    ? groundJudgeObjectDestination(merged.destinationObjectId)
    : groundObjectId("destinationObjectId", merged.destinationObjectId);
  const addresseeActorId = useJudgeAddressee
    ? groundJudgeAddressee(merged.addresseeActorId)
    : groundActorId("addresseeActorId", merged.addresseeActorId);
  // Contact stays LLM-owned (moves/speaks/contact role): roster validity only.
  const contactActorId = groundActorId("contactActorId", merged.contactActorId);

  // Requirement flags stay merged-OR, but record effects-vs-judge conflict.
  // Phase 2: `moves` additionally requires a destination-or-displacement
  // token in the action text itself — merged-OR cannot conjure locomotion
  // out of a glance.
  let moves = merged.moves;
  let moveDestinationsDropped = false;
  if (moves && !hasDisplacementToken(action.text)) {
    moves = false;
    moveDestinationsDropped =
      merged.destinationActorId !== undefined || merged.destinationObjectId !== undefined;
    disagreements.push(
      "dropped moves=true (no displacement verb or destination token in the action text; perception/cognition is never locomotion)" +
        (moveDestinationsDropped ? " — destination requirement(s) dropped with it" : ""),
    );
  }
  if (fromEffects && fromJudge) {
    if (fromEffects.moves !== fromJudge.moves) {
      disagreements.push(
        `moves conflict: effects=${fromEffects.moves} judge=${fromJudge.moves} (kept OR)`,
      );
    }
    if (fromEffects.speaks !== fromJudge.speaks) {
      disagreements.push(
        `speaks conflict: effects=${fromEffects.speaks} judge=${fromJudge.speaks} (kept OR)`,
      );
    }
    if (
      fromEffects.destinationActorId !== undefined &&
      fromJudge.destinationActorId !== undefined &&
      fromEffects.destinationActorId !== fromJudge.destinationActorId
    ) {
      disagreements.push(
        `destination conflict: effects=${fromEffects.destinationActorId} judge=${fromJudge.destinationActorId} (kept effects)`,
      );
    }
  }

  return {
    semantics: {
      moves,
      speaks: merged.speaks,
      quotedSpeech: groundedQuotes,
      ...(destinationActorId !== undefined && moves ? { destinationActorId } : {}),
      ...(destinationObjectId !== undefined && moves ? { destinationObjectId } : {}),
      ...(addresseeActorId !== undefined ? { addresseeActorId } : {}),
      ...(contactActorId !== undefined ? { contactActorId } : {}),
    },
    disagreements,
  };
}

/**
 * Resolve the meaning of an action: the consequence's `effects`
 * declaration is checked against an independent classification of the
 * ACTION text and merged (OR for requirement flags), so a consequence
 * cannot talk its way out of movement/speech/addressee gates by declaring
 * moved=false/spoke=false — then deterministically grounded against the
 * action text itself (exp-3 items 1+8), so neither side can invent quotes
 * or ids the validator then enforces. The judge runs on every turn with
 * effects — one compact classification call — because deterministic gates
 * on every turn (user turns included) matter more than saving that call.
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
  const { semantics: mergedSemantics, source } = mergeSemantics(fromEffects, fromJudge);
  const { semantics, disagreements } = applyDeterministicGrounding(
    world,
    action,
    mergedSemantics,
    fromEffects,
    fromJudge,
  );
  // Phase 1 / Exp-3 item 8c: one disagreement event per resolution (every
  // turn), even when empty — the session disagreement rate (non-empty /
  // total) is then directly computable from the JSONL trace instead of
  // failing open silently.
  logger?.log({
    module: "semantic",
    event: "judge_vs_effects_disagreement",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    input: { action, fromEffects, fromJudge },
    output: {
      disagreements,
      agreement: disagreements.length === 0,
      source,
      groundedSemantics: semantics,
    },
  });
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
    return { semantics, source, disagreements };
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
  return { semantics: undefined, source: "fail-open", disagreements };
}
