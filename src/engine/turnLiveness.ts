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
import { NOT_DONE_SENTINEL } from "../types.js";
import { LIVENESS_HISTORY_MARKER } from "./patchApplier.js";
import { setHonestHistoryNote } from "./turnSalvage.js";
import { suggestionCore } from "./contextBuilder.js";

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
 * Exp-3 item 6 (S2): consecutive own-turn fallback streak for a SPECIFIC
 * intent key (`verb|noun` from suggestionCore — "shake|tanya",
 * "push|chair"). History-derived, so it survives save/load (unlike an
 * in-memory Map on EngineDependencies). Walks history from the tail; for
 * entries authored by this actor: sentinel-marked fallbacks extract the
 * action text after "tried: ", key it, and increment on match
 * (non-matching fallback intents are skipped, not breaking — the actor may
 * fail a handshake, succeed at walking, then fail the handshake again);
 * the first applied own entry (no sentinel — including salvaged/partial
 * turns, which prove the consequence tier rendered something) breaks the
 * streak.
 *
 * Exp-4 item 7 (S3): liveness-floor entries are skipped, never breaking —
 * they bypass validation, so they prove nothing about the banned intent
 * (exp-4: the tick-19 liveness turn reset the "move|anton" streak and the
 * same intent failed a third time at tick 22).
 */
export function consecutiveIntentFailures(
  world: World,
  actorId: string,
  intentKey: string,
): number {
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
    // Exp-4 item 7 (S3): the liveness floor is validation-bypassing
    // synthetic progress — skip it without breaking the streak.
    if (text.includes(LIVENESS_HISTORY_MARKER)) continue;
    if (!text.includes(NOT_DONE_SENTINEL)) break;
    // Fallback format: "<name> tried: <action text> (not done)<sentinel>".
    const beforeSentinel = text.split(NOT_DONE_SENTINEL)[0] ?? "";
    const triedIdx = beforeSentinel.indexOf(" tried: ");
    if (triedIdx < 0) continue;
    let actionText = beforeSentinel.slice(triedIdx + " tried: ".length);
    const notDone = " (not done)";
    if (actionText.endsWith(notDone)) actionText = actionText.slice(0, -notDone.length);
    if (suggestionCore(world, actionText, actorId) === intentKey) streak++;
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
