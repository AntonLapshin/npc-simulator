import type { Action, ConsequenceResult, EngineConfig, HistoryEntry, World } from "../types.js";
import { NOT_DONE_SENTINEL, normalizeHistoryEntry } from "../types.js";
import { defaultConfig } from "../config.js";
import { cloneWorld } from "./worldStore.js";
import { pointInRect } from "./geometry.js";
import { distanceToRect } from "./validate/movement.js";
import { detectVoiceViolation, perceiverIds, thirdPersonFallbackText } from "./validate/narrative.js";
import { resolveDestinationObjectId } from "./deterministicSemantics.js";
import type { MovementOutcome } from "./movementExecutor.js";
import type { ManipulationOutcome } from "./manipulationExecutor.js";
import type { PlannedPose } from "../core/text.js";

export const FALLBACK_HISTORY_MARKER = "(not done)";

/** Marker for salvaged/liveness history entries recorded from the narrative (Exp-5 item 2). */
export const PARTIAL_HISTORY_MARKER = "(partial)";

/**
 * Exp-4 item 7 (S3): marker embedded in liveness-floor history entries
 * ("…(partial) [liveness floor]"). Intent-failure streaks skip these
 * entries — the liveness path bypasses validation entirely, so a liveness
 * turn proves nothing about a banned intent's renderability and must not
 * reset its consecutive-failure count (exp-4 ticks 19→22 repro).
 */
export const LIVENESS_HISTORY_MARKER = "[liveness floor]";

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
 * - pose-aware seating (Exp-4 item 8 / S5): a standing actor is never "at"
 *   a chair — "at Tanya's chair" while standing (exp-4 final state) reads
 *   as sitting. Chairs/sofas only yield "at" when pose is "sit"; otherwise
 *   they fall back to "near" (or lose to the desk).
 * Pure.
 */
