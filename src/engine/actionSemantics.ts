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
  hasSpeechToken,
  isActorMentioned,
  normalizeQuotes,
  parseActionQuotes,
  resolveDeterministicSemantics,
} from "./deterministicSemantics.js";

export { parseActionQuotes };

export type SemanticsSource = "effects" | "judge" | "merged" | "fail-open";

function normActionText(s: string): string {
  // Exp-6 item 2: canonicalize curly quotes before comparing, so a
  // straight-apostrophe narrative quote still grounds against a
  // curly-apostrophe action text (and vice versa).
  return normalizeQuotes(s).toLowerCase().replace(/\s+/g, " ").trim();
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
  const hay = normActionText(actionText);
  const idx = hay.indexOf(q);
  if (idx === -1) return false;
  // Exp-4 item 4 (tick 5: "Why don" for "Why don't we..."): a substring
  // that ends mid-word is a truncation, not ground truth. Both ends of
  // the match must sit on a word boundary (string edge, whitespace, or
  // punctuation) — otherwise the "corrupted quote becomes ground truth
  // the speech gate must demand".
  const isWordChar = (c: string): boolean => /[a-z0-9']/i.test(c);
  const before = idx > 0 ? hay[idx - 1]! : "";
  const after = idx + q.length < hay.length ? hay[idx + q.length]! : "";
  // Leading partial word ("don" matching inside "abandon") is also corrupt.
  if (before !== "" && isWordChar(before) && q.length > 0 && isWordChar(q[0]!)) return false;
  if (after !== "" && isWordChar(after) && q.length > 0 && isWordChar(q[q.length - 1]!)) {
    return false;
  }
  return true;
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
 * - moves (Phase 2 / exp-3 item 3, F1): the deterministic token check may
 *   ASSERT movement but never downgrade a true merged verdict to false:
 *   `moves = tokenMoves || merged.moves`. An action with a displacement
 *   token moves even when both sides declare false (no verb-drop dodge),
 *   and a merged moves=true verdict stands even without a recognized
 *   token (the fixed verb ontology is not the whole language — an
 *   unrecognized real verb keeps the merged verdict, status quo). Same
 *   for `speaks` via the speech-token check (Exp-4 item 3): unquoted
 *   explaining/telling/nodding verbs force speaks=true so hollow look-ups
 *   cannot pass. Disagreements between token evidence and the merged
 *   verdict are still logged.
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
  // Exp-4 item 4: a merged quote that is a strict truncation of a parsed
  // action quote ("Why don" vs "Why don't we take a 10-minute break…")
  // is corruption, not ground truth — drop it even though it is technically
  // a substring (isQuoteGroundedInAction already rejects mid-word ends,
  // this catches whole-word prefixes like "Why" for "Why don't we...").
  const actionQuotes = det.quotedSpeech;
  const groundedQuotes: string[] = [...actionQuotes];
  for (const q of merged.quotedSpeech) {
    if (groundedQuotes.includes(q)) continue;
    const truncatedOf = actionQuotes.find(
      (a) => a.length > q.length && normActionText(a).includes(normActionText(q)),
    );
    if (truncatedOf !== undefined) {
      disagreements.push(
        `dropped truncated quote "${q.slice(0, 60)}" (prefix of action-text quote "${truncatedOf.slice(0, 60)}")`,
      );
      continue;
    }
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

  // Exp-4 item 7 (as amended by F1): the deterministic token check and the
  // LLM union combine with OR. An action with a displacement token moves
  // even when both sides declare false (no verb-drop dodge); a merged
  // moves=true verdict stands even without a recognized token (the fixed
  // verb ontology is not the whole language). Same for `speaks` via the
  // speech-token check (Exp-4 item 3): unquoted explaining/telling/nodding
  // verbs force speaks=true so hollow look-ups cannot pass.
  // Destination conflicts: Exp-6 item 1 flipped the Exp-4 tick-10 rule for
  // OBJECT destinations — a model-declared id that exists in the scene
  // outranks the fuzzy keyword fallback (ownership heuristic / proximity
  // tiebreak), which misranked on Exp-6 tick 7. The grounded resolution
  // still wins when the action text names the target explicitly in a
  // movement clause (the consequence contradicting the literal text is
  // the hallucination — Exp-4 tick 10 stays covered). Actor destinations
  // are always explicit mentions, so grounded still wins those conflicts.
  // Computed below after the id grounding.
  const tokenMoves = hasDisplacementToken(action.text);
  const tokenSpeaks = hasSpeechToken(action.text);
  // F1: token evidence ASSERTS movement but never downgrades a true merged
  // verdict to false. `moves = tokenMoves || merged.moves`.
  const moves = tokenMoves || merged.moves;
  const speaks = merged.speaks || tokenSpeaks;
  if (merged.moves && !tokenMoves) {
    // No longer dropped (F1) — but the token/merged disagreement is still
    // logged so the session disagreement rate stays computable.
    disagreements.push(
      "moves=true kept from the merged verdict despite no displacement token in the action text (token evidence asserts movement but never downgrades it)",
    );
  } else if (merged.moves !== moves) {
    disagreements.push(
      `moves deterministic override: merged=${merged.moves} token=${tokenMoves} (kept OR)`,
    );
  }
  if (merged.speaks !== speaks) {
    disagreements.push(
      `speaks deterministic override: merged=${merged.speaks} speech-token=${tokenSpeaks} (kept OR-with-token)`,
    );
  }
  if (fromEffects && fromJudge) {
    if (fromEffects.moves !== fromJudge.moves) {
      disagreements.push(
        `moves conflict: effects=${fromEffects.moves} judge=${fromJudge.moves} (kept deterministic token=${tokenMoves})`,
      );
    }
    if (fromEffects.speaks !== fromJudge.speaks) {
      disagreements.push(
        `speaks conflict: effects=${fromEffects.speaks} judge=${fromJudge.speaks} (kept OR-with-token=${speaks})`,
      );
    }
  }

  // Exp-6 item 1: model-declared existing ids outrank the deterministic
  // keyword-first-match. The consequence read the full objective world;
  // the resolver's generic fallback is a guess (ownership heuristic,
  // proximity tiebreak) that misranks — tick 7: "his desk" scoped to the
  // acting actor instead of the named Anton, laundering a wrong-desk pass
  // through the repair path. The resolver stays the fallback for
  // undeclared targets (via the judge path below). Safeguard: when the
  // action text EXPLICITLY names the grounded target in a movement clause
  // ("Head to Anton's desk"), the consequence contradicting the literal
  // text is the hallucination — grounded wins, as in Exp-4 tick 10.
  let finalDestinationActorId = destinationActorId;
  let finalDestinationObjectId = destinationObjectId;
  if (
    det.destinationActorId !== undefined &&
    finalDestinationActorId !== undefined &&
    det.destinationActorId !== finalDestinationActorId
  ) {
    disagreements.push(
      `destination conflict: effects=${finalDestinationActorId} grounded=${det.destinationActorId} (kept grounded)`,
    );
    finalDestinationActorId = det.destinationActorId;
  } else if (
    fromEffects?.destinationActorId !== undefined &&
    fromJudge?.destinationActorId !== undefined &&
    fromEffects.destinationActorId !== fromJudge.destinationActorId &&
    det.destinationActorId === undefined
  ) {
    disagreements.push(
      `destination conflict: effects=${fromEffects.destinationActorId} judge=${fromJudge.destinationActorId} (kept effects)`,
    );
  }
  if (
    det.destinationObjectId !== undefined &&
    finalDestinationObjectId !== undefined &&
    det.destinationObjectId !== finalDestinationObjectId
  ) {
    const effectsDeclaredExisting =
      fromEffects?.destinationObjectId === finalDestinationObjectId;
    if (effectsDeclaredExisting && det.destinationObjectExplicit !== true) {
      disagreements.push(
        `destination conflict: effects=${finalDestinationObjectId} grounded=${det.destinationObjectId} (kept effects — grounded came from the fuzzy keyword fallback)`,
      );
      // keep finalDestinationObjectId (the model-declared id)
    } else {
      disagreements.push(
        `destination conflict: effects=${finalDestinationObjectId} grounded=${det.destinationObjectId} (kept grounded)`,
      );
      finalDestinationObjectId = det.destinationObjectId;
    }
  }

  return {
    semantics: {
      moves,
      speaks,
      quotedSpeech: groundedQuotes,
      ...(finalDestinationActorId !== undefined && moves ? { destinationActorId: finalDestinationActorId } : {}),
      ...(finalDestinationObjectId !== undefined && moves ? { destinationObjectId: finalDestinationObjectId } : {}),
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
 * or ids the validator then enforces.
 *
 * Q2 (lazy semantic judge): the judge is only consulted when the
 * consequence provides no `effects` (pass `judge` as undefined otherwise) —
 * classification exists to ground the semantic gates, and `effects` alone
 * already grounds them. Judge failure degrades to effects-only; with
 * neither, fail-open to physics-only validation.
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
