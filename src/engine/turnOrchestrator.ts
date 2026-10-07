import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  EngineConfig,
  World,
} from "../types.js";
import { defaultConfig } from "../config.js";
import type {
  ConsequenceEngine,
  ProposalEngine,
  SelectionEngine,
  SemanticJudge,
} from "../intelligence/types.js";
import { applyConsequence } from "./patchApplier.js";
import { validateConsequence } from "./physicalValidator.js";
import { resolveActionSemantics } from "./actionSemantics.js";
import {
  clampMoveToCap,
  isClampableMovementFailure,
  isMovementOnlyFailure,
  suggestMoveTarget,
} from "./movementAssist.js";
import { validateSelectionForActor } from "./contextBuilder.js";
import { getAudibleActors, getVisibleActors } from "./perceptionHelpers.js";
import { FALLBACK_SELECTION } from "../llm/llmSelectionEngine.js";
import { MockSemanticJudge } from "../mocks/mockSemanticJudge.js";
import { advanceTurn, getCurrentActor, incrementTick } from "./worldStore.js";
import { defaultSavePath, saveWorld } from "./persistence.js";
import type { Logger } from "../logging/logger.js";

export type TurnProgressStage =
  | "turn_started"
  | "proposal_started"
  | "proposal_done"
  | "waiting_user_input"
  | "selection_started"
  | "selection_done"
  | "consequence_started"
  | "consequence_retry"
  | "validation_started"
  | "validation_done"
  | "patch_applied"
  | "turn_completed";

export type TurnProgressEvent = {
  stage: TurnProgressStage;
  actorId: string;
  /** Human-readable one-liner for loading indicators (e.g. "consequence engine…"). */
  message: string;
};

export type EngineDependencies = {
  proposalEngine: ProposalEngine;
  selectionEngine: SelectionEngine;
  consequenceEngine: ConsequenceEngine;
  logger: Logger;
  config?: EngineConfig;
  /**
   * Decision-AI judge for free-form action meaning. Consumed only when a
   * consequence omits its self-declared `effects`; defaults to the
   * offline MockSemanticJudge (zero network calls). Real runs may inject
   * LLMSemanticJudge. Judge failure fails open to physics-only validation.
   */
  semanticJudge?: SemanticJudge;
  /** Resolve free-form user action text (UI layer). Required for user turns. */
  getUserAction?: (actorId: string, suggestions: string[]) => Promise<string>;
  /** Optional save hook (defaults to file persistence when autosave is on). */
  onAutosave?: (world: World) => Promise<void> | void;
  /** Optional progress hook for UIs to show a loading indicator during slow LLM calls. */
  onProgress?: (event: TurnProgressEvent) => void;
};

function report(deps: EngineDependencies, event: TurnProgressEvent): void {
  try {
    deps.onProgress?.(event);
  } catch {
    // Progress reporting must never break the turn.
  }
}

export const FALLBACK_CONSEQUENCE: ConsequenceResult = {
  narrative: "Nothing changes.",
  actorPatches: [],
  objectPatches: [],
  reasoning: "Fallback due to Consequence Engine failure.",
};

/**
 * Exp-4 item 6: did this turn fall back? Structural check (canonical
 * fallback narrative with no patches) so the history entry can be marked
 * as un-applied ("tried … (not done)") instead of asserted as fact.
 */
export function isFallbackConsequence(result: ConsequenceResult): boolean {
  return (
    result.narrative === FALLBACK_CONSEQUENCE.narrative &&
    result.actorPatches.length === 0 &&
    result.objectPatches.length === 0
  );
}

function depsConfig(deps: EngineDependencies): EngineConfig {
  return deps.config ?? defaultConfig;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * LLMs sometimes echo the candidate list numbering ("3. Call out ...",
 * "2) Nod ...") into the chosen action. That prefix is presentation, not
 * part of the action — strip it so it never reaches consequences,
 * validation, or history.
 */
export function stripSelectionPrefix(text: string): string {
  return text.replace(/^\s*\d+\s*[.)]\s*/, "").trimStart();
}

