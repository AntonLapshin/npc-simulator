import type { Action, ConsequenceResult, EngineConfig, HistoryEntry, World } from "../types.js";
import { NOT_DONE_SENTINEL, normalizeHistoryEntry } from "../types.js";
import { defaultConfig } from "../config.js";
import { cloneWorld } from "./worldStore.js";
import { perceiverIds } from "./validate/narrative.js";
import { resolveDestinationObjectId } from "./deterministicSemantics.js";

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

/** Marker suffix for un-applied fallback history entries (Exp-4 item 6). Kept human-readable; F22: only the sentinel is parsed. */
export const FALLBACK_HISTORY_MARKER = "(not done)";

/** Marker for salvaged/liveness history entries recorded from the narrative (Exp-5 item 2). */
export const PARTIAL_HISTORY_MARKER = "(partial)";

function entryText(entry: HistoryEntry | string): string {
  return typeof entry === "string" ? entry : entry.text;
}

/** F22: fallback entries are detected via NOT_DONE_SENTINEL, never the "(not done)" substring. */
export function isFallbackHistoryEntry(entry: HistoryEntry | string): boolean {
  return entryText(entry).includes(NOT_DONE_SENTINEL);
}

/**
 * Item C3 (exp local-8b): deterministic one-line memory from the turn's
 * narrative (~160 chars total). The local-8b tier never emits
 * memoriesAppend (M8), so P8 ("memory compounds") fails without this.
 * Pure.
 */
export function summarizeNarrativeForMemory(narrative: string, actorName: string): string {
  const oneLine = narrative.replace(/\s+/g, " ").trim();
  const prefix = `${actorName}: `;
  const budget = 160 - prefix.length;
  const body =
    oneLine.length > budget && budget > 0 ? `${oneLine.slice(0, budget - 1)}…` : oneLine;
  return `${prefix}${body}`;
}

/**
 * Exp-3 item 8 (S6): describe a position for the auto-filled `state`
 * string. Nearest landmark within 6 cells, with three fixes over the old
 * "near the <lowercased name>":
 * - tiers: furniture (desk/chair/machine/table/sofa) beats loose props —
 *   and signs/walls are never landmarks ("near the dana's desk sign" was
 *   a label, not a place);
 * - grammar: possessive names keep their original caps with no stacked
 *   article ("near Tanya's mug", never "near the tanya's mug");
 * - proximity: "at" when adjacent (≤2 cells from center), "near" beyond;
 * - preferred target: when the action names a destination object
 *   ("Walk to the coffee machine"), that object wins the label when
 *   within 6 cells — the repair may stop short of it, but the label
 *   should name where the actor was headed, not the nearest fixture
 *   (tick-15: "near the water cooler" for a coffee-machine walk).
 * Pure.
 */
export function describePosition(
  world: World,
  x: number,
  y: number,
  preferredObjectId?: string,
): string {
  const hay = (o: { id: string; name: string }): string => `${o.id} ${o.name}`;
  const isWall = (o: { id: string; name: string }): boolean => /wall/i.test(hay(o));
  const isSign = (o: { id: string; name: string }): boolean => /sign/i.test(hay(o));
  const isFurniture = (o: { id: string; name: string }): boolean =>
    /desk|chair|machine|table|sofa/i.test(hay(o));
  const centerDist = (o: { x: number; y: number; w: number; h: number }): number =>
    Math.hypot(x - (o.x + o.w / 2), y - (o.y + o.h / 2));

  if (preferredObjectId !== undefined) {
    const preferred = world.scene.objects.find((o) => o.id === preferredObjectId);
    if (preferred !== undefined && !isWall(preferred)) {
      const d = centerDist(preferred);
      if (d <= 6) return formatLandmark(preferred.name, d);
    }
  }
  let bestFurniture: { name: string; d: number } | undefined;
  let bestOther: { name: string; d: number } | undefined;
  for (const o of world.scene.objects) {
    if (isWall(o) || isSign(o)) continue;
    const d = centerDist(o);
    if (d > 6) continue;
    const slot = isFurniture(o) ? "furniture" : "other";
    if (slot === "furniture") {
      if (bestFurniture === undefined || d < bestFurniture.d)
        bestFurniture = { name: o.name, d };
    } else if (bestOther === undefined || d < bestOther.d) {
      bestOther = { name: o.name, d };
    }
  }
  const best = bestFurniture ?? bestOther;
  if (best !== undefined) return formatLandmark(best.name, best.d);
  return `at (${x}, ${y})`;
}

