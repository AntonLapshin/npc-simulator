// Action-text helpers for movement hints (exp local-8b items).
//
// Phase 1: pure text predicates live in `src/core/` — `extractDirectionHint`
// moved to `src/core/text.ts` (re-exported here for existing importers);
// the movement-repair veto machinery is deleted with the repair path it
// served (movement is engine-owned now).
// Phase 3: the prop auto-hint (`buildPropHint`, exp-2 item 4) is deleted —
// props are engine-owned now, so telling the model to emit prop patches
// is a dead instruction.

import type { World } from "../types.js";
import {
  resolveDestinationActorId,
  resolveDestinationObjectId,
} from "./deterministicSemantics.js";

// Direction hints live in the pure core now; re-exported for compat.
export type { DirectionHint } from "../core/text.js";
export { extractDirectionHint } from "../core/text.js";

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
