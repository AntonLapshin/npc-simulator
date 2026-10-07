import type { Action, ActionSemantics, ConsequenceResult, ValidationResult, World } from "../types.js";
import { consequenceResultSchema } from "../schemas.js";
import { isInsideScene, isPointBlocked, pointInRect } from "./geometry.js";
import { canMoveBetween } from "./pathfinding.js";
import { effectsToSemantics } from "./actionSemantics.js";

export { CONTACT_RADIUS } from "./validate/movement.js";

import { suggestSimilarIds } from "./validate/textUtils.js";
import {
  validateContactAdjacency,
  validateDestinationObject,
  validateMovementIntent,
} from "./validate/movement.js";
import {
  validateNarrativePlaceholder,
  validateSpeechPreservation,
} from "./validate/speech.js";
import {
  validateActionVerbCoverage,
  validateExplanationCoverage,
  validateObjectGrounding,
} from "./validate/objects.js";
import {
  validateActingActorPresence,
  validateAddresseePatch,
  validateNarrativeActors,
  validateNarrativeMovementGrounding,
  validateObserverSubject,
  validateStateCoherence,
} from "./validate/narrative.js";

/**
 * Validate ConsequenceResult output. Checks schema, referenced ids,
 * coordinates, collisions, movement paths, object rectangles, turn
 * discipline (only the acting actor may move/speak/act — other
 * actors may only change internal state: thoughts, emotion, goal,
 * memories, beliefs, relationships; pose/prop count as observable acts), and speech preservation (the
 * narrative must not invent dialogue the acting actor never said).
 * Never judges tone, morality, or social realism.
 *
 * Semantic gates (movement intent, speech preservation) run on an
 * injected ActionSemantics produced by Decision AI — never on regex over
 * raw prose. Resolution order: explicit `semantics` argument first, then
 * the consequence's self-declared `effects`, otherwise fail-open to
 * physics-only checks (no semantic errors). Async callers (the turn
 * orchestrator) resolve judge-backed semantics via
 * resolveActionSemantics() and pass them in.
 */
