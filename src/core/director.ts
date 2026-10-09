// PLAN_V2 Phase 5 — the director, as code.
//
// Free-will NPCs drift into polite small talk — every experiment log shows
// it. The director is the deterministic half of the fix (the other half is
// the style guide shipped in the narrate prompt): the engine watches for
// staleness — K consecutive turns with no new verb|noun action cores and no
// world-state changes — and injects the next unconsumed incident from the
// scenario's `directorEvents` list as a plain world fact. The LLM never
// decides *whether* drama happens; it only narrates it well.
//
// This module owns the policy decisions (pure functions over world
// snapshots). The orchestrator wires them in as a thin wrapper: staleness
// evaluation at the end of a v2 turn, injection at the start of the next
// NPC turn's intent call. Scenarios without `directorEvents` keep the
// director off — zero behavior change.

import {
  DEFAULT_DIRECTOR_STALENESS_THRESHOLD,
  type DirectorEvent,
  type World,
} from "../types.js";

/**
 * A stale turn is one where nothing new happened: the action's verb|noun
 * core already appeared in the recent history window AND the physical
 * world is byte-identical in every engine-owned dimension. Deliberately
 * narrow: thoughts/emotions/memories change almost every turn (small talk
 * is emotionally lively), so counting them would make the trigger dead
 * code. Positions, poses, holdings, and object state are what "the scene
 * visibly changes" means.
 */
export function worldStateSignature(world: World): string {
  const actors = [...world.actors]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a) =>
      [
        a.id,
        a.x,
        a.y,
        a.pose ?? "stand",
        a.prop ?? "",
        a.heldObjectId ?? "",
      ].join(":"),
    );
  const objects = [...world.scene.objects]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((o) =>
      [
        o.id,
        o.x,
        o.y,
        o.w,
        o.h,
        o.passable,
        o.blocksVision,
        o.blocksSound,
        o.description,
      ].join(":"),
    );
  return JSON.stringify({ actors, objects });
}

/** True when the engine-owned world state differs between two snapshots. */
export function worldStateChanged(before: World, after: World): boolean {
  return worldStateSignature(before) !== worldStateSignature(after);
}

/**
 * The first event the director hasn't fired yet, in scenario order.
 * Consumed events are never repeated; undefined when the list is
 * exhausted (the caller then stays silent — no crash, no repeat).
 */
export function nextDirectorEvent(
  events: readonly DirectorEvent[],
  consumedIds: readonly string[],
): DirectorEvent | undefined {
  const consumed = new Set(consumedIds);
  return events.find((e) => !consumed.has(e.id));
}

/** The director's configuration as read from a world (scenario fields). */
export type DirectorConfig = {
  events: readonly DirectorEvent[];
  threshold: number;
};

/**
 * Read the director config from a world, or null when the director is
 * off (no `directorEvents`, or an empty list — zero behavior change).
 */
export function directorConfigFor(world: World): DirectorConfig | null {
  const events = world.directorEvents;
  if (events === undefined || events.length === 0) return null;
  return {
    events,
    threshold:
      world.directorStalenessThreshold ?? DEFAULT_DIRECTOR_STALENESS_THRESHOLD,
  };
}

export type DirectorStalenessInput = {
  /** Verb|noun core of the just-completed turn's action. */
  actionCore: string;
  /**
   * Verb|noun cores of the recent history entries BEFORE this turn
   * (entries without a recorded action are skipped by the caller).
   */
  priorCores: readonly string[];
  /** Did the engine-owned world state change this turn? */
  worldChanged: boolean;
  /** The counter carried on the world. */
  stalenessCount: number;
  /** Ids of already-injected events. */
  consumedIds: readonly string[];
  /** Null → director off. */
  config: DirectorConfig | null;
};

export type DirectorStalenessResult = {
  /** The counter value to persist on the world. */
  stalenessCount: number;
  /**
   * Set exactly when the trigger fires this turn: the event to inject.
   * The caller marks it consumed, resets the counter (already 0 here),
   * records it in history, and logs `director_event_injected`.
   */
  inject: DirectorEvent | undefined;
};

/**
 * One deterministic step of the staleness trigger. A turn is stale when
 * its action core is not new (seen in the recent window) AND the world
 * didn't change. The counter climbs on stale turns and resets on lively
 * ones; hitting the threshold fires the next unconsumed event. When the
 * list is exhausted the counter resets quietly — no injection, no crash,
 * no repeat.
 */
export function evaluateDirectorStaleness(
  input: DirectorStalenessInput,
): DirectorStalenessResult {
  if (input.config === null) return { stalenessCount: 0, inject: undefined };
  // A turn is stale when its action core brings nothing new AND the world
  // didn't change. "New" is relative to the recent window — with an empty
  // window (the first turns of a run) there is nothing to be new against,
  // so the turn counts as not-new: K boring turns from a cold start reach
  // exactly K, and the trigger fires on turn K.
  const isNewCore =
    input.priorCores.length > 0 && !input.priorCores.includes(input.actionCore);
  const stale = !isNewCore && !input.worldChanged;
  const count = stale ? input.stalenessCount + 1 : 0;
  if (count < input.config.threshold) {
    return { stalenessCount: count, inject: undefined };
  }
  const event = nextDirectorEvent(input.config.events, input.consumedIds);
  // Threshold reached: fire (counter resets), or — list exhausted — reset
  // quietly and stay silent.
  return { stalenessCount: 0, inject: event };
}
