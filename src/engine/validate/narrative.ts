// Narrative actor, observer-discipline, state-coherence and addressee checks
// (extracted from physicalValidator.ts).

import type { Action, ActionSemantics, EngineConfig, ValidationError, World } from "../../types.js";
import { defaultConfig } from "../../config.js";
import { getAudibleActors, getVisibleActors } from "../perceptionHelpers.js";
import { maskResumedActivity } from "./speech.js";
import { isNonLocomotionSense } from "./movement.js";

/**
 * Actors that perceived the acting actor's event (mirrors contextBuilder).
 * F7: takes the injected EngineConfig so perception-radius overrides apply.
 */
export function perceiverIds(
  world: World,
  actingActorId: string,
  cfg: EngineConfig = defaultConfig,
): Set<string> {
  const actor = world.actors.find((a) => a.id === actingActorId);
  const out = new Set<string>([actingActorId]);
  if (!actor) return out;
  for (const o of world.actors) {
    if (o.id === actingActorId) continue;
    const sees = getVisibleActors(world, o.id, cfg).some((a) => a.id === actingActorId);
    const hears = getAudibleActors(world, o.id, cfg).some((a) => a.id === actingActorId);
    const adjacent =
      Math.abs(o.x - actor.x) + Math.abs(o.y - actor.y) <= 2;
    if (sees || hears || adjacent) out.add(o.id);
  }
  return out;
}

/**
 * Addressee patching (action item 5): when the action speaks directly TO a
 * perceiving actor ("ask Tanya ..."), that addressee must record at least
 * a thoughts reaction. A direct question with no patch on the person asked
 * means the event left no trace on them — reject so the model retries.
 */
export function validateAddresseePatch(
  world: World,
  normalized: { actorPatches: { actorId: string; thoughts?: string }[] },
  action: Action,
  semantics: ActionSemantics,
  cfg: EngineConfig = defaultConfig,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (semantics.addresseeActorId === undefined) return errors;
  if (semantics.addresseeActorId === action.actorId) return errors;
  const target = world.actors.find((a) => a.id === semantics.addresseeActorId);
  if (!target) return errors;
  if (!perceiverIds(world, action.actorId, cfg).has(target.id)) return errors; // couldn't perceive — no patch owed
  const patched = normalized.actorPatches.some((p) => p.actorId === target.id);
  if (!patched) {
    errors.push({
      code: "speech.addressee_not_patched",
      message: `action speaks directly to ${target.id} but ${target.id} has no actorPatch: give every perceiving actor (especially a direct addressee) at least a 'thoughts' reaction patch`,
    });
  }
  return errors;
}

/**
 * Acting-actor presence (exp-2 item 2, tick 11 repro): a turn whose judged
 * meaning is locomotion or physical contact must leave a trace on the acting
 * actor itself. Patches on observers only (or no patches at all for contact)
 * mean the actor did nothing while someone else reacted — reject so the
 * model retries with the acting actor patched. Symmetric to the existing
 * observer-move rule. Speech-only turns with zero patches stay allowed
 * (a greeting need not change state), and fail-open turns without semantics
 * are untouched.
 */
/**
 * Exp-6 item 5 (tick 1): state↔pose↔position coherence. The consequence
 * stood Tanya up, walked her 5.8 cells, and put the laptop down — but her
 * `state` string still read "sitting at her desk and working on a laptop".
 * Prose/state drift was free because no check compared them. When a patch
 * changes the acting actor's pose, prop, or position, the effective
 * `state` (patch.state ?? world state) must not contradict it:
 * - pose → stand while the state claims sitting/seated (or pose → sit
 *   while the state claims standing — "standing desk" furniture excluded);
 * - prop cleared/swapped while the state still claims to work on/hold it
 *   ("working on a laptop" with prop=null; a "puts the laptop down"
 *   release phrasing stays coherent);
 * - a >2-cell move while the state still claims sitting (the "sitting
 *   state while standing 5.8 cells away" case) — chair-rolling exempt.
 * Rejects with a targeted message so the retry fixes the prose; the
 * validator never rewrites sentences itself.
 */