export function validateConsequence(
  world: World,
  result: ConsequenceResult,
  action?: Action,
  semantics?: ActionSemantics,
): ValidationResult {
  const errors: string[] = [];

  const parsed = consequenceResultSchema.safeParse(result);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`schema: ${issue.path.join(".")}: ${issue.message}`);
    }
    return { valid: false, errors };
  }
  // Use the normalized payload (id-aliases resolved, stringified arrays
  // parsed, missing reasoning defaulted) for all checks below.
  const normalized = parsed.data;

  const actorById = new Map(world.actors.map((a) => [a.id, a]));
  const objectById = new Map(world.scene.objects.map((o) => [o.id, o]));

  for (const patch of normalized.actorPatches) {
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
          const blocker = world.scene.objects.find(
            (o) => !o.passable && pointInRect(to, o),
          );
          const where = blocker
            ? ` inside non-passable object ${blocker.id} at (${blocker.x},${blocker.y},${blocker.w}x${blocker.h})`
            : " inside non-passable object";
          errors.push(
            `actor ${patch.actorId}: coordinates (${x}, ${y})${where}: pick a nearby free cell outside that rectangle with a valid path from current (${actor.x}, ${actor.y}) — never the center of a desk/table, stand NEXT to it instead`,
          );
        } else if (x !== actor.x || y !== actor.y) {
          if (!canMoveBetween(world.scene, { x: actor.x, y: actor.y }, to)) {
            errors.push(
              `actor ${patch.actorId}: no valid path from current (${actor.x}, ${actor.y}) to (${x}, ${y}): pick an adjacent reachable free cell instead`,
            );
          }
        }
      }
    }
    for (const [field, value] of [
      ["state", patch.state],
      ["emotion", patch.emotion],
      ["goal", patch.goal],
      ["thoughts", patch.thoughts],
    ] as const) {
      if (value !== undefined && typeof value !== "string") {
        errors.push(`actor ${patch.actorId}: ${field} must be a string`);
      }
    }
    // Turn discipline: a character only acts on its own turn. Observers
    // of someone else's action must not move (x/y) or change physical
    // state — they may only react internally (thoughts, emotion, goal,
    // memories, beliefs, relationships). Pose/prop changes (sitting down,
    // picking something up) are observable physical acts, so they are
    // restricted like state. Any observable reply, approach,
    // or gesture belongs to their own future turn.
    if (action && patch.actorId !== action.actorId) {
      if (patch.x !== undefined || patch.y !== undefined) {
        errors.push(
          `actor ${patch.actorId}: only the acting actor (${action.actorId}) may move; observers must not change position`,
        );
      }
      if (patch.state !== undefined || patch.pose !== undefined || patch.prop !== undefined) {
        errors.push(
          `actor ${patch.actorId}: only the acting actor (${action.actorId}) may change state/pose/prop; observers may only update thoughts/emotion/goal/memories/beliefs/relationships`,
        );
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

  for (const patch of normalized.objectPatches) {    const obj = objectById.get(patch.objectId);
    if (!obj) {
      const hint = suggestSimilarIds(
        patch.objectId,
        world.scene.objects.map((o) => o.id),
      );
      errors.push(
        `unknown object id: ${patch.objectId}${hint ? ` — did you mean ${hint}?` : ""} Only the listed object ids exist — never invent variants like 'coffee mug' or 'paper'.`,
      );
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

  // Speech preservation: the narrative must be grounded in the judged
  // meaning of the action. semantics.quotedSpeech is the ground truth for
  // uttered words (from the effects declaration or the SemanticJudge) —
  // the narrative is compared against it, never against regex-extracted
  // action quotes. Movement intent likewise comes from semantics.moves,
  // with the destination resolved by actor id (never substring search).
  // Without semantics (no effects, no judge) these gates fail open:
  // schema, geometry, and turn structure still guard coherence.
  if (action) {
    const resolved = semantics ?? effectsToSemantics(normalized);
    errors.push(...validateNarrativePlaceholder(normalized.narrative, action));
    errors.push(...validateNarrativeActors(world, normalized));
    errors.push(...validateObjectGrounding(world, normalized, action));
    errors.push(...validateNarrativeMovementGrounding(world, normalized, action));
    if (resolved) {
      errors.push(...validateSpeechPreservation(resolved, normalized.narrative));
      errors.push(...validateMovementIntent(world, normalized, action, resolved));
      errors.push(...validateDestinationObject(world, normalized, action, resolved));
      errors.push(...validateContactAdjacency(world, normalized, action, resolved));
      errors.push(...validateAddresseePatch(world, normalized, action, resolved));
      errors.push(...validateActingActorPresence(normalized, action, resolved));
      errors.push(...validateStateCoherence(world, normalized, action));
      errors.push(...validateActionVerbCoverage(world, action, normalized));
      errors.push(...validateObserverSubject(world, normalized, action));
    }
  } else {
    errors.push(...validateNarrativePlaceholder(normalized.narrative));
    errors.push(...validateNarrativeActors(world, normalized));
    errors.push(...validateObjectGrounding(world, normalized));
  }

  return { valid: errors.length === 0, errors };
}

// Compatibility re-exports: the checks live in focused modules now.
export { suggestSimilarIds } from "./validate/textUtils.js";
export {
  distanceToRect,
  narrativeClaimsArrival,
  validateContactAdjacency,
  validateDestinationObject,
  validateMovementIntent,
} from "./validate/movement.js";
export {
  contentWords,
  maskResumedActivity,
  normLower,
  questionPreserved,
  quotedSegments,
  sameStem,
  stripForCompare,
  validateNarrativePlaceholder,
  validateSpeechPreservation,
} from "./validate/speech.js";
export {
  validateActionVerbCoverage,
  validateExplanationCoverage,
  validateObjectGrounding,
} from "./validate/objects.js";
export {
  perceiverIds,
  validateActingActorPresence,
  validateAddresseePatch,
  validateNarrativeActors,
  validateNarrativeMovementGrounding,
  validateObserverSubject,
  validateStateCoherence,
} from "./validate/narrative.js";
