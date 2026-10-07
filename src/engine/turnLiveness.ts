// NPC liveness floor (extracted from turnOrchestrator.ts).
//
// After N consecutive own-turn fallbacks, an actor gets a deterministic
// minimal applied turn (thoughts-only reaction) so dialogue threads keep
// moving even when bodies cannot.

import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  World,
} from "../types.js";
import { setHonestHistoryNote } from "./turnSalvage.js";

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
export function buildLivenessConsequence(
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
  setHonestHistoryNote(liveness, "liveness floor");
  return liveness;
}