export function validateStateCoherence(
  world: World,
  normalized: {
    actorPatches: {
      actorId: string;
      x?: number;
      y?: number;
      state?: string;
      pose?: string;
      prop?: string | null;
    }[];
  },
  action: Action,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const sittingRe = /\bsit\b|\bsitting\b|\bseated\b/i;
  const standingRe = /\bstand\b|\bstanding\b(?!\s+desk)|\bstood\b/i;
  /**
   * True when the state carries descriptive content beyond the bare
   * posture word ("sitting at her desk and working on a laptop" vs
   * "sitting"). The tick-1 failure was a rich stale description feeding
   * the next turn's proposal context; a bare posture word is the world's
   * terse status line and stays valid without an update (blessed by the
   * exp-2/3/4 sit/settle tests).
   */
  const isDescriptiveState = (state: string, postureRe: RegExp): boolean => {
    const stripped = state.replace(postureRe, "").replace(/[^a-z0-9]+/gi, " ").trim();
    return stripped.length >= 3;
  };
  for (const patch of normalized.actorPatches) {
    const actor = world.actors.find((a) => a.id === patch.actorId);
    if (!actor) continue;
    const poseChanged = patch.pose !== undefined && patch.pose !== actor.pose;
    const propChanged = patch.prop !== undefined && patch.prop !== actor.prop;
    const moved =
      patch.x !== undefined &&
      patch.y !== undefined &&
      Math.hypot(patch.x - actor.x, patch.y - actor.y) > 2;
    if (!poseChanged && !propChanged && !moved) continue;
    const state = patch.state ?? actor.state;
    const pose = patch.pose ?? actor.pose;
    if (poseChanged) {
      if (
        /^stand$/i.test(patch.pose!) &&
        sittingRe.test(state) &&
        isDescriptiveState(state, sittingRe)
      ) {
        errors.push({
          code: "state.pose_state_mismatch",
          message: `actor ${patch.actorId}: pose changed to "stand" but state still reads "${state.slice(0, 80)}": update 'state' to match the new pose (standing, no longer sitting)`,
        });
      } else if (
        /^sit$/i.test(patch.pose!) &&
        standingRe.test(state) &&
        isDescriptiveState(state, standingRe)
      ) {
        errors.push({
          code: "state.pose_state_mismatch",
          message: `actor ${patch.actorId}: pose changed to "sit" but state still reads "${state.slice(0, 80)}": update 'state' to match the new pose (sitting, no longer standing)`,
        });
      }
    }
    if (propChanged && actor.prop) {
      const oldProp = actor.prop;
      const releaseRe = new RegExp(
        `\\b(put|puts|putting|set|sets|setting|plac\\w+|hand\\w+)\\b[^.]{0,40}\\b${oldProp}\\b`,
        "i",
      );
      const stillClaimsProp =
        new RegExp(`\\b${oldProp}\\b`, "i").test(state) && !releaseRe.test(state);
      if (stillClaimsProp) {
        errors.push({
          code: "state.prop_state_mismatch",
          message: `actor ${patch.actorId}: prop changed from "${oldProp}" to ${patch.prop === null ? "null" : `"${patch.prop}"`} but state still reads "${state.slice(0, 80)}": update 'state' to match (no longer working on/holding the ${oldProp})`,
        });
      }
    }
    if (
      moved &&
      !/^stand$/i.test(pose ?? "") &&
      sittingRe.test(state) &&
      isDescriptiveState(state, sittingRe)
    ) {
      // Rolling a chair is legitimate seated locomotion — exempt it.
      if (!/\b(roll\w*|wheel\w*|chair)\b/i.test(action.text)) {
        errors.push({
          code: "state.moved_while_sitting",
          message: `actor ${patch.actorId}: moved ${Math.hypot(patch.x! - actor.x, patch.y! - actor.y).toFixed(1)} cells but state still reads "${state.slice(0, 80)}": update 'state' (and 'pose') to match — a sitting state cannot walk across the room`,
        });
      }
    }
  }
  return errors;
}

