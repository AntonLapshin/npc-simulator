import type { Action, ConsequenceResult, EngineConfig, World } from "../types.js";
import { defaultConfig } from "../config.js";
import { cloneWorld } from "./worldStore.js";

/**
 * Apply a validated ConsequenceResult to produce the next World:
 * actor positions/strings, appended memories/beliefs/relationships,
 * object updates, world history entries, and trimming.
 * Assumes the result already passed validateConsequence.
 */
export type ApplyConsequenceOptions = {
  /**
   * Exp-4 item 6: the turn fell back ("Nothing changes.") — record the
   * attempt separately from the world ("Anton tried: … (not done)") so
   * proposal/selection ground on what happened, not the wish. Fallback
   * entries never count as answers, own actions, or open questions
   * (see contextBuilder filtering).
   */
  fallback?: boolean;
  /**
   * Exp-5 item 2: the applied consequence dropped content (tier-1/2 salvage)
   * or is a deterministic liveness reaction — record the NARRATIVE (what
   * happened) plus this note ("partial: <warnings>" / "liveness floor"),
   * never the raw action text (the wish). Later proposals ground on the
   * fiction otherwise (tick 16 assumed the laptop setup was underway).
   * Takes effect only for non-fallback turns.
   */
  honestHistoryNote?: string;
};

/** Marker suffix for un-applied fallback history entries (Exp-4 item 6). */
export const FALLBACK_HISTORY_MARKER = "(not done)";

/** Marker for salvaged/liveness history entries recorded from the narrative (Exp-5 item 2). */
export const PARTIAL_HISTORY_MARKER = "(partial)";

export function isFallbackHistoryEntry(entry: string): boolean {
  return entry.includes(FALLBACK_HISTORY_MARKER);
}

export function isPartialHistoryEntry(entry: string): boolean {
  return !isFallbackHistoryEntry(entry) && entry.includes(PARTIAL_HISTORY_MARKER);
}

export function applyConsequence(
  world: World,
  result: ConsequenceResult,
  action: Action,
  config: EngineConfig = defaultConfig,
  opts: ApplyConsequenceOptions = {},
): World {
  const next = cloneWorld(world);
  const actorById = new Map(next.actors.map((a) => [a.id, a]));
  const objectById = new Map(next.scene.objects.map((o) => [o.id, o]));

  for (const patch of result.actorPatches) {
    const actor = actorById.get(patch.actorId);
    if (!actor) continue;
    if (patch.x !== undefined && patch.y !== undefined) {
      actor.x = patch.x;
      actor.y = patch.y;
    }
    if (patch.state !== undefined) actor.state = patch.state;
    if (patch.emotion !== undefined) actor.emotion = patch.emotion;
    if (patch.goal !== undefined) actor.goal = patch.goal;
    if (patch.pose !== undefined) actor.pose = patch.pose;
    if (patch.prop !== undefined) actor.prop = patch.prop;
    if (patch.thoughts !== undefined) actor.thoughts = patch.thoughts;
    if (patch.memoriesAppend) actor.memories.push(...patch.memoriesAppend);
    if (patch.beliefsAppend) actor.beliefs.push(...patch.beliefsAppend);
    if (patch.relationshipsAppend) actor.relationships.push(...patch.relationshipsAppend);

    // Trim memory arrays. Phase 5: beliefs/relationships are capped too
    // (previously unbounded — compounding state is what drowns long runs);
    // prompt rendering summarizes instead of trimming, so nothing is lost
    // from the model's view when these caps drop old entries.
    if (actor.memories.length > config.maxMemoriesPerActor) {
      actor.memories.splice(0, actor.memories.length - config.maxMemoriesPerActor);
    }
    if (actor.beliefs.length > config.maxBeliefsPerActor) {
      actor.beliefs.splice(0, actor.beliefs.length - config.maxBeliefsPerActor);
    }
    if (actor.relationships.length > config.maxRelationshipsPerActor) {
      actor.relationships.splice(0, actor.relationships.length - config.maxRelationshipsPerActor);
    }
  }

  for (const patch of result.objectPatches) {
    const obj = objectById.get(patch.objectId);
    if (!obj) continue;
    if (patch.description !== undefined) obj.description = patch.description;
    if (patch.x !== undefined) obj.x = patch.x;
    if (patch.y !== undefined) obj.y = patch.y;
    if (patch.w !== undefined) obj.w = patch.w;
    if (patch.h !== undefined) obj.h = patch.h;
    if (patch.passable !== undefined) obj.passable = patch.passable;
    if (patch.blocksVision !== undefined) obj.blocksVision = patch.blocksVision;
    if (patch.blocksSound !== undefined) obj.blocksSound = patch.blocksSound;
  }

  const actorName = actorById.get(action.actorId)?.name ?? action.actorId;
  // Single history entry per turn: the acting actor's action text, with no
  // tick prefix. The consequence narrative is logged (consequence_completed)
  // but not duplicated here — it must describe only the acting actor
  // (see TURN DISCIPLINE) so repeating it would double-report the turn.
  // UI layers show this entry only when the viewer can perceive the actor.
  // Exp-4 item 6: fallback attempts are marked as un-applied so later
  // proposals don't assume Anton sits at his desk / the task was explained.
  // Exp-5 item 2: salvaged/liveness turns record the narrative + note so
  // later turns don't assume a dropped question was asked.
  if (opts.fallback) {
    next.history.push(`${actorName} tried: ${action.text} ${FALLBACK_HISTORY_MARKER}`);
  } else if (opts.honestHistoryNote !== undefined) {
    next.history.push(`${actorName}: ${result.narrative} ${PARTIAL_HISTORY_MARKER} [${opts.honestHistoryNote}]`);
  } else {
    next.history.push(`${actorName}: ${action.text}`);
  }
  if (next.history.length > config.maxHistoryEntries) {
    next.history.splice(0, next.history.length - config.maxHistoryEntries);
  }

  return next;
}
