// Action-text movement hints for the deterministic movement repair
// (exp local-8b item C7 / S1).
//
// suggestMoveTarget used to score "nearest step first" over an x-ascending
// scan when the model declared no destination — so "walk east" repairs
// stepped WEST. These pure helpers parse the action text itself (parsed
// destinations reuse the existing word-boundary mention utils in
// deterministicSemantics) so the repair steers toward what the action
// actually says. Pure: no I/O, no world mutation.

import type { World } from "../types.js";
import {
  findDestinationMentionedActors,
  resolveDestinationActorId,
  resolveDestinationObjectId,
} from "./deterministicSemantics.js";

/** Approach/contact verbs: the narrative names a target it moves toward. */
const NARRATIVE_APPROACH_RE =
  /\b(walks?|steps?|moves?|heads?|goes?|approaches?|greets?|offers?|hands?|shakes?|turns?\s+to(?:ward)?)\b/i;

/**
 * Exp-3 item 7 (S5, A3): veto a movement-repair suggestion that steps AWAY
 * from the narrative's named approach target. Returns the suggestion
 * unchanged when no veto applies, null when vetoed. Veto-only for v1 (no
 * re-steering) — a wrong-direction repair is worse than a retry, and the
 * retry loop / salvage path will handle the turn instead.
 */
export function vetoAwayFromNarrativeTarget(
  world: World,
  actingActorId: string,
  narrative: string,
  suggestion: { x: number; y: number },
): { x: number; y: number } | null {
  const tp = narrativeTargetPosition(world, actingActorId, narrative);
  if (tp === null) return suggestion;
  const actor = world.actors.find((a) => a.id === actingActorId);
  if (!actor) return suggestion;
  const oldD = Math.hypot(actor.x - tp.x, actor.y - tp.y);
  const newD = Math.hypot(suggestion.x - tp.x, suggestion.y - tp.y);
  if (newD > oldD + 1e-9) return null;
  return suggestion;
}

/**
 * Exp-4 item 5 (S2): the narrative's named approach target as a scene
 * position, or null when the narrative names none / it can't be resolved.
 * Shared by the veto above and the constructive re-steer (a vetoed repair
 * is replaced by a capped step TOWARD this point instead of a retry loop).
 * Pure.
 */
export function narrativeTargetPosition(
  world: World,
  actingActorId: string,
  narrative: string,
): { x: number; y: number } | null {
  const target = narrativeApproachTarget(world, actingActorId, narrative);
  if (target === null) return null;
  if (target.kind === "actor") {
    const t = world.actors.find((a) => a.id === target.id);
    return t !== undefined ? { x: t.x, y: t.y } : null;
  }
  const o = world.scene.objects.find((o) => o.id === target.id);
  return o !== undefined ? { x: o.x + o.w / 2, y: o.y + o.h / 2 } : null;
}

/**
 * Exp-3 item 7 (S5, A3 — tick-28 repro): the approach target the NARRATIVE
 * names, for the post-repair direction invariant. The repair steers by the
 * action text, but the narrative is the model's own account of what the
 * turn did — when the narrative says "walks over to Anton and greets him"
 * while the repair stepped AWAY from Anton, the repair is corrupt and must
 * be vetoed (a wrong-direction repair is worse than a retry). Actor
 * mentions win (person is the stronger signal); object targets only count
 * when the narrative carries approach/contact verbs. Pure.
 */
export function narrativeApproachTarget(
  world: World,
  actingActorId: string,
  narrative: string,
): NamedDestination | null {
  const mentioned = findDestinationMentionedActors(world, actingActorId, narrative);
  if (mentioned.length > 0) return { kind: "actor", id: mentioned[0]! };
  if (!NARRATIVE_APPROACH_RE.test(narrative)) return null;
  const obj = resolveDestinationObjectId(world, narrative, actingActorId);
  if (obj !== undefined) return { kind: "object", id: obj };
  return null;
}

/** Cardinal direction hint parsed from action text. */
export type DirectionHint = "north" | "south" | "east" | "west";

/**
 * First cardinal direction named in the text ("a few steps east" →
 * "east"). Word-boundary matched; null when no direction is named.
 * Diagonal compounds ("north-east") are out of scope — the first cardinal
 * word wins, which is enough for repair tie-breaking.
 */
export function extractDirectionHint(text: string): DirectionHint | null {
  const m = /\b(north|south|east|west)\b/i.exec(text);
  if (!m) return null;
  return m[1]!.toLowerCase() as DirectionHint;
}

export type NamedDestination = { kind: "actor" | "object"; id: string };

/**
 * Actor or landmark the action text names as a movement target ("walk
 * toward Ana", "head to the coffee machine"). Actor destinations win over
 * object destinations (a person is the stronger steering signal).
 * Word-boundary matching via the existing mention utils — a bare
 * substring never matches ("dan" ≠ "Dana"). Null when the text names no
 * movement target.
 */
