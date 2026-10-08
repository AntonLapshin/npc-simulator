// Salvage tiers for the turn loop (extracted from turnOrchestrator.ts).
//
// When a consequence fails validation, these functions decide whether part
// of the turn can still advance instead of falling back to "Nothing
// changes.": deterministic movement repair, addressee-reaction repair,
// speech-nit downgrading (tier 1), degraded wording salvage (tier 2), and
// the "valid-JSON-at-all-costs" format-collapse tier. Pure logic except for
// the honest-history note bookkeeping (see getHonestHistoryNote).

import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  EngineConfig,
  ValidationError,
  World,
} from "../types.js";
import { defaultConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { FALLBACK_CONSEQUENCE } from "../llm/llmConsequenceEngine.js";
import { validateConsequence } from "./physicalValidator.js";
import {
  findUnknownPersonNames,
  validateIdentityConsistency,
  validateNarrativeActors,
  validateObserverSubject,
} from "./validate/narrative.js";
import { OBJECT_INTERACT_RADIUS } from "./validate/objects.js";
import {
  clampMoveToCap,
  isClampableMovementFailure,
  stepTowardPoint,
  suggestMoveTarget,
} from "./movementAssist.js";
import {
  narrativeApproachTarget,
  narrativeTargetPosition,
  vetoAwayFromNarrativeTarget,
  type NamedDestination,
} from "./textHints.js";
import { getAudibleActors, getVisibleActors } from "./perceptionHelpers.js";
import {
  hasSpeechToken,
  parseActionQuotes,
  resolveDeterministicSemantics,
} from "./deterministicSemantics.js";
import { normLower, quotedSegments } from "./validate/speech.js";
import { tryCloseTruncatedJson } from "../llm/json.js";
import {
  findSupplementObserverSubject,
  isSpeechOnlyFailure,
  isTier2Salvageable,
  recheckAcceptedProse,
  stripAttributionPrefix,
} from "./turnSalvageGates.js";

// Re-exported so the retry loop (turnOrchestrator.ts) keeps a single
// import path for the salvage-side helpers. The error-severity taxonomy
// and the S2 accept-gate helpers live in turnSalvageGates.ts (moved there
// when this file passed ~800 lines).
export {
  buildRetryDirective,
  countHardErrors,
  isSpeechOnlyFailure,
  isTier2Salvageable,
  pickBestAttempt,
  recheckAcceptedProse,
  stripAttributionPrefix,
} from "./turnSalvageGates.js";
export type { AttemptRecord } from "./turnSalvageGates.js";

/**
 * Exp-4 item 6 / F23: did this turn fall back? The explicit `fallback`
 * flag is checked first; the structural check (canonical fallback
 * narrative with no patches) remains as backward compat for results built
 * before the flag existed — so the history entry can be marked as
 * un-applied ("tried … (not done)") instead of asserted as fact.
 */
export function isFallbackConsequence(result: ConsequenceResult): boolean {
  if (result.fallback === true) return true;
  if (result.fallback === false) return false;
  return (
    result.narrative === FALLBACK_CONSEQUENCE.narrative &&
    result.actorPatches.length === 0 &&
    result.objectPatches.length === 0
  );
}

/**
 * Exp-5 item 2: honest-history notes for salvaged/liveness turns. The
 * consequence dropped content (or the liveness floor replaced it), so the
 * world history must record the NARRATIVE (what happened) plus this note —
 * never the raw action text (the wish). Stored off-object (WeakMap) so the
 * validated payload shape is untouched; runTurn reads it via
 * getHonestHistoryNote() and forwards it to applyConsequence.
 */
const honestHistoryNotes = new WeakMap<ConsequenceResult, string>();

export function getHonestHistoryNote(result: ConsequenceResult): string | undefined {
  return honestHistoryNotes.get(result);
}

function withHonestNote(out: { salvaged: ConsequenceResult; warnings: ValidationError[] }): {
  salvaged: ConsequenceResult;
  warnings: ValidationError[];
} {
  honestHistoryNotes.set(
    out.salvaged,
    out.warnings.length > 0
      ? `partial: ${out.warnings.map((w) => `[${w.code}] ${w.message}`).join(" | ").slice(0, 240)}`
      : "partial",
  );
  return out;
}
/**
 * Deterministic movement repair for the salvage path (Phase 4): fill in (or
 * fix) the acting actor's x/y with a computed reachable position, mirroring
 * the retry-loop repair. Returns a repaired clone, or null when no valid
 * suggestion exists. Never touches prose — the caller revalidates and only
 * accepts the repair when the movement gate (and everything except
 * speech-rendering nits) passes.
 */
function applySalvageMovementRepair(
  world: World,
  action: Action,
  candidate: ConsequenceResult,
  semantics: ActionSemantics,
): ConsequenceResult | null {
  if (!semantics.moves) return null;
  // Exp-4 item 1: prefer the model's own claimed direction clamped to the
  // cap (a 13-cell jump becomes a 6-cell step the same way) over a fresh
  // suggestion; fall back to the destination-directed suggestion when the
  // candidate claims no usable position.
  const claimed = candidate.actorPatches.find((p) => p.actorId === action.actorId);
  // Item C7 (S1): the action text steers the suggestion — "walk east" and
  // "walk toward Ana" must not repair westward when no destination was
  // declared.
  let suggestion =
    claimed?.x !== undefined && claimed?.y !== undefined
      ? (clampMoveToCap(world, action.actorId, claimed.x, claimed.y) ??
        suggestMoveTarget(
          world,
          action.actorId,
          semantics.destinationActorId,
          semantics.destinationObjectId,
          action.text,
        ))
      : suggestMoveTarget(
          world,
          action.actorId,
          semantics.destinationActorId,
          semantics.destinationObjectId,
          action.text,
        );
  // Exp-3 item 7 (S5, A3): veto a repair that steps AWAY from the
  // narrative's named approach target — a wrong-direction repair is worse
  // than no repair (the turn falls through to fallback instead).
  //
  // Exp-4 item 5 (S2): re-steer instead of giving up — a capped step
  // TOWARD the narrative's named target keeps the salvage honest AND
  // moving. Null only when no legal toward-step exists.
  let resteeredTarget: NamedDestination | null = null;
  if (suggestion) {
    const vetted = vetoAwayFromNarrativeTarget(
      world,
      action.actorId,
      candidate.narrative,
      suggestion,
    );
    if (!vetted) {
      const tp = narrativeTargetPosition(
        world,
        action.actorId,
        candidate.narrative,
      );
      const resteered =
        tp !== null ? stepTowardPoint(world, action.actorId, tp.x, tp.y) : null;
      if (!resteered) return null;
      resteeredTarget = narrativeApproachTarget(
        world,
        action.actorId,
        candidate.narrative,
      );
      suggestion = resteered;
    } else {
      suggestion = vetted;
    }
  }
  if (!suggestion) return null;
  const repaired: ConsequenceResult = structuredClone(candidate);
  const existing = repaired.actorPatches.find((p) => p.actorId === action.actorId);
  if (existing) {
    existing.x = suggestion.x;
    existing.y = suggestion.y;
  } else {
    repaired.actorPatches.push({
      actorId: action.actorId,
      x: suggestion.x,
      y: suggestion.y,
    });
  }
  if (repaired.effects) {
    repaired.effects.moved = true;
    // Exp-4 item 5 (S2): a re-steered repair declares the narrative's
    // target, matching what the prose claims.
    const effDestActorId =
      resteeredTarget?.kind === "actor"
        ? resteeredTarget.id
        : semantics.destinationActorId;
    const effDestObjectId =
      resteeredTarget?.kind === "object"
        ? resteeredTarget.id
        : semantics.destinationObjectId;
    if (effDestActorId !== undefined) {
      repaired.effects.destinationActorId = effDestActorId;
    }
    if (effDestObjectId !== undefined) {
      repaired.effects.destinationObjectId = effDestObjectId;
    }
  }
  return repaired;
}

/**
 * F25: shared perceiver check — does `perceiverId` perceive the acting
 * actor's event (see/hear/adjacent)? Mirrors the validator's perceiver
 * rule so no patch is owed when the event was unperceivable. Used by
 * repairMissingAddressee and the format-collapse addressee stub.
 */
export function perceivesEvent(
  world: World,
  perceiverId: string,
  actingActorId: string,
  cfg: EngineConfig = defaultConfig,
): boolean {
  const target = world.actors.find((a) => a.id === perceiverId);
  const actor = world.actors.find((a) => a.id === actingActorId);
  if (!target || !actor) return false;
  return (
    getVisibleActors(world, perceiverId, cfg).some((a) => a.id === actingActorId) ||
    getAudibleActors(world, perceiverId, cfg).some((a) => a.id === actingActorId) ||
    Math.abs(target.x - actor.x) + Math.abs(target.y - actor.y) <= 2
  );
}

/**
 * Exp-5 item 1: deterministic addressee repair for the salvage path. When
 * the action speaks directly TO someone (addressee semantics) but the
 * consequence left no patch on them, add a minimal stub thoughts reaction
 * instead of failing the whole turn — being spoken to always registers.
 * Returns a repaired clone, or null when no repair applies (no addressee,
 * already patched, unknown id, or the addressee could not perceive the
 * event — mirroring the validator's perceiver rule, so no patch is owed).
 * Never invents speech content: the stub records only that something was
 * heard, and the dropped wording stays logged as a warning.
 */
function repairMissingAddressee(
  world: World,
  action: Action,
  candidate: ConsequenceResult,
  semantics: ActionSemantics,
  cfg: EngineConfig = defaultConfig,
): ConsequenceResult | null {
  const addressee = semantics.addresseeActorId;
  if (addressee === undefined || addressee === action.actorId) return null;
  if (candidate.actorPatches.some((p) => p.actorId === addressee)) return null;
  if (!perceivesEvent(world, addressee, action.actorId, cfg)) return null;
  const actor = world.actors.find((a) => a.id === action.actorId);
  const repaired: ConsequenceResult = structuredClone(candidate);
  repaired.actorPatches.push({
    actorId: addressee,
    thoughts: `Heard ${actor?.name ?? action.actorId} — will pick this up next turn.`,
  });
  return repaired;
}

/**
 * Exp-3 item 6 / Phase 4: partial-apply / salvage instead of all-or-nothing fallback.
 * Ticks 3/9 showed whole good turns (valid movement + adjacency) discarded
 * for a speech nit plus a stray hallucinated patch — and 57% "Nothing
 * changes." is what actually stalls a scenario. Salvage strips patches that
 * reference nonexistent actors/objects (clear hallucinations like a `jeff`
 * patch), deterministically repairs a missing/invalid movement patch when
 * the turn implies locomotion, deterministically patches a missing
 * direct-addressee reaction, and:
 * - returns the salvaged result when fully valid, or
 * - returns it with the remaining speech misses downgraded to warnings
 *   (movement + thoughts apply; the speech miss is logged, not fatal), or
 * - (Exp-5 item 1, tier 2) returns clampable movement + thoughts with
 *   speech/object wording misses downgraded to warnings.
 * Physics, movement direction/progress, contact adjacency, observer
 * discipline, and unknown-actor prose still fall back — salvage never
 * invents speech and only accepts positions that pass the full movement
 * gate on revalidation.
 */
export type SalvageEvaluation = {
  eligible: boolean;
  reason: string;
  /** Non-speech blockers when ineligible (empty when eligible or unknown). */
  blockers: ValidationError[];
};

/**
 * Item C5 (S2): action-derived fallback narrative. When salvage strips
 * hallucinated prose (unknown actors / observer-as-subject), the visible
 * narrative is rebuilt from the action text — the ground truth of what
 * the actor did — instead of keeping the model's invented prose. Quoted
 * speech is preserved verbatim (it IS the action); otherwise the
 * name-prefixed action text is used (the prefix keeps the placeholder
 * gate from reading it as an action echo, and the history entry reads
 * "Ana: Ana: walks…" — redundant but honest). Never invents names. Pure.
 */
export function synthesizeActionNarrative(action: Action, name: string): string {
  const quotes = parseActionQuotes(action.text);
  if (quotes.length > 0) {
    return `${name} says ${quotes.map((q) => `"${q}"`).join(" ")}`;
  }
  const t = action.text.trim().replace(/\s+/g, " ");
  const clipped = t.length > 260 ? `${t.slice(0, 257)}…` : t;
  return `${name}: ${clipped}`;
}

/**
 * Item C5 (S2): drop/replace thoughts that name non-roster actors. The
 * tick-10 salvage implanted "Another day, same Liam." — a false memory
 * of a nonexistent person — as a thought. A thought mentioning anyone
 * outside the roster is replaced with a neutral line; clean thoughts pass
 * through untouched. Pure.
 *
 * Exp-2 item 7: `strippedActorIds` additionally names actors whose patches
 * were just stripped as hallucinations (ids, matched case-insensitively as
 * whole words) plus unknown person names harvested from the original
 * narrative — thoughts naming them are false memories of actors that do
 * not exist and must never survive salvage, even when the narrative prose
 * itself passed the gates.
 */
export function sanitizeThoughts(
  thoughts: string | undefined,
  world: World,
  strippedActorIds: readonly string[] = [],
): string | undefined {
  if (thoughts === undefined) return undefined;
  if (findUnknownPersonNames(world, thoughts).length > 0) {
    return "Staying focused on what's in front of me.";
  }
  for (const id of strippedActorIds) {
    if (id.length < 2) continue;
    if (new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(thoughts)) {
      return "Staying focused on what's in front of me.";
    }
  }
  return thoughts;
}

/** True when an object within interact radius matches the prop noun. */
function propObjectNearby(world: World, actorId: string, nounRe: RegExp): boolean {
  const actor = world.actors.find((a) => a.id === actorId);
  if (!actor) return false;
  return world.scene.objects.some((o) => {
    if (!nounRe.test(o.id) && !nounRe.test(o.name)) return false;
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;
    return Math.hypot(actor.x - cx, actor.y - cy) <= OBJECT_INTERACT_RADIUS + 1e-9;
  });
}

/**
 * Items C4/C11 (S6): deterministic prop stubs for the salvage path. Small
 * models narrate object use ("types on her laptop", "grabs the mug") but
 * never emit the prop patch, and the turn then spirals into retries.
 * When the ACTION text carries typing verbs or grab/take/hold + cup/mug,
 * stub the matching prop on the acting actor — but only when a matching
 * object is within OBJECT_INTERACT_RADIUS (4) cells (the arch-fixes
 * proximity rule): never invent a laptop out of thin air. Never overrides
 * an existing prop patch or an already-held prop. Returns a repaired
 * clone, or null when no stub applies.
 */
function repairMissingPropStub(
  world: World,
  action: Action,
  candidate: ConsequenceResult,
): ConsequenceResult | null {
  const existing = candidate.actorPatches.find((p) => p.actorId === action.actorId);
  if (existing?.prop !== undefined) return null;
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!actor || (actor.prop ?? null) !== null) return null;
  const text = action.text;
  const wantsLaptop = /\btyp(e|es|ing|ed)\b/i.test(text);
  const cupNoun = /\b(cup|mug)s?\b/i;
  const grabVerb = /\b(grab|grabs|grabbing|take|takes|taking|took|hold|holds|holding|pick\s+up|picks?\s+up)\b/i;
  const wantsCup = grabVerb.test(text) && cupNoun.test(text);
  let stub: "laptop" | "cup" | null = null;
  if (wantsLaptop && propObjectNearby(world, action.actorId, /laptop/i)) {
    stub = "laptop";
  } else if (wantsCup && propObjectNearby(world, action.actorId, /mug|cup/i)) {
    stub = "cup";
  }
  if (stub === null) return null;
  const repaired: ConsequenceResult = structuredClone(candidate);
  const target = repaired.actorPatches.find((p) => p.actorId === action.actorId);
  if (target) {
    target.prop = stub;
  } else {
    repaired.actorPatches.push({ actorId: action.actorId, prop: stub });
  }
  return repaired;
}

