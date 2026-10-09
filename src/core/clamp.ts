// PLAN_V2 Phase 3 — the clamp policy, as code.
//
// When a parsed intent is physically impossible, the engine does ONE
// deterministic pass — no re-asking the LLM, no parser retries, no
// correction loops — and RECORDS the gap between attempted and executed
// so the narrator can tell the honest story ("she reaches for his hand,
// but he's across the room") instead of dropping the attempt silently or
// emitting a (not done) sentinel (that family stays dead).
//
// This module owns the policy decisions (pure functions over a world
// snapshot). The engine applies them as a thin wrapper
// (`src/engine/clampPolicy.ts`) and hands the resulting facts to the
// narrate input alongside the EXECUTED facts.

import type { ActionSemantics, World } from "../types.js";
import { distanceToRect } from "./geometry.js";
import {
  hasContactVerb,
  matchContactVerb,
  type MovementOutcome,
} from "./movement.js";
import type {
  ManipulationDiagnosis,
  ManipulationKind,
  ManipulationRejectReason,
} from "./objects.js";

/**
 * Physical contact requires adjacency — mirrors the PHYSICAL CONTACT
 * RULE in the narrate prompt ("MUST end ADJACENT ... within 2.5 cells").
 */
export const CONTACT_REACH = 2.5;

/**
 * Arrived-at-object = standing next to it. The engine never places an
 * actor inside a furniture rect, so arrival is measured to the rect edge.
 */
export const OBJECT_ARRIVAL_REACH = 1.5;

/**
 * Attempted-vs-executed for one execution channel. Present = the engine
 * clamped or rejected part of the attempt — the turn's honest gap, which
 * the narrate input must carry. Absent (null) = the channel was not
 * attempted, or executed exactly as attempted (the EXECUTED facts alone
 * suffice — no redundant block).
 */
export type AttemptRecord = {
  /** What the parsed intent tried to do (plain language). */
  attempted: string;
  /** What the engine actually did (plain language). */
  executed: string;
};

/** The turn's clamp record: one attempted-vs-executed entry per channel. */
export type TurnClamp = {
  movement: AttemptRecord | null;
  contact: AttemptRecord | null;
  manipulation: AttemptRecord | null;
};

