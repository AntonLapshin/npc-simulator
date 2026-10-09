// Action-text helpers for movement and prop hints (exp local-8b items).
//
// Phase 1: pure text predicates live in `src/core/` — `extractDirectionHint`
// moved to `src/core/text.ts` (re-exported here for existing importers);
// the movement-repair veto machinery is deleted with the repair path it
// served (movement is engine-owned now).

import type { World } from "../types.js";
import {
  resolveDestinationActorId,
  resolveDestinationObjectId,
} from "./deterministicSemantics.js";

// Direction hints live in the pure core now; re-exported for compat.
export type { DirectionHint } from "../core/text.js";
export { extractDirectionHint } from "../core/text.js";

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
