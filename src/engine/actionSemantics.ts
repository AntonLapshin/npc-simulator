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

/** Double- and single-quoted segments (content length >= 2). Format parsing, not a verb ontology. */
export function parseActionQuotes(text: string): string[] {
  const out: string[] = [];
  const doubleRe = /"([^"]{2,})"/g;
  let m: RegExpExecArray | null;
  while ((m = doubleRe.exec(text)) !== null) out.push(m[1]!);
  // Single quotes: avoid matching apostrophes inside words (don't, I'm).
  const singleRe = /(^|[\s(\[{])'([^']{4,})'/g;
  while ((m = singleRe.exec(text)) !== null) out.push(m[2]!);
  return out;
}

/** Content words (len >= 4) lowercased for overlap checks. */
function quoteContentWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
}

/** True when two words share a stem (first 4 letters equal). */
function quoteSameStem(a: string, b: string): boolean {
  return a.slice(0, 4) === b.slice(0, 4);
}

function normActionText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Exp-3 item 1: is a declared/judged quote grounded in the ACTION text?
 * A quote appearing in neither the action text nor its close paraphrase
 * ("Good to see you again, Jeff" for a desk question) is a hallucination
 * and must never become a validation requirement. Grounding holds when the
 * quote is a (normalized) substring of the action text, or when at least
 * half its content words share stems with the action text.
 */
export function isQuoteGroundedInAction(quote: string, actionText: string): boolean {
  const q = normActionText(quote);
  if (q.length === 0) return false;
  if (normActionText(actionText).includes(q)) return true;
  const words = quoteContentWords(quote);
  if (words.length === 0) return false;
  const actionWords = quoteContentWords(actionText);
  const kept = words.filter((w) => actionWords.some((aw) => quoteSameStem(w, aw)));
  return kept.length >= Math.ceil(words.length / 2);
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
   * or effects and judge conflicted on moves/speaks — logged as a
   * `judge_disagreement` event so the session disagreement rate is
   * computable from the JSONL trace.
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
 * ACTION text (no LLM). The judge runs on the same weak model as the
 * consequence engine and invents quotes ("Good to see you again, Jeff") and
 * destinations (tanya-as-destination for a desk walk) that merged-OR then
 * forces the validator to demand — circular grading. Ground truth for
 * quotes comes from parsing the action text itself; judge/effects quotes
 * survive only when grounded in it. Id fields survive only when they name
 * a roster actor / scene object. Returns the grounded semantics plus a
 * disagreement list (empty when everything agreed).
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

  // Quotes: action-text parse is ground truth; keep declared/judged quotes
  // only when grounded in the action text.
  const actionQuotes = parseActionQuotes(action.text);
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
  const destinationActorId = groundActorId("destinationActorId", merged.destinationActorId);
  const addresseeActorId = groundActorId("addresseeActorId", merged.addresseeActorId);
  const contactActorId = groundActorId("contactActorId", merged.contactActorId);
  let destinationObjectId = merged.destinationObjectId;
  if (destinationObjectId !== undefined && !objectIds.has(destinationObjectId)) {
    disagreements.push(`dropped unknown destinationObjectId "${destinationObjectId}" (not in scene)`);
    destinationObjectId = undefined;
  }

  // Requirement flags stay merged-OR, but record effects-vs-judge conflict.
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
  }

  return {
    semantics: {
      moves: merged.moves,
      speaks: merged.speaks,
      quotedSpeech: groundedQuotes,
      ...(destinationActorId !== undefined ? { destinationActorId } : {}),
      ...(destinationObjectId !== undefined ? { destinationObjectId } : {}),
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
  if (disagreements.length > 0) {
    logger?.log({
      module: "semantic",
      event: "judge_disagreement",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, fromEffects, fromJudge },
      output: { disagreements, groundedSemantics: semantics },
    });
  }
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