export function validateActingActorPresence(  normalized: { actorPatches: { actorId: string }[] },
  action: Action,
  semantics: ActionSemantics,
): ValidationError[] {
  // Exp-2 item 8 (S4/S5): word-sense override — an interrogative question
  // or a pure facing turn is not locomotion even when the judged semantics
  // say moves=true, so it must not demand an acting-actor movement patch
  // (a speech+facing turn with zero patches stays allowed, like any
  // speech-only turn). Contact turns are unaffected.
  const moves = semantics.moves && !isNonLocomotionSense(action.text);
  const needsActor = moves || semantics.contactActorId !== undefined;
  if (!needsActor) return [];
  const hasActing = normalized.actorPatches.some((p) => p.actorId === action.actorId);
  if (!hasActing) {
    const kind = semantics.contactActorId !== undefined ? "physical contact" : "movement";
    return [
      {
        code: "turn_discipline.acting_actor_not_patched",
        message: `action implies ${kind} but acting actor (${action.actorId}) has no actorPatch (only observers patched, or none): patch the acting actor itself with the movement/contact outcome`,
      },
    ];
  }
  return [];
}

/** Capitalized words that are never person names (greetings, time, office vocab). */
const COMMON_CAPITALIZED = new Set(
  [
    "morning", "afternoon", "evening", "hello", "hi", "hey", "thanks", "thank",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
    "office", "coffee", "desk", "laptop", "mug", "chair", "room", "team", "work",
    "weekend", "lunch", "kitchen", "entrance", "door", "machine", "table", "sofa",
    "sixt", "qa", "api", "apis", "backend", "frontend",
    "welcome", "good", "great", "nice", "sorry",
    "okay", "well", "just", "still", "back", "here", "there", "this", "that",
    "what", "who", "how", "when", "where", "nothing", "something", "someone",
    // Item C6 (S3): pronouns — widening the verb list must not turn
    // "She walks" into an unknown-actor hit.
    "he", "she", "they", "it", "him", "her", "them", "his", "hers",
    "their", "theirs", "we", "us", "you", "i",
  ].map((w) => w.toLowerCase()),
);

/**
 * Copulas/auxiliaries: kept in OBSERVER_SUBJECT_VERBS (observer-as-subject
 * detection) but excluded from the unknown-actor name-first audit — "The X
 * is ..." shapes are too noisy there.
 */
const NAME_AUDIT_SKIP_VERBS = new Set(["is", "was", "are", "were", "has", "had"]);

/**
 * Item C6 (S3): person-context patterns shared by the unknown-actor audit
 * and the salvage thought sanitizer (item C5). The name-first verb
 * alternation is derived from OBSERVER_SUBJECT_VERBS minus copulas — one
 * audited verb list, no drift between the two prose gates. Covers the
 * experiment holes: "Liam greets" (greet was missing), "John takes a
 * drink" (takes was missing), "Anton leans against the desk" (leans was
 * missing), plus the ask/tell/answer/thank/call/give/hand/show/meet/join/
 * follow/visit family in both verb-first and name-first positions.
 */