/**
 * Exp-3 item 3 (S4/M4): deterministic quote reinsertion. The 8B drops long
 * quotes on every attempt (tick 19: Tanya's test-plan offer died 3× on
 * speech.dropped_words — the echo-gate exemption can't help when the model
 * never renders the quote at all). The engine knows the exact words —
 * they are in the action text — so when the ONLY failures are
 * speech-rendering nits and the narrative dropped the action's quotes, the
 * missing quotes are reinserted deterministically: appended as a
 * `<Name> says "<quote>"` sentence when the model's frame is otherwise
 * clean (preserving its movement description), or replacing the narrative
 * outright when the frame itself contains invented dialogue (the rewrite
 * then contains only action-grounded quotes). The model's valid patches
 * are kept. Accepted only when the full gate suite AND the final accept
 * gate pass on the rewritten payload. No LLM call. Pure except for the
 * audit log.
 */
function repairDroppedQuotes(
  world: World,
  action: Action,
  candidate: ConsequenceResult,
  semantics: ActionSemantics,
  cfg: EngineConfig,
  logger?: Logger,
): ConsequenceResult | null {
  const quotes = parseActionQuotes(action.text);
  if (quotes.length === 0) return null;
  const frameQuotes = quotedSegments(candidate.narrative);
  const grounded = (q: string): boolean =>
    quotes.some((aq) => {
      const a = normLower(aq);
      const b = normLower(q);
      return a === b || a.includes(b) || b.includes(a);
    });
  // Nothing to fix when the frame already renders every action quote and
  // invents none.
  const missing = quotes.filter((aq) => !frameQuotes.some((fq) => {
    const a = normLower(aq);
    const b = normLower(fq);
    return a === b || a.includes(b) || b.includes(a);
  }));
  if (missing.length === 0 && frameQuotes.every(grounded)) return null;
  const actor = world.actors.find((a) => a.id === action.actorId);
  const name = actor?.name ?? action.actorId;
  const frame = candidate.narrative.trim();
  const narrative =
    frameQuotes.every(grounded) && frame.length > 0
      ? `${frame} ${name} says ${missing.map((q) => `"${q}"`).join(" ")}`
      : `${name} says ${quotes.map((q) => `"${q}"`).join(" ")}`;
  const repaired: ConsequenceResult = {
    ...structuredClone(candidate),
    narrative,
  };
  // effects.quotedSpeech must match the rendered quotes, or the speech
  // gates fail the repair on revalidation.
  if (repaired.effects) {
    repaired.effects.spoke = true;
    repaired.effects.quotedSpeech = quotes;
  }
  const revalidation = validateConsequence(world, repaired, action, semantics, cfg);
  if (!revalidation.valid) return null;
  if (recheckAcceptedProse(world, action, repaired).length > 0) return null;
  logger?.log({
    module: "turn",
    event: "salvage_quote_reinserted",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    input: { action, quotes, missing },
    output: { narrative: repaired.narrative },
  });
  return repaired;
}

