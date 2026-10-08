// Final accept-gate and best-attempt selection for the turn loop.
//
// Experiment-2 item 5 (S2): two fully-corrupt consequences passed
// `validateConsequence` outright (tick 10: "Ana: Jeff introduces Ana to
// Dan." for a silent coffee sip; tick 11: "Dan walks into the conference
// room…" for "Stay where you are" via self-declared effects.moved=true).
// The salvage path already re-runs the full gate suite on every accept —
// the hole was that these narratives never reached salvage. So every
// accept path (retry-loop clean accept, in-loop repairs, salvage accepts)
// now runs `recheckAcceptedProse` on the final narrative: the prose gates
// re-checked with the strictures the main validator lacks (attribution-
// prefix stripping, verb-agnostic observer-as-subject, explicit-stay
// movement). Unconditional: this is a correctness fix for ARCHITECTURE
// P1 ("deterministic code decides").
//
// Experiment-2 item 7 (S1/S7): `pickBestAttempt` (pure) selects the retry
// attempt with the fewest hard-gate errors for salvage instead of the
// last/worst.

import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  ValidationError,
  World,
} from "../types.js";
import {
  validateIdentityConsistency,
  validateNarrativeActors,
  validateObserverSubject,
  validateEnterFreshness,
  matchObserverCoordination,
  observerNameTokens,
} from "./validate/narrative.js";

/** One failed retry-loop attempt, kept for best-attempt salvage. */
export type AttemptRecord = {
  result: ConsequenceResult;
  semantics: ActionSemantics | undefined;
  hardErrors: number;
  /** 1-based attempt number (for logging which attempt salvage picked). */
  attempt: number;
};

/**
 * Item 7 (S7): pick the attempt with the FEWEST hard-gate errors for
 * salvage — not the last. Ties go to the EARLIEST attempt: retry
 * divergence makes later attempts systematically worse, so the first
 * least-bad attempt dominates. Pure.
 */
export function pickBestAttempt(
  attempts: readonly AttemptRecord[],
): AttemptRecord | undefined {
  let best: AttemptRecord | undefined;
  for (const a of attempts) {
    if (best === undefined || a.hardErrors < best.hardErrors) best = a;
  }
  return best;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Item 5 (S2): strip a leading turn-attribution prefix ("Ana: …", "ana - …")
 * before prose checks. Narratives in this codebase carry the acting actor's
 * name as a prefix (see synthesizeActionNarrative), but
 * `validateObserverSubject` matches clause-leading observer names — with
 * the prefix in place the true grammatical subject ("Jeff introduces…")
 * hides behind "Ana:" and the gate never fires. Only the ACTING actor's
 * own name/id is stripped; an observer's prefix ("Jeff: …" on Ana's turn)
 * is left in place so the gates still see it.
 */
