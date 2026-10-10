// NPC liveness floor (extracted from turnOrchestrator.ts).
//
// After N consecutive own-turn fallbacks, an actor gets a deterministic
// minimal applied turn (thoughts-only reaction) so dialogue threads keep
// moving even when bodies cannot.

import type {
  Action,
  ConsequenceResult,
  World,
} from "../types.js";
import { NOT_DONE_SENTINEL } from "../types.js";
import { LIVENESS_HISTORY_MARKER } from "./patchApplier.js";
import { setHonestHistoryNote } from "./turnSalvage.js";

/**
 * Exp-5 item 6: consecutive own-turn fallback streak for an actor. Counts
 * trailing history entries authored by `actorId` that are fallback-marked
 * (F22: detected via NOT_DONE_SENTINEL, never the "(not done)" substring —
 * a user-written action containing "(not done)" must not corrupt the
 * streak), stopping at that actor's first applied entry. Other actors'
 * interleaved turns don't break the streak — Tanya falling back 7 of her
 * own turns in a row is the freezer signal even when Dana's turns
 * interleave. Applied entries include salvaged/partial and liveness turns
 * (narrative-based, no sentinel marker).
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
    const text = entry.text;
    if (!prefixes.some((p) => text.startsWith(p))) continue;
    if (text.includes(NOT_DONE_SENTINEL)) streak++;
    else break;
  }
  return streak;
}

/**
 * Exp-5 item 6: deterministic liveness reaction. After N consecutive own
 * fallbacks the actor holds position with a fresh thoughts reaction, so
 * dialogue threads keep moving even when the render cannot. The liveness
 * floor is prose-only (like the render contract): a narrative plus the
 * acting actor's thoughts — no patches, no world changes beyond the
 * history entry. Bypasses validation like the fallback does — but unlike
 * the fallback it APPLIES (history records the narrative, honestly
 * marked).
 */
export function buildLivenessConsequence(
  world: World,
  action: Action,
  priorFallbacks: number,
): ConsequenceResult {
  const actor = world.actors.find((a) => a.id === action.actorId);
  const name = actor?.name ?? action.actorId;
  const liveness: ConsequenceResult = {
    narrative: `${name} holds position, taking in the room.`,
    thoughts: "Holding position and watching the room.",
    reasoning: `Liveness floor after ${priorFallbacks} consecutive fallbacks: minimal in-place reaction so the scene keeps moving.`,
  };
  setHonestHistoryNote(liveness, "liveness floor");
  return liveness;
}
