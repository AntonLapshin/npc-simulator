import type { Action, ActionSemantics, ConsequenceResult, EngineConfig, ValidationError, ValidationResult, World } from "../types.js";
import { defaultConfig } from "../config.js";
import { consequenceResultSchema } from "../schemas.js";
import { isInsideScene, isPointBlocked, pointInRect } from "./geometry.js";
import { canMoveBetween } from "./pathfinding.js";
import { effectsToSemantics } from "./actionSemantics.js";

export { CONTACT_RADIUS } from "./validate/movement.js";
export { OBJECT_INTERACT_RADIUS };

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
  validateSitPoseSeating,
  OBJECT_INTERACT_RADIUS,
} from "./validate/objects.js";
import {
  validateActingActorPresence,
  validateAddresseePatch,
  validateEnterFreshness,
  validateIdentityConsistency,
  validateInventedContact,
  validateNarrativeActors,
  validateNarrativeMovementGrounding,
  validateNarrativeVoice,
  validateObserverSubject,
  validateRelationshipLabel,
  validateStateCoherence,
  validateStateLabel,
  validateThoughtGrounding,
} from "./validate/narrative.js";

/**
 * Validate ConsequenceResult output. Checks schema, referenced ids,
 * coordinates, collisions, movement paths, object rectangles, turn
 * discipline (only the acting actor may move/speak/act — other
 * actors may only change internal state: thoughts, emotion,
 * memories, beliefs, relationships; pose/prop count as observable acts),
 * object-manipulation proximity (F4), observer goal-write protection (F5),
 * and speech preservation (the narrative must not invent dialogue the
 * acting actor never said). Never judges tone, morality, or social realism.
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
  cfg: EngineConfig = defaultConfig,
): ValidationResult {
  const errors: ValidationError[] = [];

  const parsed = consequenceResultSchema.safeParse(result);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        code: "schema.invalid",
        message: `schema: ${issue.path.join(".")}: ${issue.message}`,
      });
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
      errors.push({ code: "actor.unknown_id", message: `unknown actor id: ${patch.actorId}` });
      continue;
    }
    const xSet = patch.x !== undefined;
    const ySet = patch.y !== undefined;
    if (xSet !== ySet) {
      errors.push({
        code: "actor.xy_pairing",
        message: `actor ${patch.actorId}: x and y must be provided together`,
      });
    }
    if (xSet && ySet) {
      const x = patch.x!;
      const y = patch.y!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        errors.push({
          code: "actor.coords_not_finite",
          message: `actor ${patch.actorId}: coordinates must be finite numbers`,
        });
      } else {
        const to = { x, y };
        if (!isInsideScene(world.scene, to)) {
          errors.push({
            code: "actor.out_of_bounds",
            message: `actor ${patch.actorId}: coordinates outside scene bounds`,
          });
        } else if (isPointBlocked(world.scene, to)) {
          const blocker = world.scene.objects.find(
            (o) => !o.passable && pointInRect(to, o),
          );
          const where = blocker
            ? ` inside non-passable object ${blocker.id} at (${blocker.x},${blocker.y},${blocker.w}x${blocker.h})`
            : " inside non-passable object";
          errors.push({
            code: "actor.blocked_position",
            message: `actor ${patch.actorId}: coordinates (${x}, ${y})${where}: pick a nearby free cell outside that rectangle with a valid path from current (${actor.x}, ${actor.y}) — never the center of a desk/table, stand NEXT to it instead`,
          });
        } else if (x !== actor.x || y !== actor.y) {
          // F10: no actor-actor stacking — the destination cell must not be
          // occupied by another actor.
          const occupant = world.actors.find(
            (a) => a.id !== patch.actorId && a.x === x && a.y === y,
          );
          if (occupant) {
            errors.push({
              code: "movement.actor_collision",
              message: `actor ${patch.actorId}: destination (${x}, ${y}) is occupied by ${occupant.id}: end on a different free cell — two actors cannot share a cell`,
            });
          } else if (!canMoveBetween(world.scene, { x: actor.x, y: actor.y }, to)) {
            errors.push({
              code: "actor.no_path",
              message: `actor ${patch.actorId}: no valid path from current (${actor.x}, ${actor.y}) to (${x}, ${y}): pick an adjacent reachable free cell instead`,
            });
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
        errors.push({
          code: "actor.field_not_string",
          message: `actor ${patch.actorId}: ${field} must be a string`,
        });
      }
    }
    // Turn discipline: a character only acts on its own turn. Observers
    // of someone else's action must not move (x/y) or change physical
    // state — they may only react internally (thoughts, emotion,
    // memories, beliefs, relationships). Pose/prop changes (sitting down,
    // picking something up) are observable physical acts, so they are
    // restricted like state. Any observable reply, approach,
    // or gesture belongs to their own future turn.
    // F5: `goal` is no longer observer-writable — goals drive proposals,
    // so a consequence must not reprogram another actor's goal on someone
    // else's turn. Only the acting actor's own patch may set `goal`
    // (observers still update their own goal on their own turn).
    if (action && patch.actorId !== action.actorId) {
      if (patch.x !== undefined || patch.y !== undefined) {
        errors.push({
          code: "turn_discipline.observer_moved",
          message: `actor ${patch.actorId}: only the acting actor (${action.actorId}) may move; observers must not change position`,
        });
      }
      if (patch.state !== undefined || patch.pose !== undefined || patch.prop !== undefined) {
        errors.push({
          code: "turn_discipline.observer_state_change",
          message: `actor ${patch.actorId}: only the acting actor (${action.actorId}) may change state/pose/prop; observers may only update thoughts/emotion/memories/beliefs/relationships`,
        });
      }
      if (patch.goal !== undefined) {
        errors.push({
          code: "turn_discipline.observer_goal_rewrite",
          message: `actor ${patch.actorId}: only the acting actor (${action.actorId}) may set 'goal' on this turn; observers must not rewrite another actor's goal (it drives their proposals)`,
        });
      }
    }
    for (const [field, value] of [
      ["memoriesAppend", patch.memoriesAppend],
      ["beliefsAppend", patch.beliefsAppend],
      ["relationshipsAppend", patch.relationshipsAppend],
    ] as const) {
      if (value !== undefined) {
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
          errors.push({
            code: "actor.append_not_array",
            message: `actor ${patch.actorId}: ${field} must be an array of strings`,
          });
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
      errors.push({
        code: "object.unknown_id",
        message: `unknown object id: ${patch.objectId}${hint ? ` — did you mean ${hint}?` : ""} Only the listed object ids exist — never invent variants like 'coffee mug' or 'paper'.`,
      });
      continue;
    }
    for (const field of ["x", "y", "w", "h"] as const) {
      const v = patch[field];
      if (v !== undefined && !Number.isFinite(v)) {
        errors.push({
          code: "object.field_not_finite",
          message: `object ${patch.objectId}: ${field} must be a finite number`,
        });
      }
    }
    if (patch.w !== undefined && patch.w <= 0) {
      errors.push({
        code: "object.non_positive_size",
        message: `object ${patch.objectId}: w must be positive`,
      });
    }
    if (patch.h !== undefined && patch.h <= 0) {
      errors.push({
        code: "object.non_positive_size",
        message: `object ${patch.objectId}: h must be positive`,
      });
    }
    for (const field of ["passable", "blocksVision", "blocksSound"] as const) {
      const v = patch[field];
      if (v !== undefined && typeof v !== "boolean") {
        errors.push({
          code: "object.field_not_boolean",
          message: `object ${patch.objectId}: ${field} must be a boolean`,
        });
      }
    }
    if (patch.description !== undefined && typeof patch.description !== "string") {
      errors.push({
        code: "object.description_not_string",
        message: `object ${patch.objectId}: description must be a string`,
      });
    }
    // F4: object manipulation needs proximity. Moving/resizing an object
    // or flipping its passable/blocksVision/blocksSound flags requires the
    // acting actor within OBJECT_INTERACT_RADIUS cells of the object's
    // center — a character across the room cannot teleport the coffee
    // machine or make walls passable. Description-only patches are always
    // allowed.
    if (action) {
      const touchesPhysics =
        patch.x !== undefined ||
        patch.y !== undefined ||
        patch.w !== undefined ||
        patch.h !== undefined ||
        patch.passable !== undefined ||
        patch.blocksVision !== undefined ||
        patch.blocksSound !== undefined;
      if (touchesPhysics) {
        const actingActor = actorById.get(action.actorId);
        if (actingActor) {
          const cx = obj.x + obj.w / 2;
          const cy = obj.y + obj.h / 2;
          const dist = Math.hypot(actingActor.x - cx, actingActor.y - cy);
          if (dist > OBJECT_INTERACT_RADIUS + 1e-9) {
            errors.push({
              code: "object.too_far",
              message: `actor ${action.actorId} manipulates object ${patch.objectId} from ${dist.toFixed(1)} cells away (object center at (${cx.toFixed(1)}, ${cy.toFixed(1)})): move within ${OBJECT_INTERACT_RADIUS} cells of the object first — cross-room object manipulation is not allowed (description-only patches are exempt)`,
            });
          }
        }
      }
    }
    const nx = patch.x ?? obj.x;
    const ny = patch.y ?? obj.y;
    const nw = patch.w ?? obj.w;
    const nh = patch.h ?? obj.h;
    if (nx < 0 || ny < 0 || nw <= 0 || nh <= 0 || nx + nw > world.scene.width || ny + nh > world.scene.height) {
      errors.push({
        code: "object.rect_out_of_bounds",
        message: `object ${patch.objectId}: rectangle outside scene bounds`,
      });
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
    // Exp-5 item 5 (S4): narrative-only — never pass reasoning here.
    errors.push(...validateNarrativeActors(world, { narrative: normalized.narrative }));
    // Exp-4 item 6 (S4/M1): first-person NPC prose fails fast with a
    // targeted retry hint — "I point…"/"I gesture…" diary entries (and the
    // "Dana: Dana:" doubled prefix) never reach canonical history.
    errors.push(
      ...validateNarrativeVoice(
        normalized.narrative,
        world.actors.find((a) => a.id === action.actorId)?.name,
      ),
    );
    // Exp-3 item 6 (S3): identity-theft prose must fail in the retry loop
    // too, not only on the accept path — tick 20's "I'm Dana, the new
    // hire" passed every other prose gate.
    errors.push(...validateIdentityConsistency(world, normalized.narrative, action));
    // Exp-6 item 7 (S4): alienation labels for known coworkers
    // ("approach the stranger", tick-10 repro) and invented cross-actor
    // physical causation on description patches (the coffee-stain,
    // tick-13 repro) must fail in the retry loop too.
    errors.push(...validateRelationshipLabel(world, normalized.narrative, action));
    errors.push(...validateInventedContact(world, normalized, action));
    // Exp-3 item 10 (S8): thoughts are content-gated, not just
    // presence-gated — no invented people, no ungrounded request/grant
    // claims.
    errors.push(...validateThoughtGrounding(world, action, normalized));
    errors.push(...validateObjectGrounding(world, normalized, action));
    // Exp-3 item 8 (S6): pose:sit must be backed by a chair; state labels
    // must be grammatical and point at the right landmark.
    errors.push(...validateSitPoseSeating(world, normalized, action));
    errors.push(...validateStateLabel(world, normalized, action));
    errors.push(...validateNarrativeMovementGrounding(world, normalized, action));
    // Exp-5 item 7 (S3, ticks 23/24 repro): stale "enters the office"
    // prose fails in the retry loop too, with a targeted hint.
    errors.push(...validateEnterFreshness(world, normalized.narrative, action));
    if (resolved) {
      errors.push(...validateSpeechPreservation(resolved, normalized.narrative, action.text));
      errors.push(...validateMovementIntent(world, normalized, action, resolved));
      errors.push(...validateDestinationObject(world, normalized, action, resolved));
      errors.push(...validateContactAdjacency(world, normalized, action, resolved));
      errors.push(...validateAddresseePatch(world, normalized, action, resolved, cfg));
      errors.push(...validateActingActorPresence(normalized, action, resolved));
      errors.push(...validateStateCoherence(world, normalized, action));
      errors.push(...validateActionVerbCoverage(world, action, normalized));
      errors.push(...validateObserverSubject(world, normalized, action));
    }
  } else {
    errors.push(...validateNarrativePlaceholder(normalized.narrative));
    // Exp-5 item 5 (S4): narrative-only — never pass reasoning here.
    errors.push(...validateNarrativeActors(world, { narrative: normalized.narrative }));
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
  validateSitPoseSeating,
} from "./validate/objects.js";
export {
  perceiverIds,
  validateActingActorPresence,
  validateAddresseePatch,
  validateEnterFreshness,
  validateIdentityConsistency,
  validateInventedContact,
  validateNarrativeActors,
  validateNarrativeMovementGrounding,
  validateObserverSubject,
  validateRelationshipLabel,
  validateStateCoherence,
  validateStateLabel,
  validateThoughtGrounding,
} from "./validate/narrative.js";