function buildPersonContextRes(): RegExp[] {
  const nameFirstVerbs = [...OBSERVER_SUBJECT_VERBS]
    .filter((v) => !NAME_AUDIT_SKIP_VERBS.has(v))
    .join("|");
  return [
    /\b(?:hey|hi|hello|dear|toward|towards|to|with|for|at|near|beside|behind|greets?|greeting|gives?|gave|pats?|hugs?|embraces?|handshake with|welcomes?|welcomed?|thanks?|thanked?|asks?|tells?|told?|sees?|saw|approaches?|walks?(?: closer)? to|meets?|met|joins?|joined|follows?|followed|calls?|called|shows?|showed|introduces?|introduced|hands?|handed|visits?|visited)\s+([A-Z][a-z]{2,})\b/g,
    new RegExp(`\\b([A-Z][a-z]{2,})\\s+(?:${nameFirstVerbs})\\b`, "g"),
    // Quoted vocatives: "Hey Jeff, welcome!" — the greeting verb sits inside
    // quotes with punctuation between it and the addressee (tick 5 repro).
    // Case-sensitive on purpose: with the `i` flag [A-Z] would also match
    // lowercase words ("Hi all" -> "all").
    /\b(?:[Hh]ey|[Hh]i|[Hh]ello|[Dd]ear|[Ww]elcome)\s+([A-Z][a-z]{2,})\b/g,
    // Appositives with no verb for the audit to catch ("Another day, same
    // Liam." — the tick-10 thought that implanted a false memory).
    /\b(?:same|damn|poor|old|young)\s+([A-Z][a-z]{2,})\b/g,
  ];
}

/**
 * Item C5: person names in person-context positions that match neither the
 * roster nor object vocabulary. Shared core of validateNarrativeActors
 * and the salvage thought sanitizer — exported so turnSalvage can re-run
 * the prose gates after patch-stripping.
 */
export function findUnknownPersonNames(world: World, text: string): string[] {
  const roster = new Map<string, string>();
  for (const a of world.actors) {
    roster.set(a.name.toLowerCase(), a.id);
    roster.set(a.id.toLowerCase(), a.id);
    for (const tok of a.name.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length >= 3 && !roster.has(tok)) roster.set(tok, a.id);
    }
  }
  const objectTokens = new Set<string>();
  for (const o of world.scene.objects) {
    for (const src of [o.name, o.id]) {
      for (const tok of src.toLowerCase().split(/[^a-z0-9]+/)) {
        if (tok.length >= 3) objectTokens.add(tok);
      }
    }
  }
  const suspects = new Set<string>();
  for (const re of buildPersonContextRes()) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) suspects.add(m[1]!);
  }
  const unknown: string[] = [];
  for (const s of suspects) {
    const lower = s.toLowerCase();
    if (roster.has(lower)) continue;
    if (objectTokens.has(lower)) continue;
    if (COMMON_CAPITALIZED.has(lower)) continue;
    unknown.push(s);
  }
  return unknown;
}

/**
 * Narrative name audit (exp-2 item 3, ticks 2/5/14 repro): the patch-ID
 * checks above cannot see names that appear only in prose ("walks closer to
 * Jeff" with no Jeff patch passes them). Fails the first person-context
 * name matching neither the roster nor object vocabulary (see
 * findUnknownPersonNames for the shared scan).
 */
export function validateNarrativeActors(
  world: World,
  normalized: { narrative: string; reasoning?: string },
): ValidationError[] {
  const text = `${normalized.narrative} ${normalized.reasoning ?? ""}`;
  const unknown = findUnknownPersonNames(world, text);
  if (unknown.length === 0) return [];
  return [
    {
      code: "narrative.unknown_actor",
      message: `narrative names unknown actor "${unknown[0]}" with no roster entry or patch: only the listed actors exist — describe only them, never invent or address anyone else`,
    },
  ];
}

/**
 * Exp-4 item 2 (reverse verb-drop, ticks 2/16): narrative locomotion/pose
 * verbs with no backing patch. The action-side gates check action→patch;
 * the mirror hole is the consequence *adding* "stands up, walks to the
 * kitchen" with `moved=true` and zero coordinates and passing (tick 2).
 * Require: `effects.moved=true` ⇒ position patch present; narrative
 * locomotion verb ⇒ position change; narrative pose-change verb
 * (stand up / sit down) ⇒ pose patch. Only the narrative→patch direction:
 * a movement patch with undescriptive prose (deterministic repairs) stays
 * allowed, so the repair/salvage paths keep validating.
 */
