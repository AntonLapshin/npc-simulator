import type { Actor, Point, SceneObject, World } from "../types.js";
import { defaultConfig } from "../config.js";
import { distance, isSegmentBlockedBy } from "./geometry.js";

// Perception helpers provide physical context only.
// They do not interpret meaning — the LLM decides whether a perception
// becomes a memory, belief, emotional reaction, or ignored event.

export function getActorById(world: World, actorId: string): Actor | undefined {
  return world.actors.find((a) => a.id === actorId);
}

function perceptionRadius(configRadius?: number): number {
  return configRadius ?? defaultConfig.defaultPerceptionRadius;
}

export function canSeePoint(
  world: World,
  from: Point,
  to: Point,
  radius?: number,
): boolean {
  const r = perceptionRadius(radius);
  if (distance(from, to) > r) return false;
  return !isSegmentBlockedBy(from, to, world.scene.objects, (o) => o.blocksVision);
}

export function canHearPoint(
  world: World,
  from: Point,
  to: Point,
  radius?: number,
): boolean {
  const r = perceptionRadius(radius);
  if (distance(from, to) > r) return false;
  // Objects with blocksSound=false do not block sound; blocksSound=true
  // strongly reduces hearing (treated as blocking for context purposes).
  return !isSegmentBlockedBy(from, to, world.scene.objects, (o) => o.blocksSound);
}

export function getVisibleActors(world: World, actorId: string, radius?: number): Actor[] {
  const self = getActorById(world, actorId);
  if (!self) return [];
  const from: Point = { x: self.x, y: self.y };
  return world.actors.filter((other) => {
    if (other.id === actorId) return false;
    return canSeePoint(world, from, { x: other.x, y: other.y }, radius);
  });
}

export function getAudibleActors(world: World, actorId: string, radius?: number): Actor[] {
  const self = getActorById(world, actorId);
  if (!self) return [];
  const from: Point = { x: self.x, y: self.y };
  return world.actors.filter((other) => {
    if (other.id === actorId) return false;
    return canHearPoint(world, from, { x: other.x, y: other.y }, radius);
  });
}

export function getVisibleObjects(
  world: World,
  actorId: string,
  radius?: number,
): SceneObject[] {
  const self = getActorById(world, actorId);
  if (!self) return [];
  const from: Point = { x: self.x, y: self.y };
  return world.scene.objects.filter((obj) => {
    const center: Point = { x: obj.x + obj.w / 2, y: obj.y + obj.h / 2 };
    return canSeePoint(world, from, center, radius);
  });
}
