// Action-text movement hints for the deterministic movement repair
// (exp local-8b item C7 / S1).
//
// suggestMoveTarget used to score "nearest step first" over an x-ascending
// scan when the model declared no destination — so "walk east" repairs
// stepped WEST. These pure helpers parse the action text itself (parsed
// destinations reuse the existing word-boundary mention utils in
// deterministicSemantics) so the repair steers toward what the action
// actually says. Pure: no I/O, no world mutation.

import type { World } from "../types.js";
import {
  resolveDestinationActorId,
  resolveDestinationObjectId,
} from "./deterministicSemantics.js";

/** Cardinal direction hint parsed from action text. */
export type DirectionHint = "north" | "south" | "east" | "west";

/**
 * First cardinal direction named in the text ("a few steps east" →
 * "east"). Word-boundary matched; null when no direction is named.
 * Diagonal compounds ("north-east") are out of scope — the first cardinal
 * word wins, which is enough for repair tie-breaking.
 */
export function extractDirectionHint(text: string): DirectionHint | null {
  const m = /\b(north|south|east|west)\b/i.exec(text);
  if (!m) return null;
  return m[1]!.toLowerCase() as DirectionHint;
}

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