const NARRATIVE_LOCOMOTION_RE =
  /\b(walk|walks|walked|walking|go|goes|went|going|headed|heading|move|moves|moved|moving|approach|approaches|approached|approaching|enter|enters|entered|entering|leave|leaves|left|leaving|return|returns|returned|returning|advance|advances|proceed|proceeds|come|comes|came|coming|follow|follows|followed|join|joins|joined|hurry|hurries|rush|rushes|stroll|strolls|saunter|saunters|drift|drifts|sidle|sidles)\b/i;
// F34: "heads to/toward" (and the headed/heading variants) are locomotion.
const HEAD_VERB_RE = /\b(heads?\s+(to|toward|towards|for|into|out|off|over|back|down|up|north|south|east|west|through|across|along))\b/i;
const NARRATIVE_POSE_CHANGE_RE =
  /\b((stand|stands|standing|stood)\s+up\b|\bsit(s|ting)?\s+down\b|\bsat\s+down\b|\btakes?\s+a\s+seat\b|\bget(s|ting)?\s+up\b)/i;
const STAY_NEGATION_RE = /\b(stay|stays|staying|stayed|remain|remains|remaining|remained|keep|keeps|keeping|kept|continue|continues|continuing|still|without\s+(moving|standing\s+up|sitting\s+down))\b/i;

export function validateNarrativeMovementGrounding(
  world: World,
  normalized: {
    narrative: string;
    actorPatches: { actorId: string; x?: number; y?: number; pose?: string }[];
    effects?: { moved?: boolean };
  },
  action: Action,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const actor = world.actors.find((a) => a.id === action.actorId);
  const patch = normalized.actorPatches.find((p) => p.actorId === action.actorId);
  const movedPatch =
    actor !== undefined &&
    patch?.x !== undefined &&
    patch?.y !== undefined &&
    (patch.x !== actor.x || patch.y !== actor.y);
  // 1. Declared movement must move.
  if (normalized.effects?.moved === true && !movedPatch) {
    errors.push({
      code: "movement.declared_without_patch",
      message: `effects declares moved=true but acting actor (${action.actorId}) has no position change: emit x and y with a new reachable position when movement occurs — never declare movement without the patch`,
    });
  }
  // 2. Narrated locomotion must move (mask resumed activity + body-part
  // "head" + staying-negations so "return to typing", "shake his head",
  // and "stays seated" never trip this gate).
  let masked = maskResumedActivity(normalized.narrative);
  masked = masked.replace(/\b(his|her|my|your|their|its|the|a|an)\s+heads?\b/gi, " ");
  // Metaphor is not movement ("go the extra mile" — mirrors the
  // deterministic action-side mask).
  masked = masked.replace(/\bgo\s+(?:the\s+)?extra\s+mile\b/gi, " ");
  const claimsLocomotion =
    (NARRATIVE_LOCOMOTION_RE.test(masked) || HEAD_VERB_RE.test(masked)) &&
    !STAY_NEGATION_RE.test(masked);
  if (claimsLocomotion && !movedPatch) {
    errors.push({
      code: "movement.narrated_without_patch",
      message: `narrative describes movement ("${normalized.narrative.slice(0, 80)}") but acting actor (${action.actorId}) has no position change: include x and y with a new reachable position reflecting that movement — describing a walk without the patch is incomplete`,
    });
  }
  // 3. Narrated pose change must set pose ("stands up" needs pose:"stand").
  // Deliberately narrow (stand UP / sit DOWN only): "standing beside it"
  // is posture prose, not a pose change.
  if (NARRATIVE_POSE_CHANGE_RE.test(normalized.narrative) && patch?.pose === undefined) {
    errors.push({
      code: "movement.pose_change_without_patch",
      message: `narrative describes standing up/sitting down but no pose patch sets it: include pose ("stand" or "sit") on the acting actor (${action.actorId})`,
    });
  }
  return errors;
}