export function describePosition(
  world: World,
  x: number,
  y: number,
  preferredObjectId?: string,
  pose?: string,
): string {
  const hay = (o: { id: string; name: string }): string => `${o.id} ${o.name}`;
  const isWall = (o: { id: string; name: string }): boolean => /wall/i.test(hay(o));
  const isSign = (o: { id: string; name: string }): boolean => /sign/i.test(hay(o));
  const isSeating = (o: { id: string; name: string }): boolean =>
    /chair|sofa/i.test(hay(o));
  const isFurniture = (o: { id: string; name: string }): boolean =>
    /desk|chair|machine|table|sofa/i.test(hay(o));
  const centerDist = (o: { x: number; y: number; w: number; h: number }): number =>
    Math.hypot(x - (o.x + o.w / 2), y - (o.y + o.h / 2));
  // Exp-6 item 10 (S5): "at <chair>" is a cell claim, not a proximity
  // claim. A seated actor is AT the chair only when actually on it
  // (standable chair cell) or tucked against it (non-passable lounge
  // seating, edge-adjacent ≤1.5 — the isSeatingCell radius). Anything
  // else is "near", even with pose "sit" (exp-6: "at Tanya's chair" for
  // (8,6) while the chair sat at (8,7)). Unknown pose (undefined) keeps
  // the old behavior — fail open (exp-4 item 8).
  const seatingAt = (o: { x: number; y: number; w: number; h: number; passable: boolean }): boolean =>
    pose === undefined ||
    (pose === "sit" &&
      (pointInRect({ x, y }, o) || (!o.passable && distanceToRect(x, y, o) <= 1.5)));
  /** A standing actor next to a chair is "near" it, never "at" it. */
  const atDistance = (
    seating: boolean,
    o: { x: number; y: number; w: number; h: number; passable: boolean },
    d: number,
  ): number => (seating ? (seatingAt(o) ? d : Math.max(d, 2.01)) : d);

  if (preferredObjectId !== undefined) {
    const preferred = world.scene.objects.find((o) => o.id === preferredObjectId);
    if (preferred !== undefined && !isWall(preferred)) {
      const d = centerDist(preferred);
      if (d <= 6)
        return formatLandmark(preferred.name, atDistance(isSeating(preferred), preferred, d));
    }
  }
  type Best = {
    name: string;
    d: number;
    seating: boolean;
    o: { x: number; y: number; w: number; h: number; passable: boolean };
  };
  let bestFurniture: Best | undefined;
  let bestOther: Best | undefined;
  for (const o of world.scene.objects) {
    if (isWall(o) || isSign(o)) continue;
    const d = centerDist(o);
    if (d > 6) continue;
    const slot = isFurniture(o) ? "furniture" : "other";
    if (slot === "furniture") {
      if (bestFurniture === undefined || d < bestFurniture.d)
        bestFurniture = { name: o.name, d, seating: isSeating(o), o };
    } else if (bestOther === undefined || d < bestOther.d) {
      bestOther = { name: o.name, d, seating: isSeating(o), o };
    }
  }
  const best = bestFurniture ?? bestOther;
  if (best !== undefined) {
    return formatLandmark(best.name, atDistance(best.seating, best.o, best.d));
  }
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

/**
 * Phase 4: the engine-executed outcomes for one turn, computed by the
 * turn orchestrator before the render call (Phases 1–3) and applied to
 * the world by `applyRenderResult` alongside the render prose.
 */
export type ExecutedTurn = {
  /** Engine-executed movement (null = the actor stays in place). */
  movement: MovementOutcome | null;
  /** Engine-executed pose change (null = pose unchanged). */
  pose: PlannedPose | null;
  /** Engine-executed manipulation (null = none executed). */
  manipulation: ManipulationOutcome | null;
};

/**
 * Apply one turn's result to produce the next World.
 *
 * Phase 4: the render contract is prose-only, so the world update has two
 * deterministic halves — the engine-executed outcomes (movement, pose,
 * manipulation) and the render prose (acting actor's thoughts/emotion,
 * narrative → history). There are no model patches anymore.
 */
export type ApplyRenderOptions = {
  /**
   * Exp-4 item 6: the turn fell back ("Nothing changes.") — record the
   * attempt separately from the world ("Anton tried: … (not done)") so
   * proposal/selection ground on what happened, not the wish. Fallback
   * entries never count as answers, own actions, or open questions
   * (see contextBuilder filtering).
   */
  fallback?: boolean;
  /**
   * Exp-5 item 2: the applied turn is a deterministic liveness reaction —
   * record the NARRATIVE (what happened) plus this note ("liveness
   * floor"), never the raw action text (the wish). Takes effect only for
   * non-fallback turns.
   */
  honestHistoryNote?: string;
  /**
   * Liveness floor: apply the prose only (thoughts/emotion + history) —
   * no engine outcomes. The liveness turn is a minimal in-place reaction
   * by design, so the actor holds position even when the action implied
   * movement.
   */
  liveness?: boolean;
};

export function applyRenderResult(
  world: World,
  action: Action,
  render: ConsequenceResult,
  executed: ExecutedTurn,
  config: EngineConfig = defaultConfig,
  opts: ApplyRenderOptions = {},
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
  const acting = actorById.get(action.actorId);

  const applyOutcomes = !opts.fallback && !opts.liveness;
  if (applyOutcomes && acting !== undefined) {
    // Engine-executed movement (Phase 1): the acting actor's position is
    // engine-owned, always. Keep `state` coherent with the new position —
    // the deterministic landmark label (Exp-3 item 8 / S6), preferring
    // the action's named destination object.
    if (executed.movement !== null) {
      const { x, y } = executed.movement;
      const moved = x !== acting.x || y !== acting.y;
      acting.x = x;
      acting.y = y;
      if (moved) {
        // Stage-1 A3: the held scene object travels with its holder —
        // never orphaned at the pick-up site. Gated on the prop: a
        // prop-less actor carries nothing even if a stale link lingers.
        if ((acting.prop ?? null) !== null) {
          const heldId = acting.heldObjectId ?? null;
          if (heldId !== null) {
            const obj = objectById.get(heldId);
            if (obj !== undefined) {
              obj.x = x;
              obj.y = y;
            }
          }
        }
        acting.state = describePosition(
          next,
          x,
          y,
          preferredStateObject(next, action),
          executed.pose ?? acting.pose,
        );
      }
    }
    // Engine-executed pose (Phase 4): sit/stand verbs in the action text
    // set the pose deterministically.
    if (executed.pose !== null) {
      acting.pose = executed.pose;
    }
    // Engine-executed manipulation (Phase 3): prop assignments (acting
    // actor always, hand-over recipient too) and object relocations.
    if (executed.manipulation !== null) {
      for (const ap of executed.manipulation.actorProps) {
        const target = actorById.get(ap.actorId);
        if (target !== undefined) target.prop = ap.prop;
      }
      // Stage-1 A3: the scene-object link follows the prop (set on
      // pick-up, cleared on put-down, transferred on hand-over).
      for (const h of executed.manipulation.heldObjectIds) {
        const target = actorById.get(h.actorId);
        if (target !== undefined) target.heldObjectId = h.heldObjectId;
      }
      for (const mv of executed.manipulation.objectMoves) {
        const obj = objectById.get(mv.objectId);
        if (obj !== undefined) {
          obj.x = mv.x;
          obj.y = mv.y;
        }
      }
    }
  }

  const actorName = acting?.name ?? action.actorId;
  if (!opts.fallback && acting !== undefined) {
    // Render prose: the acting actor's thoughts/emotion. Undefined fields
    // leave the current values untouched.
    if (render.thoughts !== undefined) acting.thoughts = render.thoughts;
    if (render.emotion !== undefined) acting.emotion = render.emotion;
    // Item C3 (exp local-8b M8): deterministic memory append — the acting
    // actor's own-turn narrative becomes a memory (the render contract is
    // prose-only, so the model cannot append memories itself). Never
    // duplicates the tail entry. Existing caps trim as usual.
    if (render.narrative.trim().length > 0) {
      const line = summarizeNarrativeForMemory(render.narrative, actorName);
      if (acting.memories[acting.memories.length - 1] !== line) {
        acting.memories.push(line);
        if (acting.memories.length > config.maxMemoriesPerActor) {
          acting.memories.splice(0, acting.memories.length - config.maxMemoriesPerActor);
        }
      }
    }
  }

  // F6: every history entry records its perceivers (computed from the
  // PRE-patch world — the event happened at the acting actor's position
  // before the turn's changes).
  const perceivers = [...perceiverIds(world, action.actorId, config)];
  const pushEntry = (text: string): void => {
    // Stage-1 A4: record the ground-truth action alongside the narrative —
    // the repetition screen cores from the action, never from prose a
    // mis-render can poison.
    const entry: HistoryEntry = normalizeHistoryEntry(
      { text, perceivers, actionText: action.text },
      [],
    );
    next.history.push(entry);
  };
  // Single history entry per turn.
  // Q1: clean turns record the NARRATIVE (what happened), not the action
  // text (the wish). UI layers show this entry only when the viewer can
  // perceive the actor.
  // Exp-4 item 6: fallback attempts are marked as un-applied so later
  // proposals don't assume Anton sits at his desk / the task was explained.
  // F22: the sentinel (not the "(not done)" substring) marks fallbacks.
  // Exp-5 item 2: liveness turns record the narrative + note so later
  // turns don't assume a dropped question was asked.
  if (opts.fallback) {
    // Exp-6 item 8 (M8): first-person echoes in user-turn fallbacks
    // ("Anton tried: I turn toward Dana and say: …") must never become
    // canonical — rewrite unquoted self-reference to third person before
    // recording. Quoted speech is the character speaking and is kept.
    const fallbackText = detectVoiceViolation(action.text).some(
      (v) => v.code === "first_person",
    )
      ? thirdPersonFallbackText(action.text)
      : action.text;
    pushEntry(
      `${actorName} tried: ${fallbackText} ${FALLBACK_HISTORY_MARKER}${NOT_DONE_SENTINEL}`,
    );
  } else if (opts.honestHistoryNote !== undefined) {
    pushEntry(`${actorName}: ${render.narrative} ${PARTIAL_HISTORY_MARKER} [${opts.honestHistoryNote}]`);
  } else {
    pushEntry(`${actorName}: ${render.narrative}`);
  }
  if (next.history.length > config.maxHistoryEntries) {
    next.history.splice(0, next.history.length - config.maxHistoryEntries);
  }

  return next;
}