function cells(d: number): string {
  const r = Math.round(d);
  return `${r} cell${r === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Movement channel.
// ---------------------------------------------------------------------------

export type MovementClampInput = Pick<
  ActionSemantics,
  "moves" | "destinationActorId" | "destinationObjectId" | "contactActorId"
> & {
  /** The engine's movement outcome (null = the actor stayed in place). */
  outcome: MovementOutcome | null;
};

/** Plain-language label for the named destination ("Tanya", "the desk"). */
function destinationLabel(
  world: World,
  actorId: string,
  input: MovementClampInput,
): string | null {
  const actorDestId =
    input.destinationActorId !== undefined && input.destinationActorId !== actorId
      ? input.destinationActorId
      : input.contactActorId !== undefined && input.contactActorId !== actorId
        ? input.contactActorId
        : undefined;
  if (actorDestId !== undefined) {
    const t = world.actors.find((a) => a.id === actorDestId);
    return t?.name ?? actorDestId;
  }
  if (input.destinationObjectId !== undefined) {
    const o = world.scene.objects.find((o) => o.id === input.destinationObjectId);
    return o !== undefined ? `the ${o.name}` : input.destinationObjectId;
  }
  return null;
}

/**
 * Clamp policy, movement channel. The step itself is already clamped by
 * the engine (closest reachable cell per turn, never stacking, never a
 * teleport — see suggestStep); this function only records the honest gap
 * when the named destination was not fully reached.
 *
 * Returns null when no locomotion was attempted, or when the destination
 * was reached (the EXECUTED MOVEMENT facts say it — nothing to add).
 */
export function clampMovement(
  world: World,
  actorId: string,
  input: MovementClampInput,
): AttemptRecord | null {
  if (!input.moves) return null;
  const actor = world.actors.find((a) => a.id === actorId);
  const name = actor?.name ?? actorId;
  const label = destinationLabel(world, actorId, input);
  const attempted =
    label !== null ? `${name} tried to walk to ${label}.` : `${name} tried to move.`;
  const outcome = input.outcome;
  if (outcome === null) {
    // Stayed in place: no legal step (boxed in, blocked, or already
    // adjacent) — the attempt is recorded, the position is unchanged.
    return {
      attempted,
      executed:
        `${name} stayed in place — no legal step` +
        (label !== null ? ` toward ${label}` : "") +
        ` this turn.`,
    };
  }
  const finalPos = { x: outcome.x, y: outcome.y };
  const moved = Math.hypot(outcome.x - outcome.from.x, outcome.y - outcome.from.y);
  // Actor destination (explicit or contact-approach): arrived = adjacent.
  const actorDestId =
    input.destinationActorId !== undefined && input.destinationActorId !== actorId
      ? input.destinationActorId
      : input.contactActorId !== undefined && input.contactActorId !== actorId
        ? input.contactActorId
        : undefined;
  if (actorDestId !== undefined) {
    const target = world.actors.find((a) => a.id === actorDestId);
    if (target === undefined) return null;
    const remaining = Math.hypot(finalPos.x - target.x, finalPos.y - target.y);
    if (remaining <= CONTACT_REACH + 1e-9) return null; // reached — EXECUTED MOVEMENT says it
    return {
      attempted,
      executed:
        `${name} moved ${cells(moved)} toward ${label} but is still ` +
        `${cells(remaining)} away — too far to touch.`,
    };
  }
  // Object destination: arrived = standing next to it.
  if (input.destinationObjectId !== undefined) {
    const obj = world.scene.objects.find((o) => o.id === input.destinationObjectId);
    if (obj === undefined) return null;
    const remaining = distanceToRect(finalPos.x, finalPos.y, obj);
    if (remaining <= OBJECT_ARRIVAL_REACH + 1e-9) return null; // reached
    return {
      attempted,
      executed:
        `${name} moved ${cells(moved)} toward ${label}, ` +
        `still ${cells(remaining)} from it.`,
    };
  }
  // Undirected movement executed as planned — the EXECUTED MOVEMENT
  // facts suffice.
  return null;
}

// ---------------------------------------------------------------------------
// Contact channel.
// ---------------------------------------------------------------------------

export type ContactClampInput = {
  /** Resolved contact target (undefined = no contact attempted). */
  targetActorId?: string;
  /** Engine-dictated exact quote (null = no quoted speech). */
  exactQuote: string | null;
  /** Engine movement outcome (null = the actor stayed in place). */
  outcome: MovementOutcome | null;
};

/** Canonical infinitive for a matched contact-verb span. */
function contactVerbInfinitive(matched: string): string {
  const m = matched.toLowerCase();
  if (/\bhandshake\b/.test(m) || /\bshak/.test(m)) return "shake hands with";
  if (/\bhug/.test(m)) return "hug";
  if (/\bembrace/.test(m)) return "embrace";
  if (/\bkiss/.test(m)) return "kiss";
  if (/\bhigh/.test(m)) return "give a high-five to";
  if (/\bfist/.test(m)) return "fist-bump";
  if (/\bpat\b/.test(m) || /\bpats\b/.test(m)) return "pat";
  if (/\bslap/.test(m)) return "slap";
  if (/\bpunch/.test(m)) return "punch";
  return "make physical contact with";
}

/**
 * Speech verbs that let an impossible contact convert to calling out —
 * the character addresses the distant person instead of touching them.
 * A quoted utterance always allows it (speaking IS the fallback).
 */
const CALL_OUT_VERB_RE = /\b(calls?|shouts?|yells?|cries|hollers?)\b/i;

export function allowsCallOut(actionText: string, exactQuote: string | null): boolean {
  return exactQuote !== null || CALL_OUT_VERB_RE.test(actionText);
}

/**
 * Clamp policy, contact channel: contact beyond reach is recorded, never
 * teleported. Where the verbs allow, the contact converts to calling
 * out; otherwise it fails gracefully — and the record is honest either
 * way. One pass, no retries.
 *
 * Returns null when no contact was attempted, or when contact was
 * achieved (adjacent after the engine's move — the EXECUTED facts and
 * the narrative show it).
 */
export function clampContact(
  world: World,
  actorId: string,
  actionText: string,
  input: ContactClampInput,
): AttemptRecord | null {
  const targetId = input.targetActorId;
  if (targetId === undefined || targetId === actorId) return null;
  // The contact channel owns touch verbs only — "give the report to
  // Tanya" is the manipulation channel's (hand-over), not a contact
  // attempt.
  if (!hasContactVerb(actionText)) return null;
  const actor = world.actors.find((a) => a.id === actorId);
  const target = world.actors.find((a) => a.id === targetId);
  if (actor === undefined || target === undefined) return null;
  const name = actor.name ?? actorId;
  const targetName = target.name ?? targetId;
  const verb = contactVerbInfinitive(matchContactVerb(actionText) ?? "");
  const finalPos =
    input.outcome !== null
      ? { x: input.outcome.x, y: input.outcome.y }
      : { x: actor.x, y: actor.y };
  const finalDist = Math.hypot(finalPos.x - target.x, finalPos.y - target.y);
  if (finalDist <= CONTACT_REACH + 1e-9) return null; // contact achieved
  const startDist = Math.hypot(actor.x - target.x, actor.y - target.y);
  const attempted = `${name} tried to ${verb} ${targetName}.`;
  if (allowsCallOut(actionText, input.exactQuote)) {
    const quote =
      input.exactQuote !== null ? ` ("${input.exactQuote}")` : "";
    return {
      attempted,
      executed:
        `${name} could not reach ${targetName} — ${cells(startDist)} away, ` +
        `beyond contact reach. No contact happened; ${name} called out ` +
        `to ${targetName} instead${quote}.`,
    };
  }
  return {
    attempted,
    executed:
      `${name} reached toward ${targetName}, but ${targetName} is ` +
      `${cells(startDist)} away — beyond contact reach. No contact happened.`,
  };
}

// ---------------------------------------------------------------------------
// Manipulation channel.
// ---------------------------------------------------------------------------

/** Plain-language "tried to …" for the rejected manipulation. */
function manipulationAttempted(
  name: string,
  implied: ManipulationKind | null,
  subject: string | null,
  targetName: string | undefined,
): string {
  if (implied === null)
    return `${name} tried to do several things with objects at once.`;
  if (implied === "pick-up")
    return subject !== null
      ? `${name} tried to pick up the ${subject}.`
      : `${name} tried to pick something up.`;
  if (implied === "put-down")
    return subject !== null
      ? `${name} tried to put down the ${subject}.`
      : `${name} tried to put something down.`;
  if (implied === "hand-over") {
    const what = subject !== null ? `the ${subject}` : "something";
    return targetName !== undefined
      ? `${name} tried to hand ${what} over to ${targetName}.`
      : `${name} tried to hand ${what} over.`;
  }
  return `${name} tried to hand something over.`;
}

/** Plain-language "could not — …" for the rejection reason. */
function manipulationRejected(
  name: string,
  reason: ManipulationRejectReason,
  subject: string | null,
  heldProp: string | null,
  targetName: string | undefined,
  distance: number | null,
): string {
  const target = targetName ?? "them";
  switch (reason) {
    case "hands-full":
      return `${name} could not — their hands are already full` +
        (heldProp !== null ? ` (holding the ${heldProp}).` : ".");
    case "nothing-held":
      return `${name} could not — they are holding nothing.`;
    case "object-too-far":
      return `${name} could not — the ${subject ?? "object"} is ` +
        `${distance !== null ? cells(distance) : "too far"} away, beyond reach.`;
    case "no-such-object":
      return `${name} could not — there is no ${subject ?? "such object"} to pick up.`;
    case "no-recipient":
      return `${name} could not — no one to hand it to is named.`;
    case "recipient-too-far":
      return `${name} could not — ${target} is ` +
        `${distance !== null ? cells(distance) : "too far"} away, too far to hand anything to.`;
    case "recipient-hands-full":
      return `${name} could not — ${target}'s hands are already full.`;
    case "ambiguous":
      return `${name} could not — one manipulation per turn; the rest is dropped.`;
    case "unknown-actor":
      return `${name} could not — unknown actor.`;
  }
}

