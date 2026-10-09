// Engine-owned objects and props (Phase 3 of the renderer architecture).
//
// The affordance table lives in the pure core (`src/core/objects.ts` —
// one canonical kind table, no per-module duplicates). This module is the
// thin engine side: resolving affordances for live world objects and
// building the immutable snapshot the core plans from. The actual
// planning/execution split mirrors Phase 1/2:
//   plan   → `planManipulation` in `src/core/objects.ts` (pure)
//   execute → `src/engine/manipulationExecutor.ts` (world reads, patch merge)

import type { World } from "../types.js";
import {
  MANIPULATION_REACH,
  affordanceForObject,
  distanceToObjectCenter,
  type CoreObject,
  type ManipulationSnapshot,
  type ObjectKindAffordance,
} from "../core/objects.js";

export type { CoreObject, ManipulationSnapshot, ObjectKindAffordance };
export {
  HAND_OVER_REACH,
  MANIPULATION_REACH,
  OBJECT_KIND_AFFORDANCES,
  affordanceForObject,
  assertManipulationInvariants,
  describeManipulation,
  detectNarrativeManipulation,
  distanceToObjectCenter,
  kindWordProp,
  mentionsObject,
  nearestKindObject,
  nearBrewSource,
  planManipulation,
  resolveContactMention,
  type CoreActor,
  type ManipulationKind,
  type ManipulationPlan,
} from "../core/objects.js";

/** Affordances of one live scene object, by id. */
export function objectAffordance(
  world: World,
  objectId: string,
): ObjectKindAffordance | null {
  const obj = world.scene.objects.find((o) => o.id === objectId);
  if (!obj) return null;
  return affordanceForObject(obj);
}

/**
 * Immutable manipulation snapshot of the world: actors (id, name,
 * position, held prop) and scene objects with resolved affordances.
 * The core plans from this — never from the live world.
 */
export function buildManipulationSnapshot(world: World): ManipulationSnapshot {
  return {
    actors: world.actors.map((a) => ({
      id: a.id,
      name: a.name,
      x: a.x,
      y: a.y,
      prop: a.prop ?? null,
    })),
    objects: world.scene.objects.map((o) => ({
      id: o.id,
      name: o.name,
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      affordance: affordanceForObject(o),
    })),
  };
}

/**
 * Scene objects the acting actor could physically manipulate right now:
 * pickable and within manipulation reach. For prompt-side awareness
 * (the render input already carries the executed facts; this is the
 * affordance inventory, not an instruction).
 */
export function manipulableObjects(world: World, actorId: string): { id: string; name: string }[] {
  const actor = world.actors.find((a) => a.id === actorId);
  if (!actor) return [];
  return world.scene.objects
    .filter(
      (o) =>
        affordanceForObject(o).pickable &&
        distanceToObjectCenter(actor, o) <= MANIPULATION_REACH + 1e-9,
    )
    .map((o) => ({ id: o.id, name: o.name }));
}
