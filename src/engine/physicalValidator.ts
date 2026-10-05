import type { ConsequenceResult, ValidationResult, World } from "../types.js";
import { consequenceResultSchema } from "../schemas.js";
import { isInsideScene, isPointBlocked } from "./geometry.js";
import { canMoveBetween } from "./pathfinding.js";

/**
 * Validate ConsequenceResult output. Checks schema, referenced ids,
 * coordinates, collisions, movement paths, and object rectangles.
 * Never judges tone, morality, or social realism.
 */
export function validateConsequence(
  world: World,
  result: ConsequenceResult,
): ValidationResult {
  const errors: string[] = [];

  const parsed = consequenceResultSchema.safeParse(result);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`schema: ${issue.path.join(".")}: ${issue.message}`);
    }
    return { valid: false, errors };
  }

  const actorById = new Map(world.actors.map((a) => [a.id, a]));
  const objectById = new Map(world.scene.objects.map((o) => [o.id, o]));

  for (const patch of result.actorPatches) {
    const actor = actorById.get(patch.actorId);
    if (!actor) {
      errors.push(`unknown actor id: ${patch.actorId}`);
      continue;
    }
    const xSet = patch.x !== undefined;
    const ySet = patch.y !== undefined;
    if (xSet !== ySet) {
      errors.push(`actor ${patch.actorId}: x and y must be provided together`);
    }
    if (xSet && ySet) {
      const x = patch.x!;
      const y = patch.y!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        errors.push(`actor ${patch.actorId}: coordinates must be finite numbers`);
      } else {
        const to = { x, y };
        if (!isInsideScene(world.scene, to)) {
          errors.push(`actor ${patch.actorId}: coordinates outside scene bounds`);
        } else if (isPointBlocked(world.scene, to)) {
          errors.push(`actor ${patch.actorId}: coordinates inside non-passable object`);
        } else if (x !== actor.x || y !== actor.y) {
          if (!canMoveBetween(world.scene, { x: actor.x, y: actor.y }, to)) {
            errors.push(`actor ${patch.actorId}: no valid path from current position`);
          }
        }
      }
    }
    for (const [field, value] of [
      ["state", patch.state],
      ["emotion", patch.emotion],
      ["goal", patch.goal],
    ] as const) {
      if (value !== undefined && typeof value !== "string") {
        errors.push(`actor ${patch.actorId}: ${field} must be a string`);
      }
    }
    for (const [field, value] of [
      ["memoriesAppend", patch.memoriesAppend],
      ["beliefsAppend", patch.beliefsAppend],
      ["relationshipsAppend", patch.relationshipsAppend],
    ] as const) {
      if (value !== undefined) {
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
          errors.push(`actor ${patch.actorId}: ${field} must be an array of strings`);
        }
      }
    }
  }

  for (const patch of result.objectPatches) {
    const obj = objectById.get(patch.objectId);
    if (!obj) {
      errors.push(`unknown object id: ${patch.objectId}`);
      continue;
    }
    for (const field of ["x", "y", "w", "h"] as const) {
      const v = patch[field];
      if (v !== undefined && !Number.isFinite(v)) {
        errors.push(`object ${patch.objectId}: ${field} must be a finite number`);
      }
    }
    if (patch.w !== undefined && patch.w <= 0) {
      errors.push(`object ${patch.objectId}: w must be positive`);
    }
    if (patch.h !== undefined && patch.h <= 0) {
      errors.push(`object ${patch.objectId}: h must be positive`);
    }
    for (const field of ["passable", "blocksVision", "blocksSound"] as const) {
      const v = patch[field];
      if (v !== undefined && typeof v !== "boolean") {
        errors.push(`object ${patch.objectId}: ${field} must be a boolean`);
      }
    }
    if (patch.description !== undefined && typeof patch.description !== "string") {
      errors.push(`object ${patch.objectId}: description must be a string`);
    }
    const nx = patch.x ?? obj.x;
    const ny = patch.y ?? obj.y;
    const nw = patch.w ?? obj.w;
    const nh = patch.h ?? obj.h;
    if (nx < 0 || ny < 0 || nw <= 0 || nh <= 0 || nx + nw > world.scene.width || ny + nh > world.scene.height) {
      errors.push(`object ${patch.objectId}: rectangle outside scene bounds`);
    }
  }

  return { valid: errors.length === 0, errors };
}