/**
 * Exp-3 item 5: observer-as-subject prose check (tick 13 repro). The
 * narrative must describe ONLY the acting actor — the name audit catches
 * unknown names, but a roster observer cast as the grammatical subject
 * ("Anton shakes Tanya's hand." on Tanya's turn) sails through. Split the
 * narrative into clauses (sentence boundaries and "and"-joins) and fail
 * clauses led by a roster observer's name/id directly followed by an
 * observable-action verb. Name-as-landmark ("toward Jeff") and possessives
 * ("Tanya's hand") do not match — only Name + verb.
 */
const OBSERVER_SUBJECT_VERBS = new Set(
  [
    "is", "was", "are", "were", "has", "had",
    "says", "said", "speak", "speaks", "spoke", "talks", "talked", "tells", "told",
    "asks", "asked", "replies", "replied", "answers", "answered", "shouts", "shouted",
    "whispers", "whispered", "mutters", "muttered", "calls", "called", "thanks", "thanked",
    "greets", "greeted", "welcomes", "welcomed", "waves", "waved",
    "walks", "walked", "goes", "went", "comes", "came", "moves", "moved",
    "stands", "stood", "sits", "sat", "turns", "turned", "approaches", "approached",
    "enters", "entered", "leaves", "left", "returns", "returned", "joins", "joined",
    "follows", "followed", "runs", "ran",
    "looks", "looked", "watches", "watched", "sees", "saw", "nods", "nodded",
    "smiles", "smiled", "laughs", "laughed", "shakes", "shook", "hugs", "hugged",
    "hands", "handed", "gives", "gave", "takes", "took", "picks", "picked",
    "opens", "opened", "pours", "poured", "types", "typed", "sips", "sipped",
    "gestures", "gestured", "points", "pointed", "shrugs", "shrugged",
    // Item C6 (S3): audit gaps — "Anton leans against the desk" (tick 15)
    // and "John exclaims" walked through both prose gates on these.
    "greet", "lean", "leans", "leaned", "exclaim", "exclaims", "exclaimed",
  ].map((w) => w.toLowerCase()),
);

export function validateObserverSubject(
  world: World,
  normalized: { narrative: string },
  action: Action,
): ValidationError[] {
  const observers = world.actors.filter((a) => a.id !== action.actorId);
  if (observers.length === 0) return [];
  const names: Array<{ token: string; id: string }> = [];
  for (const o of observers) {
    names.push({ token: o.name.toLowerCase(), id: o.id });
    names.push({ token: o.id.toLowerCase(), id: o.id });
    const first = o.name.toLowerCase().split(/[^a-z0-9]+/)[0];
    if (first && first.length >= 3) names.push({ token: first, id: o.id });
  }
  const clauses = normalized.narrative
    .split(/[.!?;]+\s*|\s+and\s+/i)
    .map((c) => c.replace(/^["'(\[]+/, "").trim().toLowerCase())
    .filter((c) => c.length > 0);
  for (const clause of clauses) {
    for (const { token, id } of names) {
      if (token.length < 2) continue;
      if (!clause.startsWith(token)) continue;
      const rest = clause.slice(token.length);
      // Name must be a whole word followed by whitespace + verb
      // ("Anton shakes..." matches; "Anton's hand" and "Anton," do not).
      const verbMatch = rest.match(/^\s+([a-z]+)/);
      if (!verbMatch) continue;
      if (OBSERVER_SUBJECT_VERBS.has(verbMatch[1]!)) {
        return [
          {
            code: "narrative.observer_as_subject",
            message: `narrative casts roster observer "${id}" as the acting subject ("${clause.slice(0, 60)}...") on ${action.actorId}'s turn: describe ONLY what the acting actor (${action.actorId}) observably does — observers react in thoughts patches, never in the narrative`,
          },
        ];
      }
      break; // clause starts with this observer's name but no verb — no error
    }
  }
  return [];
}