export function stripAttributionPrefix(
  narrative: string,
  actorName: string,
  actorId: string,
): string {
  const dequoted = narrative.replace(/^["'(\[]+/, "");
  for (const label of [actorName, actorId]) {
    if (label.trim().length === 0) continue;
    const m = dequoted.match(new RegExp(`^${escapeRegExp(label.trim())}\\s*[:\\-]\\s*`, "i"));
    if (m) return dequoted.slice(m[0].length);
  }
  return narrative;
}

/**
 * Item 5 (S2): verb-agnostic observer-as-subject supplement. The
 * validator's OBSERVER_SUBJECT_VERBS list missed "introduces" (tick 10:
 * "Jeff introduces Ana to Dan." passed), and any verb list can miss the
 * next one. Per turn discipline the narrative must describe ONLY the
 * acting actor — observers react in thoughts patches, never as grammatical
 * subjects — so ANY clause led by a roster observer's name + word is a
 * violation, regardless of verb. Mirrors validateObserverSubject's
 * clause-splitting and name/boundary handling (possessives like "Tanya's
 * hand" and comma-led "Jeff, smiling," do not match); strictly more
 * sensitive, so it subsumes the validator's list on the stripped narrative.
 */
export function findSupplementObserverSubject(
  world: World,
  narrative: string,
  action: Action,
): ValidationError[] {
  const names = observerNameTokens(world, action.actorId);
  if (names.length === 0) return [];
  const observerError = (id: string, clause: string): ValidationError[] => [
    {
      code: "narrative.observer_as_subject",
      message: `narrative casts roster observer "${id}" as the acting subject ("${clause.slice(0, 60)}...") on ${action.actorId}'s turn: describe ONLY what the acting actor (${action.actorId}) observably does — observers react in thoughts patches, never in the narrative`,
    },
  ];
  // Exp-5 item 7 (S3, tick-23 repro): observer-led coordinations, checked
  // on the unsplit clause first — the and-split below shreds "Tanya and
  // Dana turn…" into a bare "tanya" fragment and an acting-actor-led
  // clause, hiding the observer. Verb-agnostic here (any trailing word
  // counts); the validator version additionally requires a verb from its
  // list.
  const sentences = narrative
    .split(/[.!?;]+\s*/)
    .map((c) => c.replace(/^["'(\[]+/, "").trim().toLowerCase())
    .filter((c) => c.length > 0);
  for (const s of sentences) {
    const hit = matchObserverCoordination(s, names);
    if (hit !== undefined) return observerError(hit.id, s);
  }
  const clauses = narrative
    .split(/[.!?;]+\s*|\s+and\s+/i)
    .map((c) => c.replace(/^["'(\[]+/, "").trim().toLowerCase())
    .filter((c) => c.length > 0);
  for (const clause of clauses) {
    for (const { token, id } of names) {
      if (token.length < 2) continue;
      if (!clause.startsWith(token)) continue;
      const rest = clause.slice(token.length);
      // Name must be a whole word followed by whitespace + another word
      // ("Jeff introduces…" matches; "Jeff's desk", "Jeff," do not).
      if (/^\s+[a-z]+/.test(rest)) {
        return observerError(id, clause);
      }
      break;
    }
  }
  return [];
}

/**
 * Item 5 (S2): explicit-stay actions. "Stay where you are." carries no
 * locomotion verb, so the validator's movement gates stay silent — and a
 * consequence that self-declares effects.moved=true additionally dodges
 * `movement.unexpected_move` through the merged-semantics OR-trust (tick
 * 11 teleported Dan on a stay action and passed). The action TEXT is not
 * subject to OR-trust: an unambiguous stay instruction plus an actual
 * position change on the acting actor is always a violation, no matter
 * what effects were declared.
 */
const EXPLICIT_STAY_RE =
  /\bstay\b/i;
const EXPLICIT_HOLD_RE =
  /\b(don't|dont|do not) move\b|\bhold (still|your position)\b|\bremain\s+(in place|put|seated|standing|where (you|he|she|they) are|still)\b/i;

export function isExplicitStayAction(text: string): boolean {
  return EXPLICIT_STAY_RE.test(text) || EXPLICIT_HOLD_RE.test(text);
}

/**
 * Item 5 (S2): final prose re-check on the ACCEPTED narrative. Runs after
 * `validateConsequence` passed (or salvage accepted) — defense in depth
 * for the P1 guarantee, unconditional. Re-checks:
 * - unknown-actor (validateNarrativeActors, re-run),
 * - observer-as-subject (validateObserverSubject on the
 *   attribution-stripped narrative + the verb-agnostic supplement —
 *   the tick-10 "Ana: Jeff introduces Ana to Dan." hole),
 * - explicit-stay movement (the tick-11 "Stay where you are" + teleport
 *   hole; text-based, immune to the effects.moved OR-trust).
 * Patch-side turn-discipline gates (observer_moved/state/goal) and
 * action-verb-coverage are deterministic re-runs of what
 * validateConsequence already enforced on this exact payload, so they add
 * no signal here and are not repeated.
 */export function recheckAcceptedProse(
  world: World,
  action: Action,
  result: ConsequenceResult,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const actor = world.actors.find((a) => a.id === action.actorId);
  const actorName = actor?.name ?? action.actorId;

  errors.push(
    // Exp-5 item 5 (S4, tick-27 repro): narrative-only — the reasoning
    // field never becomes canonical history, and the engine itself writes
    // pipeline words into it, so scanning it false-positives.
    ...validateNarrativeActors(world, {
      narrative: result.narrative,
    }),
  );
  // Exp-3 item 6 (S3, tick-20 repro): the accept path is the last line of
  // defense — an actor claiming another roster actor's name or the
  // newcomer's role ("I'm Dana, the new hire" on Dana's turn) must never
  // become canonical history, no matter which path accepted the turn.
  errors.push(...validateIdentityConsistency(world, result.narrative, action));

  const stripped = stripAttributionPrefix(result.narrative, actorName, action.actorId);
  errors.push(...validateObserverSubject(world, { narrative: stripped }, action));
  errors.push(...findSupplementObserverSubject(world, stripped, action));
  // Exp-5 item 7 (S3, ticks 23/24 repro): stale "enters the office"
  // narratives must not become canonical on the accept path either.
  errors.push(...validateEnterFreshness(world, result.narrative, action));

  if (isExplicitStayAction(action.text) && actor) {
    const patch = result.actorPatches.find((p) => p.actorId === action.actorId);
    if (
      patch?.x !== undefined &&
      patch?.y !== undefined &&
      (patch.x !== actor.x || patch.y !== actor.y)
    ) {
      errors.push({
        code: "movement.unexpected_move",
        message: `action explicitly says to stay ("${action.text.slice(0, 60)}") but acting actor (${action.actorId}) moves from (${actor.x}, ${actor.y}) to (${patch.x}, ${patch.y}): a stay action never moves, no matter what effects were declared — stay in place`,
      });
    }
  }
  return errors;
}

/**
 * Error-severity taxonomy for salvage eligibility and retry feedback.
 * (Moved here from turnSalvage.ts when the S2 accept-gate work pushed it
 * past ~800 lines; re-exported there for backward compat.)
 */

/** F2: speech-nit codes — salvage tier 1 downgrades these to warnings. */
export const SPEECH_ONLY_CODES = new Set([
  "speech.dropped_words",
  "speech.invented_dialogue",
  "speech.question_dropped",
  "speech.no_speech_rendered",
]);

/** True when every validation error is a speech-rendering nit (dropped/invented wording, lost question, silent-behavior swap). */
export function isSpeechOnlyFailure(errors: ValidationError[]): boolean {
  if (errors.length === 0) return false;
  return errors.every((e) => SPEECH_ONLY_CODES.has(e.code));
}

/**
 * Item C10 (S7): hard (non-speech-nit) error count for best-attempt
 * salvage. Speech-rendering nits are downgradable noise; everything else
 * is a hard error. Pure.
 */
export function countHardErrors(errors: ValidationError[]): number {
  return errors.filter((e) => !SPEECH_ONLY_CODES.has(e.code)).length;
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
/** F2: tier-2 codes — speech + object/prop/pose WORDING misses downgraded to warnings. */
export const TIER2_CODES = new Set([
  ...SPEECH_ONLY_CODES,
  "speech.topic_dropped",
  "object_grounding.sit_no_pose",
  "object_grounding.brew_no_patch",
  "object_grounding.pickup_no_patch",
  "object_grounding.open_no_patch",
  "object_grounding.sip_no_prop",
  "object_grounding.hold_no_prop",
  "action.pour_no_patch",
  "action.pickup_no_patch",
  "action.sit_no_pose",
  "action.stand_no_pose",
  // Exp-3 item 10 (S8): ungrounded thoughts are content misses, not world
  // corruption — downgradable like other wording misses.
  "thoughts.unknown_proper_noun",
  "thoughts.ungrounded_claim",
]);

export function isTier2Salvageable(errors: ValidationError[]): boolean {
  if (errors.length === 0) return false;
  return errors.every((e) => TIER2_CODES.has(e.code));
}

/**
 * Coordinator follow-up (Exp-2 M4 retry divergence): deterministic
 * "most severe error first, one line" retry-feedback directive. The Laya
 * expansion worker evaluated a decision-model approach for "which error to
 * fix first" and rejected it — the subtask is already encodable
 * deterministically. Severity follows the salvage taxonomy above: hard
 * gates (physics, movement, contact, discipline, prose — never
 * downgradable) first, then tier-2 wording misses (salvageable), then
 * speech nits (downgradable noise) last; ties keep original order (stable
 * sort). Replaces the raw multi-gate error dump in the retry feedback —
 * the dump pushed small models off-distribution (attempt 4 systematically
 * worse than attempt 1). Pure.
 */
function retryDirectiveSeverity(code: string): number {
  if (SPEECH_ONLY_CODES.has(code)) return 2;
  if (TIER2_CODES.has(code)) return 1;
  return 0;
}

export function buildRetryDirective(errors: ValidationError[]): string {
  if (errors.length === 0) {
    return "Fix this first: [unknown] the previous output was rejected with no details — re-emit the consequence with valid patches and grounded prose.";
  }
  const [top] = [...errors].sort(
    (a, b) => retryDirectiveSeverity(a.code) - retryDirectiveSeverity(b.code),
  );
  const oneLine = top!.message.replace(/\s+/g, " ").trim().slice(0, 220);
  return `Fix this first: [${top!.code}] ${oneLine}`;
}