/** "at Tanya's desk" / "near the coffee machine" — possessives keep caps, no stacked article. */
function formatLandmark(name: string, d: number): string {
  const label = /'s\b/.test(name)
    ? name
    : `the ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
  return `${d <= 2 ? "at" : "near"} ${label}`;
}

/** Resolve the action's named destination object for state-label preference. Pure. */
export function preferredStateObject(world: World, action: Action): string | undefined {
  try {
    return resolveDestinationObjectId(world, action.text, action.actorId) ?? undefined;
  } catch {
    return undefined;
  }
}

export function isPartialHistoryEntry(entry: HistoryEntry | string): boolean {
  const text = entryText(entry);
  return !text.includes(NOT_DONE_SENTINEL) && text.includes(PARTIAL_HISTORY_MARKER);
}

export function applyConsequence(
  world: World,
  result: ConsequenceResult,
  action: Action,
  config: EngineConfig = defaultConfig,
  opts: ApplyConsequenceOptions = {},
  /**
   * F18: optional pre-cloned mutation base. When provided (the turn-start
   * snapshot from runTurn), the applier mutates it in place instead of
   * cloning again — the caller owns the aliasing (the turn_started log
   * input references the same object; the JSONL file write stringifies
   * synchronously at log time, so it is unaffected).
   */
  snapshot?: World,
): World {
  const next = snapshot ?? cloneWorld(world);
  const actorById = new Map(next.actors.map((a) => [a.id, a]));
  const objectById = new Map(next.scene.objects.map((o) => [o.id, o]));

  for (const patch of result.actorPatches) {
    const actor = actorById.get(patch.actorId);
    if (!actor) continue;
    if (patch.x !== undefined && patch.y !== undefined) {
      const moved = patch.x !== actor.x || patch.y !== actor.y;
      actor.x = patch.x;
      actor.y = patch.y;
      // Exp-3 item 8 (S6): keep `state` coherent with position — auto-fill
      // when the patch moves the actor without updating `state` (an
      // explicit patch.state always wins below). The label prefers the
      // action's named destination object when one resolves.
      if (moved && patch.state === undefined) {
        actor.state = describePosition(
          next,
          patch.x,
          patch.y,
          preferredStateObject(next, action),
        );
      }
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

  const actorName = actorById.get(action.actorId)?.name ?? action.actorId;
  // Item C3 (exp local-8b M8): deterministic memory append — the acting
  // actor's own-turn narrative becomes a memory even when the model emits
  // no memoriesAppend, so P8 ("memory compounds") holds on weak tiers.
  // Skipped for fallbacks ("Nothing changes." is not a memory) and when
  // the model already appended memories; never duplicates the tail entry.
  // Existing caps trim as usual.
  if (!opts.fallback) {
    const acting = actorById.get(action.actorId);
    const actingPatch = result.actorPatches.find((p) => p.actorId === action.actorId);
    const modelAppended = (actingPatch?.memoriesAppend?.length ?? 0) > 0;
    if (acting !== undefined && !modelAppended && result.narrative.trim().length > 0) {
      const line = summarizeNarrativeForMemory(result.narrative, actorName);
      if (acting.memories[acting.memories.length - 1] !== line) {
        acting.memories.push(line);
        if (acting.memories.length > config.maxMemoriesPerActor) {
          acting.memories.splice(0, acting.memories.length - config.maxMemoriesPerActor);
        }
      }
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

  // F6: every history entry records its perceivers (computed from the
  // PRE-patch world — the event happened at the acting actor's position
  // before the patches moved anything).
  const perceivers = [...perceiverIds(world, action.actorId, config)];
  const pushEntry = (text: string): void => {
    const entry: HistoryEntry = normalizeHistoryEntry({ text, perceivers }, []);
    next.history.push(entry);
  };
  // Single history entry per turn.
  // Q1: clean turns record the NARRATIVE (what happened), not the action
  // text (the wish) — salvaged/liveness turns already did; now all applied
  // turns agree, and getOpenQuestions/proposal grounding treat them alike.
  // UI layers show this entry only when the viewer can perceive the actor.
  // Exp-4 item 6: fallback attempts are marked as un-applied so later
  // proposals don't assume Anton sits at his desk / the task was explained.
  // F22: the sentinel (not the "(not done)" substring) marks fallbacks.
  // Exp-5 item 2: salvaged/liveness turns record the narrative + note so
  // later turns don't assume a dropped question was asked.
  if (opts.fallback) {
    pushEntry(
      `${actorName} tried: ${action.text} ${FALLBACK_HISTORY_MARKER}${NOT_DONE_SENTINEL}`,
    );
  } else if (opts.honestHistoryNote !== undefined) {
    pushEntry(`${actorName}: ${result.narrative} ${PARTIAL_HISTORY_MARKER} [${opts.honestHistoryNote}]`);
  } else {
    pushEntry(`${actorName}: ${result.narrative}`);
  }
  if (next.history.length > config.maxHistoryEntries) {
    next.history.splice(0, next.history.length - config.maxHistoryEntries);
  }

  return next;
}