/** Offline default: keyword-based mock judge (zero network calls). */
const defaultSemanticJudge: SemanticJudge = new MockSemanticJudge();

/** True when every validation error is a speech-rendering nit (dropped/invented wording, lost question, silent-behavior swap). */
export function isSpeechOnlyFailure(errors: string[]): boolean {
  if (errors.length === 0) return false;
  return errors.every((e) =>
    /exact words|invents dialogue|keeps no question|renders no speech/.test(e),
  );
}

/**
 * Exp-5 item 1: tier-2 (degraded) salvage eligibility. Tier 1 accepts fully
 * valid turns or speech-only misses. Tier 2 additionally downgrades
 * speech + object/prop/pose WORDING misses to warnings — dropped quotes,
 * lost questions, silent-behavior swaps, hollow explanations, and
 * pour/brew/open/pick-up/sip/hold/sit wording without a backing patch —
 * so a turn with good clampable movement still advances position +
 * thoughts instead of freezing whole. Staying HARD (never salvaged):
 * physics (bounds/blocked/path), movement direction + real progress,
 * contact adjacency (a handshake across the room), observer-move/state
 * discipline, observer-as-subject prose, unknown actors in the narrative,
 * acting-actor presence, and the direct-addressee patch (repaired
 * deterministically with a stub reaction instead of downgraded).
 */