/**
 * Clamp policy, manipulation channel: a manipulation the action implied
 * but the engine rejected (distant object, empty hands, far recipient…)
 * fails gracefully and is recorded — the narrator gets the honest beat
 * ("she reaches for the cup, but it's across the room") instead of a
 * silent drop.
 *
 * Returns null when the manipulation executed, or when the action
 * implied none.
 */
export function clampManipulation(
  world: World,
  actorId: string,
  diagnosis: ManipulationDiagnosis,
): AttemptRecord | null {
  if (diagnosis.kind !== "rejected") return null;
  const actor = world.actors.find((a) => a.id === actorId);
  const name = actor?.name ?? actorId;
  const targetName =
    diagnosis.targetActorId !== undefined
      ? (world.actors.find((a) => a.id === diagnosis.targetActorId)?.name ??
        diagnosis.targetActorId)
      : undefined;
  return {
    attempted: manipulationAttempted(name, diagnosis.implied, diagnosis.subject, targetName),
    executed: manipulationRejected(
      name,
      diagnosis.reason,
      diagnosis.subject,
      diagnosis.heldProp,
      targetName,
      diagnosis.distance,
    ),
  };
}

// ---------------------------------------------------------------------------
// Narrate-input rendering.
// ---------------------------------------------------------------------------

/**
 * Render the turn's clamp record as narrate-input fact lines: the
 * ATTEMPTED vs EXECUTED block. Only channels with an honest gap appear —
 * a null record means "executed as attempted" and needs no block.
 * Pure.
 */
export function describeClamp(
  _world: World,
  _actorId: string,
  clamp: TurnClamp,
): string[] {
  const lines = [
    "ATTEMPTED vs EXECUTED (engine-recorded — the turn's honest gap. " +
      "Narrate exactly this: the attempt happened and fell short as described. " +
      "Never smooth it into success, never drop it silently, never emit (not done)):",
  ];
  const push = (label: string, record: AttemptRecord | null): void => {
    if (record === null) return;
    lines.push(`- ${label} — ATTEMPTED: ${record.attempted}`);
    lines.push(`  EXECUTED: ${record.executed}`);
  };
  push("MOVEMENT", clamp.movement);
  push("CONTACT", clamp.contact);
  push("MANIPULATION", clamp.manipulation);
  return lines;
}