export function trySalvageConsequence(
  world: World,
  action: Action,
  result: ConsequenceResult,
  semantics: ActionSemantics | undefined,
  logger?: Logger,
  cfg: EngineConfig = defaultConfig,
): { salvaged: ConsequenceResult; warnings: ValidationError[] } | null {
  const evaluate = (eligible: boolean, reason: string, blockers: ValidationError[] = []): null => {
    // Exp-4 item 8: every salvage entry evaluation is logged (eligible /
    // ineligible + reason) so the session trace shows WHY salvage never
    // fires — not just that it didn't.
    logger?.log({
      module: "turn",
      event: "salvage_evaluated",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action },
      output: { eligible, reason, blockers } satisfies SalvageEvaluation as unknown as Record<
        string,
        unknown
      >,
    });
    return null;
  };
  if (!semantics) return evaluate(false, "no semantics (fail-open): nothing to salvage against");
  const actorIds = new Set(world.actors.map((a) => a.id));
  const objectIds = new Set(world.scene.objects.map((o) => o.id));
  const strippedActor = result.actorPatches.filter((p) => !actorIds.has(p.actorId));
  const strippedObject = result.objectPatches.filter((p) => !objectIds.has(p.objectId));
  let candidate: ConsequenceResult;
  if (strippedActor.length === 0 && strippedObject.length === 0) {
    candidate = result;
  } else {
    candidate = {
      ...structuredClone(result),
      actorPatches: result.actorPatches.filter((p) => actorIds.has(p.actorId)),
      objectPatches: result.objectPatches.filter((p) => objectIds.has(p.objectId)),
    };
  }
  // Exp-2 item 7 (S1/S7): names that must never leak into salvaged
  // thoughts — stripped (hallucinated) actor ids plus unknown person names
  // harvested from the original narrative ("Liam" in "Liam greets…").
  // Applied to every remaining patch below, whether or not the prose
  // itself failed the gates.
  const strippedActorNames = new Set<string>();
  for (const p of strippedActor) strippedActorNames.add(p.actorId);
  for (const n of findUnknownPersonNames(world, result.narrative)) strippedActorNames.add(n);
  const strippedNameList = [...strippedActorNames];
  if (strippedNameList.length > 0) {
    candidate = {
      ...candidate,
      actorPatches: candidate.actorPatches.map((p) => ({
        ...p,
        thoughts: sanitizeThoughts(p.thoughts, world, strippedNameList),
      })),
    };
  }
  // Item C5 (S2): re-run the prose gates on the stripped candidate —
  // patch-stripping must not launder hallucinated prose into canonical
  // history (tick 10 "Liam greets everyone", tick 12 "John takes a drink
  // from his glass of whiskey", tick 15 "Anton leans against the desk").
  // When the prose fails, rebuild it from the action text (ground truth)
  // and sanitize every thoughts patch — never implant thoughts naming
  // stripped actors (the tick-10 "Another day, same Liam." false memory).
  //
  // Exp-2 item 5: the observer gates run on the attribution-stripped
  // narrative — a leading "Ana: " prefix hid the true grammatical subject
  // ("Jeff introduces…") from the clause-leading-name match — plus the
  // verb-agnostic supplement, which catches the "introduces" verb the
  // validator's list misses.
  const actorName = world.actors.find((a) => a.id === action.actorId)?.name ?? action.actorId;
  const proseNarrative = stripAttributionPrefix(candidate.narrative, actorName, action.actorId);
  const proseErrors = [
    ...validateNarrativeActors(world, {
      narrative: candidate.narrative,
      reasoning: candidate.reasoning,
    }),
    ...validateObserverSubject(world, { narrative: proseNarrative }, action),
    ...findSupplementObserverSubject(world, proseNarrative, action),
    // Exp-3 item 5 (S3): identity-theft prose ("I'm Dana, the new hire"
    // on Dana's turn) must trigger the same rebuild-from-action-text as
    // the other prose gates — otherwise the turn dies at the accept()
    // gate below and falls back to "Nothing changes." instead of
    // advancing honestly.
    ...validateIdentityConsistency(world, proseNarrative, action),
  ];
  if (proseErrors.length > 0) {
    const actor = world.actors.find((a) => a.id === action.actorId);
    const cleanNarrative = synthesizeActionNarrative(action, actor?.name ?? action.actorId);
    const recheck = [
      ...validateNarrativeActors(world, { narrative: cleanNarrative }),
      ...validateObserverSubject(world, { narrative: cleanNarrative }, action),
    ];
    if (recheck.length > 0) {
      return evaluate(
        false,
        `salvaged prose fails the unknown-actor/observer-subject gates and action-derived synthesis still fails them (${recheck.map((e) => e.code).join(", ")}): no honest prose available`,
        recheck,
      );
    }
    logger?.log({
      module: "turn",
      event: "salvage_prose_synthesized",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: {
        action,
        proseErrors: proseErrors.map((e) => `[${e.code}] ${e.message}`),
      },
      output: { narrative: cleanNarrative },
    });
    candidate = {
      ...structuredClone(candidate),
      narrative: cleanNarrative,
      actorPatches: candidate.actorPatches.map((p) => ({
        ...p,
        thoughts: sanitizeThoughts(p.thoughts, world, strippedNameList),
      })),
    };
  }
  // Salvage preserves real effects: the acting actor must remain patched —
  // otherwise the turn's only content was hallucinated (e.g. a lone `ghost`
  // patch) and an emptied husk is no better than the fallback. The one
  // exception is a locomotion turn whose movement can be deterministically
  // repaired below (same repair the retry loop applies).
  //
  // F3: the addressee repair runs BEFORE this early return. It exists
  // precisely for speech-only turns whose consequence left the addressee
  // unpatched (which validateAddresseePatch rejects) — the old order made
  // that repair unreachable for non-movement turns.
  const withEarlyAddressee = repairMissingAddressee(world, action, candidate, semantics, cfg);
  if (withEarlyAddressee) candidate = withEarlyAddressee;
  if (
    !candidate.actorPatches.some((p) => p.actorId === action.actorId) &&
    !semantics.moves
  ) {
    return evaluate(false, "acting actor unpatched and no locomotion implied: only hallucinated patches");
  }
  const accept = (
    c: ConsequenceResult,
  ): { salvaged: ConsequenceResult; warnings: ValidationError[] } | null => {
    const revalidation = validateConsequence(world, c, action, semantics, cfg);
    if (revalidation.valid || isSpeechOnlyFailure(revalidation.errors)) {
      // Exp-2 item 5 (S2): final accept gate — the tick-10/11 narratives
      // passed the full suite outright, so the accepted narrative gets one
      // more prose re-check before it may become canonical history.
      const gateErrors = recheckAcceptedProse(world, action, c);
      if (gateErrors.length > 0) {
        logger?.log({
          module: "turn",
          event: "salvage_accept_gate_rejected",
          tick: world.tick,
          turnIndex: world.turnIndex,
          actorId: action.actorId,
          input: { action, candidate: c },
          output: { errors: gateErrors.map((e) => `[${e.code}] ${e.message}`) },
        });
        return null;
      }
      if (revalidation.valid) return { salvaged: c, warnings: [] };
      // Exp-3 item 3 (S4/M4): before downgrading dropped quotes to
      // warnings, reinsert them deterministically — the exact words are in
      // the action text, and the 8B demonstrably cannot copy long quotes
      // (tick 19 died 3× on speech.dropped_words). The repair is marked
      // with a synthetic warning so history stays honest about the engine
      // intervention (the turn is valid, not model-clean).
      const quoteRepaired = repairDroppedQuotes(world, action, c, semantics, cfg, logger);
      if (quoteRepaired) {
        evaluate(true, "dropped quotes reinserted deterministically (speech nits repaired, not downgraded)");
        return {
          salvaged: quoteRepaired,
          warnings: [
            {
              code: "salvage.quote_reinserted",
              message:
                "narrative dropped the action's quoted speech; the exact quotes were reinserted deterministically from the action text",
            },
          ],
        };
      }
      return { salvaged: c, warnings: revalidation.errors };
    }
    return null;
  };
  const stripped = accept(candidate);
  if (stripped) {
    evaluate(true, "valid patches kept (speech nits downgraded to warnings)");
    return withHonestNote(stripped);
  }
  // Phase 4 "(or movement-repair them)": the turn implies locomotion but the
  // position is missing or invalid — fill it deterministically (Exp-4 item
  // 1: claimed over-cap jumps clamp to a partial step, not just fresh
  // suggestions) and accept only if the full gate (or speech-only) passes
  // on revalidation.
  // Exp-5 item 1: tier-2 fallback below widens the accept to speech/object
  // wording misses, so a repaired movement is no longer discarded for a
  // dropped quote or a missing pour patch.
  let movementBase: ConsequenceResult | null = null;
  if (semantics.moves) {
    const repaired = applySalvageMovementRepair(world, action, candidate, semantics);
    if (repaired) {
      movementBase = repaired;
      const repairedOut = accept(repaired);
      if (repairedOut) {
        evaluate(true, "movement repaired (clamped/suggested) with valid patches kept");
        return withHonestNote(repairedOut);
      }
    } else {
      return evaluate(false, "locomotion implied but no valid capped step exists (surroundings blocked)");
    }
  }
  // Exp-5 item 1, tier 2 (degraded-but-advancing): repair the missing
  // addressee reaction deterministically, then accept clampable movement +
  // thoughts even when speech/object wording misses remain — logged as
  // warnings, not fatal. Physics, direction/progress, contact adjacency,
  // and observer discipline stay hard.
  const tierBase = movementBase ?? candidate;
  const withAddressee = repairMissingAddressee(world, action, tierBase, semantics, cfg);
  const propBase = withAddressee ?? tierBase;
  // Items C4/C11 (S6): deterministic prop stubs (typing→prop:laptop,
  // grab+cup/mug→prop:cup) — repair the object-wording miss instead of
  // merely downgrading it to a warning.
  const withProp = repairMissingPropStub(world, action, propBase);
  const tiered = withProp ?? propBase;
  const revalidation = validateConsequence(world, tiered, action, semantics, cfg);
  // Exp-2 item 5 (S2): same final accept gate as accept() above — the
  // tier-2 downgrade must not launder a corrupt narrative either.
  const tierGateErrors = recheckAcceptedProse(world, action, tiered);
  if (tierGateErrors.length > 0) {
    logger?.log({
      module: "turn",
      event: "salvage_accept_gate_rejected",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, candidate: tiered },
      output: { errors: tierGateErrors.map((e) => `[${e.code}] ${e.message}`) },
    });
  } else if (revalidation.valid || isSpeechOnlyFailure(revalidation.errors)) {
    evaluate(
      true,
      withProp !== null
        ? "movement kept + prop stub patched (speech nits downgraded to warnings)"
        : withAddressee !== null
          ? "movement kept + addressee reaction patched (speech nits downgraded to warnings)"
          : "valid patches kept (speech nits downgraded to warnings)",
    );
    return withHonestNote({
      salvaged: tiered,
      warnings: revalidation.valid ? [] : revalidation.errors,
    });
  }
  if (tierGateErrors.length === 0 && isTier2Salvageable(revalidation.errors)) {
    evaluate(
      true,
      "tier-2 degraded: clampable movement + thoughts kept, speech/object wording logged as warnings",
    );
    return withHonestNote({ salvaged: tiered, warnings: revalidation.errors });
  }
  if (semantics.moves) {
    return evaluate(
      false,
      "movement repaired but hard gates still fail (physics/direction/contact/observer-discipline stay hard; tier-2 covers speech/object wording only)",
      revalidation.errors,
    );
  }
  return evaluate(
    false,
    isClampableMovementFailure(revalidation.errors)
      ? "clampable movement present but repair produced no valid step"
      : "hard gates fail (physics/contact/addressee/observer/object — tier-2 covers speech/object wording only)",
    revalidation.errors,
  );
}
/** Strip fences/control noise from a donor string extracted from a collapsed output. */
export function cleanDonorString(s: string): string {
  return s
    .replace(/```json|```/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/**
 * Exp-6 item 4: pull a "narrative"/"thoughts" string out of an unparseable
 * LLM output. Tries (1) closing truncated JSON (max_tokens cutoffs) and
 * reading the field leniently — including the acting actor's patch
 * thoughts — then (2) regex-extracting the quoted string value.
 */
export function extractDonorString(
  raw: string,
  key: "narrative" | "thoughts",
  actorId?: string,
): string | undefined {
  const start = raw.indexOf("{");
  if (start !== -1) {
    const closed = tryCloseTruncatedJson(raw.slice(start));
    if (closed !== undefined) {
      try {
        const parsed = JSON.parse(closed) as Record<string, unknown>;
        const v = parsed[key];
        if (typeof v === "string" && v.trim().length > 0) return cleanDonorString(v);
        if (key === "thoughts" && Array.isArray(parsed.actorPatches)) {
          for (const p of parsed.actorPatches) {
            if (
              p !== null &&
              typeof p === "object" &&
              (actorId === undefined ||
                (p as { actorId?: unknown }).actorId === actorId) &&
              typeof (p as { thoughts?: unknown }).thoughts === "string" &&
              ((p as { thoughts: string }).thoughts.trim().length > 0)
            ) {
              return cleanDonorString((p as { thoughts: string }).thoughts);
            }
          }
        }
      } catch {
        // Fall through to the regex path.
      }
    }
  }
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "s"));
  if (m?.[1] !== undefined) {
    try {
      const v = JSON.parse(`"${m[1]}"`) as unknown;
      if (typeof v === "string" && v.trim().length > 0) return cleanDonorString(v);
    } catch {
      // Not a decodable string — ignore.
    }
  }
  return undefined;
}