export function isTier2Salvageable(errors: string[]): boolean {
  if (errors.length === 0) return false;
  return errors.every((e) =>
    /exact words|invents dialogue|keeps no question|renders no speech|keeps none of its topic words|pour\/brew\/open|pick up\/hold|describes sitting|brewing\/pouring|picking something up|opening\/booting|sipping\/drinking\/typing|holding\/carrying|says to (sit|stand)|neither sets pose|without an object patch|without a prop\/object patch/.test(
      e,
    ),
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

function withHonestNote(out: { salvaged: ConsequenceResult; warnings: string[] }): {
  salvaged: ConsequenceResult;
  warnings: string[];
} {
  honestHistoryNotes.set(
    out.salvaged,
    out.warnings.length > 0 ? `partial: ${out.warnings.join(" | ").slice(0, 240)}` : "partial",
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
  const suggestion =
    claimed?.x !== undefined && claimed?.y !== undefined
      ? (clampMoveToCap(world, action.actorId, claimed.x, claimed.y) ??
        suggestMoveTarget(
          world,
          action.actorId,
          semantics.destinationActorId,
          semantics.destinationObjectId,
        ))
      : suggestMoveTarget(
          world,
          action.actorId,
          semantics.destinationActorId,
          semantics.destinationObjectId,
        );
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
    if (semantics.destinationActorId !== undefined) {
      repaired.effects.destinationActorId = semantics.destinationActorId;
    }
    if (semantics.destinationObjectId !== undefined) {
      repaired.effects.destinationObjectId = semantics.destinationObjectId;
    }
  }
  return repaired;
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
): ConsequenceResult | null {
  const addressee = semantics.addresseeActorId;
  if (addressee === undefined || addressee === action.actorId) return null;
  if (candidate.actorPatches.some((p) => p.actorId === addressee)) return null;
  const target = world.actors.find((a) => a.id === addressee);
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!target || !actor) return null;
  const perceives =
    getVisibleActors(world, addressee).some((a) => a.id === action.actorId) ||
    getAudibleActors(world, addressee).some((a) => a.id === action.actorId) ||
    Math.abs(target.x - actor.x) + Math.abs(target.y - actor.y) <= 2;
  if (!perceives) return null;
  const repaired: ConsequenceResult = structuredClone(candidate);
  repaired.actorPatches.push({
    actorId: addressee,
    thoughts: `Heard ${actor.name} — will pick this up next turn.`,
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
  blockers: string[];
};

export function trySalvageConsequence(
  world: World,
  action: Action,
  result: ConsequenceResult,
  semantics: ActionSemantics | undefined,
  logger?: Logger,
): { salvaged: ConsequenceResult; warnings: string[] } | null {
  const evaluate = (eligible: boolean, reason: string, blockers: string[] = []): null => {
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
  // Salvage preserves real effects: the acting actor must remain patched —
  // otherwise the turn's only content was hallucinated (e.g. a lone `ghost`
  // patch) and an emptied husk is no better than the fallback. The one
  // exception is a locomotion turn whose movement can be deterministically
  // repaired below (same repair the retry loop applies).
  if (
    !candidate.actorPatches.some((p) => p.actorId === action.actorId) &&
    !semantics.moves
  ) {
    return evaluate(false, "acting actor unpatched and no locomotion implied: only hallucinated patches");
  }
  const accept = (
    c: ConsequenceResult,
  ): { salvaged: ConsequenceResult; warnings: string[] } | null => {
    const revalidation = validateConsequence(world, c, action, semantics);
    if (revalidation.valid) return { salvaged: c, warnings: [] };
    if (isSpeechOnlyFailure(revalidation.errors)) {
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
  const withAddressee = repairMissingAddressee(world, action, tierBase, semantics);
  const tiered = withAddressee ?? tierBase;
  const revalidation = validateConsequence(world, tiered, action, semantics);
  if (revalidation.valid || isSpeechOnlyFailure(revalidation.errors)) {
    evaluate(
      true,
      withAddressee !== null
        ? "movement kept + addressee reaction patched (speech nits downgraded to warnings)"
        : "valid patches kept (speech nits downgraded to warnings)",
    );
    return withHonestNote({
      salvaged: tiered,
      warnings: revalidation.valid ? [] : revalidation.errors,
    });
  }
  if (isTier2Salvageable(revalidation.errors)) {
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

/**
 * Exp-5 item 6: consecutive own-turn fallback streak for an actor. Counts
 * trailing history entries authored by `actorId` that are fallback-marked
 * ("tried … (not done)"), stopping at that actor's first applied entry.
 * Other actors' interleaved turns don't break the streak — Tanya falling
 * back 7 of her own turns in a row is the freezer signal even when Dana's
 * turns interleave. Applied entries include salvaged/partial and liveness
 * turns (narrative-based, no "(not done)" marker).
 */
export function consecutiveFallbacks(world: World, actorId: string): number {
  const actor = world.actors.find((a) => a.id === actorId);
  const prefixes =
    actor !== undefined
      ? [`${actor.name}:`, `${actor.id}:`, `${actor.name} tried:`, `${actor.id} tried:`]
      : [`${actorId}:`, `${actorId} tried:`];
  let streak = 0;
  for (let i = world.history.length - 1; i >= 0; i--) {
    const entry = world.history[i]!;
    if (!prefixes.some((p) => entry.startsWith(p))) continue;
    if (entry.includes("(not done)")) streak++;
    else break;
  }
  return streak;
}

/**
 * Exp-5 item 6: deterministic liveness reaction. After N consecutive own
 * fallbacks the actor holds position with a fresh thoughts reaction (plus
 * a stub reaction for anyone they were directly addressing), so threads
 * (desk question, first task) can advance by dialogue even when bodies
 * cannot. Bypasses validation like the fallback does — but unlike the
 * fallback it APPLIES (history records the narrative, honestly marked).
 */
function buildLivenessConsequence(
  world: World,
  action: Action,
  semantics: ActionSemantics,
  priorFallbacks: number,
): ConsequenceResult {
  const actor = world.actors.find((a) => a.id === action.actorId);
  const name = actor?.name ?? action.actorId;
  const actorPatches: ConsequenceResult["actorPatches"] = [
    { actorId: action.actorId, thoughts: "Holding position and watching the room." },
  ];
  const addressee = semantics.addresseeActorId;
  if (
    addressee !== undefined &&
    addressee !== action.actorId &&
    world.actors.some((a) => a.id === addressee)
  ) {
    actorPatches.push({
      actorId: addressee,
      thoughts: `Heard ${name} — will pick this up next turn.`,
    });
  }
  const liveness: ConsequenceResult = {
    narrative: `${name} holds position, taking in the room.`,
    actorPatches,
    objectPatches: [],
    reasoning: `Liveness floor after ${priorFallbacks} consecutive fallbacks: minimal in-place reaction so the scene keeps moving.`,
    effects: { moved: false, spoke: false },
  };
  honestHistoryNotes.set(liveness, "liveness floor");
  return liveness;
}

/** Per-turn outcome counts for long-run SLO tracking (Phase 4).
 *
 * Event accounting per resolveWithValidation call:
 * - clean: exactly one `validation_passed` (first-try pass or pass after
 *   retry / deterministic movement repair);
 * - salvaged: one `partial_applied` (degraded-but-advancing: valid patches
 *   kept, speech/object nits logged as warnings);
 * - liveness: one `liveness_applied` (Exp-5 item 6 floor: minimal in-place
 *   reaction after N consecutive fallbacks);
 * - fallback: one `fallback_used` ("Nothing changes.").
 * A turn emits exactly one of the four, so total = clean + salvaged +
 * liveness + fallback. Pass `logger.store.all()` (or any entry list with `event`).
 */
export type TurnOutcomeSummary = {
  clean: number;
  salvaged: number;
  fallback: number;
  /** Exp-5 item 6: minimal applied turns from the liveness floor. */
  liveness: number;
  total: number;
  cleanRate: number;
  salvagedRate: number;
  fallbackRate: number;
  livenessRate: number;
  /** Degraded-but-advancing share (salvaged / total) — the Phase 4 SLO. */
  degradedRate: number;
};

export function summarizeTurnOutcomes(
  entries: ReadonlyArray<{ event: string }>,
): TurnOutcomeSummary {
  let clean = 0;
  let salvaged = 0;
  let fallback = 0;
  let liveness = 0;
  for (const e of entries) {
    if (e.event === "validation_passed") clean++;
    else if (e.event === "partial_applied") salvaged++;
    else if (e.event === "liveness_applied") liveness++;
    else if (e.event === "fallback_used") fallback++;
  }
  const total = clean + salvaged + fallback + liveness;
  const rate = (n: number): number => (total === 0 ? 0 : n / total);
  return {
    clean,
    salvaged,
    fallback,
    liveness,
    total,
    cleanRate: rate(clean),
    salvagedRate: rate(salvaged),
    fallbackRate: rate(fallback),
    livenessRate: rate(liveness),
    degradedRate: rate(salvaged),
  };
}

/** Resolve with validation retries; applies fallback when retries are exhausted. */
export async function resolveWithValidation(
  world: World,
  action: Action,
  deps: EngineDependencies,
  opts: { allowLiveness?: boolean } = {},
): Promise<ConsequenceResult> {
  const config = depsConfig(deps);
  const logger = deps.logger;
  let feedback: string | undefined;
  let lastResult: ConsequenceResult | undefined;
  let lastSemantics: ActionSemantics | undefined;

  for (let attempt = 1; attempt <= Math.max(1, config.maxRetries + 1); attempt++) {
    let result: ConsequenceResult;
    try {
      result = await deps.consequenceEngine.resolve(world, action, feedback);
    } catch (err) {
      logger.log({
        module: "consequence",
        event: "consequence_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, attempt },
        error: errorMessage(err),
      });
      feedback = `Previous attempt raised an error: ${errorMessage(err)}`;
      if (attempt > config.maxRetries) break;
      logger.log({
        module: "turn",
        event: "retry_started",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, attempt: attempt + 1 },
        output: { feedback },
      });
      continue;
    }

    logger.log({
      module: "validator",
      event: "validation_started",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, result, attempt },
    });

    report(deps, {
      stage: "validation_started",
      actorId: action.actorId,
      message: `validating consequence (attempt ${attempt})…`,
    });
    // Merged semantics: the consequence's self-declared `effects` are
    // checked against an independent classification of the action text
    // (OR for requirement flags), so a consequence cannot dodge
    // movement/speech/addressee gates by declaring moved=false/spoke=false.
    // Judge output is logged per turn
    // (semantic_resolved/semantic_completed) for observability, like
    // selection_completed.
    const resolved = await resolveActionSemantics(
      world,
      action,
      result,
      deps.semanticJudge ?? defaultSemanticJudge,
      logger,
    );
    lastResult = result;
    lastSemantics = resolved.semantics;
    const validation = validateConsequence(world, result, action, resolved.semantics);
    if (validation.valid) {
      logger.log({
        module: "validator",
        event: "validation_passed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, result, attempt, semanticsSource: resolved.source, semantics: resolved.semantics },
        output: validation,
      });
      return result;
    }

    logger.log({
      module: "validator",
      event: "validation_failed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, result, attempt, semanticsSource: resolved.source, semantics: resolved.semantics },
      validationErrors: validation.errors,
    });

    // Deterministic movement repair: small LLMs often narrate movement
    // correctly but omit the required x/y patch on every retry. When the
    // failure is movement-only and we can compute a valid closer position,
    // patch it in directly instead of burning retries on a "Nothing
    // changes." fallback. The narrative already describes the movement, so
    // filling in coordinates preserves intent.
    let movementHint: string | undefined;
    if (resolved.semantics?.moves) {
      const suggestion = suggestMoveTarget(
        world,
        action.actorId,
        resolved.semantics.destinationActorId,
        resolved.semantics.destinationObjectId,
      );
      if (suggestion) {
        const dest = resolved.semantics.destinationActorId
          ? ` strictly closer to ${resolved.semantics.destinationActorId}`
          : resolved.semantics.destinationObjectId
            ? ` strictly closer to ${resolved.semantics.destinationObjectId}`
            : "";
        movementHint =
          `Movement hint: emit actorPatch {"actorId": "${action.actorId}", "x": ${suggestion.x}, "y": ${suggestion.y}, ...}` +
          ` — position (${suggestion.x}, ${suggestion.y}) is reachable and${dest ? dest : " a valid step"} from the current position. ` +
          `Set effects.moved=true${resolved.semantics.destinationActorId ? ` and effects.destinationActorId="${resolved.semantics.destinationActorId}"` : ""}${resolved.semantics.destinationObjectId ? ` and effects.destinationObjectId="${resolved.semantics.destinationObjectId}"` : ""}.`;
        if (isMovementOnlyFailure(validation.errors)) {
          const repaired: ConsequenceResult = structuredClone(result);
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
            if (resolved.semantics.destinationActorId !== undefined) {
              repaired.effects.destinationActorId = resolved.semantics.destinationActorId;
            }
            if (resolved.semantics.destinationObjectId !== undefined) {
              repaired.effects.destinationObjectId = resolved.semantics.destinationObjectId;
            }
          }
          // Re-validate against the same judged semantics (effects may now
          // agree with the judge — either way the movement gate must pass).
          const revalidation = validateConsequence(
            world,
            repaired,
            action,
            resolved.semantics,
          );
          if (revalidation.valid) {
            logger.log({
              module: "validator",
              event: "validation_passed",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              input: { action, result: repaired, attempt, semanticsSource: resolved.source, semantics: resolved.semantics },
              output: { ...revalidation, repaired: true, suggestion },
            });
            logger.log({
              module: "turn",
              event: "movement_repaired",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              input: { action, result, attempt },
              output: { suggestion, repaired },
            });
            return repaired;
          }
        }
      }
      // Exp-4 item 1: the speed limit reads as a pace, not a wall. When the
      // model claims an over-cap jump in the right direction (tick 15: the
      // full 14-cell entrance→desk walk; tick 18: 8–12-cell strides),
      // project ITS claimed target onto the ≤6-cell reachable set and
      // continue next turn — instead of failing the whole turn. Accepts
      // only when the clamped position passes the full gate on
      // revalidation; otherwise the turn retries/salvages normally.
      const capHit = validation.errors.some((e) => /at most 6 cells/i.test(e));
      if (capHit && isClampableMovementFailure(validation.errors)) {
        const claimed = result.actorPatches.find((p) => p.actorId === action.actorId);
        const clamped =
          claimed?.x !== undefined && claimed?.y !== undefined
            ? clampMoveToCap(world, action.actorId, claimed.x, claimed.y)
            : undefined;
        if (clamped) {
          const clampedResult: ConsequenceResult = structuredClone(result);
          const existing = clampedResult.actorPatches.find((p) => p.actorId === action.actorId);
          if (existing) {
            existing.x = clamped.x;
            existing.y = clamped.y;
          } else {
            clampedResult.actorPatches.push({
              actorId: action.actorId,
              x: clamped.x,
              y: clamped.y,
            });
          }
          if (clampedResult.effects) {
            clampedResult.effects.moved = true;
          }
          const revalidation = validateConsequence(
            world,
            clampedResult,
            action,
            resolved.semantics,
          );
          if (revalidation.valid) {
            logger.log({
              module: "validator",
              event: "validation_passed",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              input: { action, result: clampedResult, attempt, semanticsSource: resolved.source, semantics: resolved.semantics },
              output: { ...revalidation, repaired: true, clamped: true, suggestion: clamped },
            });
            logger.log({
              module: "turn",
              event: "movement_repaired",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              input: { action, result, attempt },
              output: { suggestion: clamped, repaired: clampedResult, clamped: true },
            });
            return clampedResult;
          }
        }
      }
    }

    // Phase 4 "retry only prose": when the patches are valid and only the
    // narrative prose fails (speech nit, possibly plus droppable
    // hallucinated patches), say so explicitly — otherwise the retry
    // regenerates everything and often loses the good movement it just had
    // (ticks 3/9). This hint costs nothing when the model already retries
    // cleanly; after retries are exhausted the salvage path below applies
    // the same split (keep patches, warn on speech).
    let proseHint: string | undefined;
    if (isSpeechOnlyFailure(validation.errors)) {
      proseHint =
        "The patches are valid — keep every actorPatch/objectPatch exactly as-is and fix ONLY the narrative prose (preserve the action's exact wording).";
    } else if (validation.errors.some((e) => /unknown (actor|object) id/.test(e))) {
      proseHint =
        "Drop patches that reference unknown ids, keep the remaining valid patches exactly as-is, and fix the narrative prose.";
    }

    feedback = `Previous consequence output was invalid:\n${validation.errors.map((e) => `- ${e}`).join("\n")}${proseHint ? `\n${proseHint}` : ""}${movementHint ? `\n${movementHint}` : ""}\nReturn corrected JSON only.`;
    if (attempt > config.maxRetries) break;
    report(deps, {
      stage: "consequence_retry",
      actorId: action.actorId,
      message: `consequence invalid — retrying (attempt ${attempt + 1})…`,
    });
    logger.log({
      module: "turn",
      event: "retry_started",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, attempt: attempt + 1 },
      output: { feedback },
      validationErrors: validation.errors,
    });
  }

  // Exp-3 item 6: before giving up to "Nothing changes.", try to salvage
  // the last attempt — keep valid movement/patches, warn on speech nits.
  // Exp-4 item 8: the evaluation (eligible/ineligible + reason) is logged
  // inside trySalvageConsequence as `salvage_evaluated`.
  if (lastResult && lastSemantics) {
    const salvage = trySalvageConsequence(world, action, lastResult, lastSemantics, logger);
    if (salvage) {
      logger.log({
        module: "turn",
        event: "partial_applied",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, result: lastResult },
        output: { salvaged: salvage.salvaged, warnings: salvage.warnings },
        ...(salvage.warnings.length > 0
          ? { error: `speech warnings (applied anyway): ${salvage.warnings.join(" | ")}` }
          : {}),
      });
      return salvage.salvaged;
    }
  }

  // Exp-5 item 6: NPC liveness floor. Before giving up to "Nothing
  // changes.", check whether this actor has already fallen back N
  // consecutive own turns — if so, apply a minimal in-place reaction
  // (thoughts-only, plus a stub for anyone directly addressed) so the
  // scene keeps moving by dialogue even when bodies cannot. User turns
  // are excluded by the caller: silently rewriting the user's own action
  // would hide the failure from them.
  if (opts.allowLiveness !== false && lastSemantics) {
    const threshold = depsConfig(deps).livenessFallbackThreshold ?? 3;
    const priorFallbacks = consecutiveFallbacks(world, action.actorId);
    if (priorFallbacks >= threshold) {
      const liveness = buildLivenessConsequence(world, action, lastSemantics, priorFallbacks);
      logger.log({
        module: "turn",
        event: "liveness_applied",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, result: lastResult, priorFallbacks },
        output: { liveness },
      });
      return liveness;
    }
  }

  logger.log({
    module: "turn",
    event: "fallback_used",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    input: { action, feedback },
    output: FALLBACK_CONSEQUENCE,
    error: "max retries exceeded",
  });
  return structuredClone(FALLBACK_CONSEQUENCE);
}

async function autosave(world: World, deps: EngineDependencies): Promise<void> {
  const config = depsConfig(deps);
  if (!config.autosaveEnabled) return;
  try {
    if (deps.onAutosave) {
      await deps.onAutosave(world);
    } else {
      await saveWorld(defaultSavePath(config.saveDir, world.id, world.tick), world, deps.logger);
    }
  } catch (err) {
    deps.logger.log({
      module: "turn",
      event: "error_occurred",
      tick: world.tick,
      turnIndex: world.turnIndex,
      error: `autosave failed: ${errorMessage(err)}`,
    });
  }
}

/**
 * Run a single immediate turn for the current actor and return the next world.
 * User actors: no proposal/selection — the user decides freely via
 * getUserAction (called with no suggestions). NPC actors: propose + select.
 * Every stage is logged.
 */
export async function runTurn(world: World, deps: EngineDependencies): Promise<World> {
  const config = depsConfig(deps);
  const logger = deps.logger;
  const actor = getCurrentActor(world);

  logger.log({
    module: "turn",
    event: "turn_started",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: actor.id,
    input: { world: structuredClone(world) },
  });

  report(deps, { stage: "turn_started", actorId: actor.id, message: `turn started — ${actor.id} (tick ${world.tick})` });
  report(deps, { stage: "proposal_started", actorId: actor.id, message: `proposal engine — generating suggestions for ${actor.id}…` });

  let action: Action;
  if (actor.id === world.userActorId) {
    // User turns: no proposal, no selection. The user decides how to act
    // without suggestions — skip both engines entirely so no
    // proposal/selection LLM calls (or logs) happen for the user.
    logger.log({
      module: "proposal",
      event: "proposal_skipped",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: actor.id,
      input: { actorId: actor.id, reason: "user turn: user acts freely, no suggestions generated" },
    });
    report(deps, { stage: "proposal_done", actorId: actor.id, message: `proposal skipped (user turn)` });
    report(deps, { stage: "waiting_user_input", actorId: actor.id, message: "waiting for your action…" });
    if (!deps.getUserAction) {
      throw new Error("getUserAction is required for user-controlled turns");
    }
    const userText = await deps.getUserAction(actor.id, []);
    if (!userText || userText.trim().length === 0) {
      logger.log({
        module: "turn",
        event: "error_occurred",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: actor.id,
        input: { suggestions: [] },
        error: "empty user action text",
      });
      throw new Error("empty user action text: request action again");
    }
    action = { actorId: actor.id, text: userText };
    logger.log({
      module: "turn",
      event: "useractionsubmitted",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: actor.id,
      input: { suggestions: [] },
      output: action,
    });
  } else {
    const proposal = await deps.proposalEngine.propose(world, actor.id);
    report(deps, { stage: "proposal_done", actorId: actor.id, message: `proposal engine done (${proposal.suggestions.length} suggestions)` });
    report(deps, { stage: "selection_started", actorId: actor.id, message: `selection engine — ${actor.id} is deciding…` });
    const selection = await deps.selectionEngine.select(world, actor.id, proposal.suggestions);
    report(deps, { stage: "selection_done", actorId: actor.id, message: `selection engine done — action chosen` });
    let actionText = stripSelectionPrefix(selection.action);
    // Exp-5 items 5+7: screen the pick BEFORE burning consequence attempts
    // on it. A POV-swapped pick ("Anton walks…" on Dana's turn) or a
    // verb+noun repeat of a recent own action (handshake attractor) is
    // rejected here and replaced with the first clean candidate — the
    // proposal engine already dedups its own output, but the selector may
    // invent a repeat (or a mock may replay one).
    const rejection = validateSelectionForActor(world, actor.id, actionText);
    if (rejection !== undefined) {
      logger.log({
        module: "selection",
        event: "selection_rejected",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: actor.id,
        input: { action: actionText, suggestions: proposal.suggestions },
        output: { rejection },
        error: rejection,
      });
      const clean = proposal.suggestions
        .map((s) => stripSelectionPrefix(s))
        .find((s) => s.length > 0 && validateSelectionForActor(world, actor.id, s) === undefined);
      actionText = clean ?? FALLBACK_SELECTION.action;
      logger.log({
        module: "selection",
        event: "selection_substituted",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: actor.id,
        input: { rejected: selection.action },
        output: { action: actionText },
      });
    }
    action = { actorId: actor.id, text: actionText };
  }

  logger.log({
    module: "turn",
    event: "action_chosen",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    output: action,
  });

  report(deps, { stage: "consequence_started", actorId: action.actorId, message: `consequence engine — resolving "${action.text.slice(0, 60)}${action.text.length > 60 ? "…" : ""}"…` });
  const consequence = await resolveWithValidation(world, action, deps, {
    // Exp-5 item 6: the liveness floor rewrites failed turns — never the
    // user's own action text.
    allowLiveness: action.actorId !== world.userActorId,
  });
  report(deps, { stage: "validation_done", actorId: action.actorId, message: "consequence validated" });

  // Exp-4 item 6: mark fallback history as un-applied so proposals ground
  // on the world, not the wish. Exp-5 item 2: salvaged/liveness turns
  // record the narrative (what happened) plus the honest note — never the
  // raw action text — so later turns don't assume a dropped desk question
  // was asked or a laptop setup happened.
  const patched = applyConsequence(world, consequence, action, config, {
    fallback: isFallbackConsequence(consequence),
    honestHistoryNote: getHonestHistoryNote(consequence),
  });
  report(deps, { stage: "patch_applied", actorId: action.actorId, message: "world updated" });
  logger.log({
    module: "turn",
    event: "patch_applied",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    input: { consequence, action },
    output: { historyTail: patched.history.slice(-1) },
  });
  logger.log({
    module: "turn",
    event: "history_appended",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    output: { history: patched.history.slice(-1) },
  });

  const ticked = incrementTick(patched);
  const nextWorld = advanceTurn(ticked);

  logger.log({
    module: "turn",
    event: "turn_completed",
    tick: nextWorld.tick,
    turnIndex: nextWorld.turnIndex,
    actorId: action.actorId,
    output: structuredClone(nextWorld),
  });

  await autosave(nextWorld, deps);
  report(deps, { stage: "turn_completed", actorId: action.actorId, message: "turn completed" });
  return nextWorld;
}

/** Run n consecutive turns (helper for tests and scripts). */
export async function runTurns(world: World, deps: EngineDependencies, n: number): Promise<World> {
  let current = world;
  for (let i = 0; i < n; i++) {
    current = await runTurn(current, deps);
  }
  return current;
}
