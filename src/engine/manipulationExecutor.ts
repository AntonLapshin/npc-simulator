// Engine-owned objects and props (Phase 3 of the renderer architecture).
//
// The model never emits objectPatches or prop patches: the engine plans
// the acting actor's pick-up/put-down/hand-over deterministically from
// the action text (plus the merged semantics' contact), applies it to the
// acting actor (and the hand-over recipient) only, and hands the executed
// manipulation to the consequence (render) call as facts to narrate. This
// module is the business-logic wrapper — sequencing, semantics, world
// reads, patch merge — over the pure core in `src/core/objects.ts`, which
// owns every planning decision, mirroring `movementExecutor.ts` /
// `speechExecutor.ts`.
//
// The old prop-stub repair (in-loop stub + salvage stub) is subsumed by
// this executor and deleted: instead of repairing a forgotten prop patch
// after validation fails, the engine executes the manipulation before
// validation runs — there is no forgotten patch left to repair.

import type {
  Action,
  ActionSemantics,
  World,
} from "../types.js";
import {
  assertManipulationInvariants,
  describeManipulation,
  planManipulation,
  resolveContactMention,
  type ManipulationPlan,
} from "../core/objects.js";
import { buildManipulationSnapshot } from "./objects.js";

export type { ManipulationPlan };

/** What the engine executed this turn: the plan plus its world effects. */
export type ManipulationOutcome = {
  plan: ManipulationPlan;
  /** Prop assignments: the acting actor always; the recipient on hand-over. */
  actorProps: Array<{ actorId: string; prop: string | null }>;
  /**
   * Stage-1 A3: scene-object link assignments. Pick-up links the object,
   * put-down clears the link, hand-over transfers it to the recipient —
   * so the movement applier can carry the exact object and later turns
   * never re-link by proximity.
   */
  heldObjectIds: Array<{ actorId: string; heldObjectId: string | null }>;
  /** Scene-object relocations (objectId → holder's cell). */
  objectMoves: Array<{ objectId: string; x: number; y: number }>;
};

/**
 * Execute one turn's manipulation for the acting actor.
 *
 * Returns the outcome (plan + prop assignments + object relocations), or
 * null when the action implies no manipulation, the guards reject it
 * (not pickable, out of reach, hands full, ambiguous multi-manipulation),
 * or a core invariant is violated (an engine bug — the caller logs it
 * loudly instead of applying a corrupt outcome).
 *
 * `semantics` is the pre-parsed contact from the turn loop when it has
 * one (PLAN_V2 Phase 2: the Laya parser's contactActorId); otherwise the
 * deterministic text mention is used (the turn-start pre-pass). When
 * absent the text path runs exactly as before (v1, and the fail-open
 * fallback when Laya is down/unavailable).
 */
export function executeManipulation(
  world: World,
  action: Action,
  semantics?: Pick<ActionSemantics, "contactActorId">,
): ManipulationOutcome | null {
  const snapshot = buildManipulationSnapshot(world);
  const contact =
    semantics?.contactActorId ??
    resolveContactMention(snapshot.actors, action.actorId, action.text) ??
    undefined;
  const plan = planManipulation(snapshot, action.actorId, action.text, contact);
  if (plan === null) return null;
  // Engine-output invariants (Phase 1 pattern: the physicalValidator's
  // object checks become these assertions, not retry triggers).
  if (assertManipulationInvariants(snapshot, plan).length > 0) return null;

  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!actor) return null;
  const actorProps: ManipulationOutcome["actorProps"] = [
    {
      actorId: action.actorId,
      prop: plan.kind === "pick-up" ? plan.propName : null,
    },
  ];
  // Stage-1 A3: the scene-object link follows the prop. Pick-up links the
  // manipulated object; put-down clears the link; hand-over transfers it
  // to the recipient (identity preserved — no proximity re-linking).
  const heldObjectIds: ManipulationOutcome["heldObjectIds"] = [
    {
      actorId: action.actorId,
      heldObjectId: plan.kind === "pick-up" ? plan.objectId : null,
    },
  ];
  if (plan.kind === "hand-over" && plan.targetActorId !== undefined) {
    actorProps.push({ actorId: plan.targetActorId, prop: plan.propName });
    heldObjectIds.push({
      actorId: plan.targetActorId,
      heldObjectId: plan.objectId,
    });
  }
  const objectMoves: ManipulationOutcome["objectMoves"] = [];
  if (plan.objectId !== null) {
    // The manipulated object travels with its holder: pick-up brings it
    // to the actor, put-down leaves it at the actor's feet, hand-over
    // moves it to the recipient. (Documented approximation: "on the desk"
    // is the actor's cell next to the desk, not inside the desk rect.)
    const holder =
      plan.kind === "hand-over" && plan.targetActorId !== undefined
        ? world.actors.find((a) => a.id === plan.targetActorId)
        : actor;
    if (holder !== undefined) {
      objectMoves.push({ objectId: plan.objectId, x: holder.x, y: holder.y });
    }
  }
  return { plan, actorProps, heldObjectIds, objectMoves };
}

export type IgnoredObjectPatch = {
  kind: "objectPatch";
  objectId: string;
  patch: Record<string, unknown>;
};

export type IgnoredPropPatch = {
  kind: "prop";
  actorId: string;
  prop: unknown;
};


/**
 * Fact lines describing the executed manipulation for the consequence
 * (render) input, so the render call narrates what actually happened:
 * "Dana now holds the laptop." Mirrors `executedMovementFacts` /
 * `exactQuoteFacts`.
 */
export function executedManipulationFacts(
  world: World,
  actorId: string,
  outcome: ManipulationOutcome | null,
): string[] {
  const actor = world.actors.find((a) => a.id === actorId);
  const name = actor?.name ?? actorId;
  const ownershipLine =
    "Do NOT emit objectPatches and never set 'prop' on any actor: manipulation is executed " +
    "by the engine, and any objectPatches or prop you emit are ignored.";
  if (outcome === null) {
    return [
      `EXECUTED MANIPULATION: none — the engine executed no pick-up/put-down/hand-over for ${name} this turn.`,
      ownershipLine,
    ];
  }
  const targetName =
    outcome.plan.targetActorId !== undefined
      ? (world.actors.find((a) => a.id === outcome.plan.targetActorId)?.name ??
        outcome.plan.targetActorId)
      : undefined;
  return [
    "EXECUTED MANIPULATION (the engine already executed this manipulation — narrate exactly this, do not invent other manipulations):",
    describeManipulation(outcome.plan, name, targetName),
    ownershipLine,
  ];
}