export function resolveNamedDestination(
  text: string,
  world: World,
  actorId: string,
): NamedDestination | null {
  const actor = resolveDestinationActorId(world, actorId, text);
  if (actor !== undefined) return { kind: "actor", id: actor };
  const obj = resolveDestinationObjectId(world, text, actorId);
  if (obj !== undefined) return { kind: "object", id: obj };
  return null;
}

// ---------------------------------------------------------------------------
// Exp-2 item 4: prop auto-hints.
//
// Small models narrate prop use (typing, sipping) without emitting the
// prop patch convention — and invent holder ids ("cup" at (4,4)) instead
// of using roster object ids (exp-2 M5: zero applied object patches in 21
// turns). These pure helpers detect prop-bearing activity in the action
// text and name the exact roster object ids, so the prompt can demand the
// patch convention up front instead of punishing its absence later.
// Surfaced to the consequence prompt by the consequence engine
// (llmConsequenceEngine), alongside the static PROP AUTO-HINTS examples in
// the prompt suffix.
// ---------------------------------------------------------------------------

/** Verbs of computer work — the actor holds a laptop while doing these. */
const LAPTOP_ACTIVITY_RE =
  /\b(typ(?:e|es|ed|ing)?|keyboard(?:s|ed|ing)?|cod(?:e|es|ed|ing)|program(?:s|med|ming)?|hack(?:s|ed|ing)?)\b/i;
/** Drinking verbs — the actor holds a cup/mug while doing these. */
const DRINK_VERB_RE =
  /\b(sip(?:s|ped|ping)?|drink(?:s|ing)?|drank|slurp(?:s|ed|ing)?|gulp(?:s|ed|ing)?)\b/i;
/** Hold/carry verbs that imply a prop only alongside an explicit cup/mug noun. */
const HOLD_VERB_RE =
  /\b(hold(?:s|ing)?|held|carr(?:y|ies|ied|ying)|grab(?:s|bed|bing)?|pick(?:s|ed|ing)?(?:\s+up)?)\b/i;
const CUP_NOUN_RE = /\b(cup|mug|coffee|tea|cocoa|water)\b/i;
const LAPTOP_KIND_RE = /laptop/i;
const MUG_KIND_RE = /mug|cup/i;

/**
 * Roster object of a kind for the hint's id note: the actor-owned one
 * first ("ana_laptop" for Ana), else the scene-unique match (the shared
 * "coffee_mug"), else undefined — in which case the hint demands the prop
 * without naming an id, so the model never invents one.
 */
function findKindObject(
  world: World,
  actorId: string,
  kind: RegExp,
): { id: string; name: string } | undefined {
  const matches = world.scene.objects.filter((o) => kind.test(o.id) || kind.test(o.name));
  const lowered = actorId.toLowerCase();
  const owned = matches.find((o) => o.id.toLowerCase().includes(lowered));
  const pick = owned ?? (matches.length === 1 ? matches[0] : undefined);
  return pick !== undefined ? { id: pick.id, name: pick.name } : undefined;
}

/**
 * Exp-2 item 4: compact prop auto-hint for the consequence prompt, or
 * undefined when the action carries no prop-bearing activity.
 *
 * - typing / computer work → prop:"laptop" (+ the actor's laptop id)
 * - sipping / drinking / holding a cup or mug → prop:"cup" (+ the mug id)
 *
 * The hint names exact roster object ids so the model emits the patch
 * convention instead of inventing holder ids. One line per hint: tokens
 * are a budget, not a virtue.
 */
export function buildPropHint(
  actionText: string,
  world: World,
  actorId: string,
): string | undefined {
  if (LAPTOP_ACTIVITY_RE.test(actionText)) {
    const laptop = findKindObject(world, actorId, LAPTOP_KIND_RE);
    const idNote = laptop !== undefined ? ` (their laptop is "${laptop.id}")` : "";
    return (
      `PROP HINT: typing/working on a computer means the actor holds it — set "prop":"laptop" ` +
      `on the acting actor's patch${idNote}; never narrate computer work with empty hands, ` +
      `and never invent a laptop id.`
    );
  }
  if (DRINK_VERB_RE.test(actionText) || (HOLD_VERB_RE.test(actionText) && CUP_NOUN_RE.test(actionText))) {
    const mug = findKindObject(world, actorId, MUG_KIND_RE);
    const idNote = mug !== undefined ? ` (the mug here is "${mug.id}")` : "";
    return (
      `PROP HINT: sipping/drinking from or holding a cup or mug means the actor holds it — set ` +
      `"prop":"cup" on the acting actor's patch${idNote}; a bare "cup" is not an object id — ` +
      `use the exact ids from the context, never invented ones.`
    );
  }
  return undefined;
}
