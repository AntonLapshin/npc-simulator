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
  World,
} from "../types.js";
import type { Logger } from "../logging/logger.js";
import { FALLBACK_CONSEQUENCE } from "../llm/llmConsequenceEngine.js";
import { validateConsequence } from "./physicalValidator.js";
import {
  clampMoveToCap,
  isClampableMovementFailure,
  suggestMoveTarget,
} from "./movementAssist.js";
import { getAudibleActors, getVisibleActors } from "./perceptionHelpers.js";
import {
  hasSpeechToken,
  parseActionQuotes,
  resolveDeterministicSemantics,
} from "./deterministicSemantics.js";
import { tryCloseTruncatedJson } from "../llm/json.js";

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
  const narrative = synthesizeSalvageNarrative(action, name);
  if (narrative.trim().length === 0) return null;
  const actorPatches: ConsequenceResult["actorPatches"] = [];
  if (thoughts) actorPatches.push({ actorId: action.actorId, thoughts });
  const addressee = resolveDeterministicSemantics(world, action).addresseeActorId;
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