/**
 * Exp-6 item 4: action-grounded fallback narrative. The action text is the
 * ground truth of what the actor did — quoting it (or its quoted speech
 * verbatim) invents nothing, unlike reusing a collapsed "Let me analyze
 * this…" preamble as visible prose.
 */
export function synthesizeSalvageNarrative(action: Action, name: string): string {
  const quotes = parseActionQuotes(action.text);
  if (quotes.length > 0) {
    return `${name} says ${quotes.map((q) => `"${q}"`).join(" ")}`;
  }
  const t = action.text.trim().replace(/\s+/g, " ");
  return t.length > 280 ? `${t.slice(0, 277)}…` : t;
}

/**
 * Exp-6 item 4: "valid-JSON-at-all-costs" salvage tier. When every
 * consequence attempt failed to PARSE (format collapse — not a content
 * violation), build a degraded narrative/thoughts-only payload instead of
 * "Nothing changes.". Donor prose is only ever used for `thoughts`
 * (private, never narrated); the visible narrative is always
 * action-derived, so turn discipline cannot be violated by a collapsed
 * preamble. An addressee stub mirrors the liveness floor (being spoken to
 * registers). Applied like liveness — bypassing full validation — with an
 * honest-history note. Returns null when nothing usable can be built.
 */
export function salvageFormatCollapse(
  world: World,
  action: Action,
  rawAttempts: string[],
  cfg: EngineConfig = defaultConfig,
): ConsequenceResult | null {
  if (rawAttempts.length === 0) return null;
  const actor = world.actors.find((a) => a.id === action.actorId);
  const name = actor?.name ?? action.actorId;
  // Longest raw first: the most complete emission is the best donor.
  const ordered = [...rawAttempts].sort((a, b) => b.length - a.length);
  let thoughts: string | undefined;
  for (const raw of ordered) {
    thoughts = extractDonorString(raw, "thoughts", action.actorId);
    if (thoughts) break;
  }
  // Exp-2 item 7: donor thoughts come from unvalidated model output — never
  // implant a false memory of a nonexistent actor as a thought.
  if (thoughts) thoughts = sanitizeThoughts(thoughts, world);
  const narrative = synthesizeSalvageNarrative(action, name);
  if (narrative.trim().length === 0) return null;
  const actorPatches: ConsequenceResult["actorPatches"] = [];
  if (thoughts) actorPatches.push({ actorId: action.actorId, thoughts });
  const addressee = resolveDeterministicSemantics(world, action).addresseeActorId;
  // F25: the addressee stub passes the same perceiver check as
  // repairMissingAddressee — no patch is owed when the addressee could not
  // perceive the event.
  if (
    addressee !== undefined &&
    addressee !== action.actorId &&
    world.actors.some((a) => a.id === addressee) &&
    perceivesEvent(world, addressee, action.actorId, cfg)
  ) {
    actorPatches.push({
      actorId: addressee,
      thoughts: `Heard ${name} — will pick this up next turn.`,
    });
  }
  const salvaged: ConsequenceResult = {
    narrative,
    actorPatches,
    objectPatches: [],
    reasoning:
      "format-collapse salvage: consequence output never parsed as JSON; degraded payload built from the action text and partial model output.",
    effects: {
      moved: false,
      spoke: hasSpeechToken(action.text),
      quotedSpeech: parseActionQuotes(action.text),
    },
  };
  honestHistoryNotes.set(salvaged, "format-collapse salvage");
  return salvaged;
}

/** Attach an honest-history note to a consequence result (used by the liveness floor). */
export function setHonestHistoryNote(result: ConsequenceResult, note: string): void {
  honestHistoryNotes.set(result, note);
}
