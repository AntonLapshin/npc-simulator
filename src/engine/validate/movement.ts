// Movement validation checks (extracted from physicalValidator.ts).
//
// Phase 1 (renderer architecture): movement is engine-owned — the model
// never emits coordinates. The gates below are engine-output invariants
// (plus narrative-coherence checks), not model-retry triggers: the engine
// asserts its own output via `assertMovementInvariants` (src/core) before
// the consequence is validated, so a movement failure here is an engine
// bug, never a prompt-repair candidate.

import type { Action, ActionSemantics, ValidationError, World } from "../../types.js";
import { distance, distanceToRect } from "../../core/geometry.js";
import {
  isNonLocomotionSense,
  MAX_STEP_DISTANCE,
} from "../../core/movement.js";

// Word-sense predicates moved to the pure core (src/core/movement.ts);
// re-exported here so existing importers keep working.
export {
  isFacingOnlyTurn,
  isInterrogativeQuestion,
  isNonLocomotionSense,
} from "../../core/movement.js";
// distanceToRect moved to the pure core (src/core/geometry.ts);
// re-exported here (and via physicalValidator) for existing importers.
export { distanceToRect };

/** Physical-contact radius: touching requires ending this close (Euclidean). */
export const CONTACT_RADIUS = 2.5;

/**
 * Movement gate on judged semantics, Phase-1 edition.
 *
 * Movement is engine-owned: the engine computes the acting actor's
 * position and merges it into the consequence before validation, so the
 * model is never asked to emit coordinates. The checks below are
 * engine-output invariants (the engine asserts them via
 * `assertMovementInvariants` before validation — a failure here is an
 * engine bug, never a model-retry trigger):
 * - moves === false: the actor must stay in place (unexpected teleports
 *   still fail).
 * - moves === true: no position is demanded from the model anymore (an
 *   engine null-outcome is an honest stationary turn); when the engine
 *   did move, the output must satisfy the cap / strictly-closer rules.
 *
 * The old model-facing demands (movement.no_position_change,
 * movement.position_unchanged) and the token-shuffle progress rule
 * (movement.no_progress_actor) are gone: with engine-owned movement a
 * token shuffle is impossible by construction — the engine always takes
 * the maximum-progress step.
 */
export function validateMovementIntent(
  world: World,
  normalized: { actorPatches: { actorId: string; x?: number; y?: number }[] },
  action: Action,
  semantics: ActionSemantics,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!actor) return errors;
  // Exp-2 item 8 (S4/S5): word-sense override. An interrogative question
  // or a pure facing turn is not locomotion even when the judged semantics
  // say moves=true (LLM word-sense miss — tick 9 "where I should sit?",
  // tick 12 "turn to Dan"). The body stays in place: no position change
  // is demanded, and any position change is the unexpected teleport below.
  const moves = semantics.moves && !isNonLocomotionSense(action.text);
  if (!moves) {
    if (semantics.contactActorId === undefined) {
      const patch = normalized.actorPatches.find((p) => p.actorId === action.actorId);
      if (
        patch?.x !== undefined && patch?.y !== undefined &&
        (patch.x !== actor.x || patch.y !== actor.y)
      ) {
        const step = Math.hypot(patch.x - actor.x, patch.y - actor.y);
        // Sitting/standing relocates the body to furniture (settling into a
        // chair), so a pose-verb action may reposition — but never teleport:
        // the per-turn cap bounds it like any other turn.
        const poseAction =
          /\b(sit|sits|sitting|sat|seat|seated|stand|stands|standing|stood)\b/i.test(action.text);
        if (!poseAction || step > MAX_STEP_DISTANCE + 1e-9) {
          errors.push({
            code: "movement.unexpected_move",
            message: `action describes no movement ("${action.text.slice(0, 80)}") but acting actor (${action.actorId}) moves from (${actor.x}, ${actor.y}) to (${patch.x}, ${patch.y}): stay in place — perception, speech, and cognition never relocate the body (only explicit walk/go/head/move/approach/return-to-<place> verbs do)`,
          });
        }
      }
    }
    return errors;
  }
  const patch = normalized.actorPatches.find((p) => p.actorId === action.actorId);
  // Phase 1: the engine merges its computed position before validation, so
  // a moves=true turn with no position patch means the merge failed — the
  // engine always moves the acting actor (or honestly reports no step).
  if (!patch || patch.x === undefined || patch.y === undefined) {
    errors.push({
      code: "movement.declared_without_patch",
      message: `action declares movement (moves=true) but acting actor (${action.actorId}) has no position patch: the engine always moves the acting actor on a moves=true turn`,
    });
    return errors;
  }
  // Exp-3 item 4: per-turn displacement cap. A glance must not teleport 9+
  // cells (ticks 8/20); cross-room walks are multi-turn arcs.
  const step = Math.hypot(patch.x - actor.x, patch.y - actor.y);
  if (step > MAX_STEP_DISTANCE + 1e-9) {
    errors.push({
      code: "movement.over_step_cap",
      message: `acting actor (${action.actorId}) moves ${step.toFixed(1)} cells in one turn (from (${actor.x}, ${actor.y}) to (${patch.x}, ${patch.y})): a single turn covers at most ${MAX_STEP_DISTANCE} cells — land closer and continue next turn`,
    });
    return errors;
  }
  // When the judge resolved a movement target, the new position must
  // actually get closer to that actor (id comparison — never substring
  // search on raw text, so pronouns and descriptions resolve correctly).
  if (semantics.destinationActorId !== undefined) {
    const target = world.actors.find((a) => a.id === semantics.destinationActorId);
    if (target && target.id !== action.actorId) {
      const oldDist = Math.hypot(actor.x - target.x, actor.y - target.y);
      const newDist = Math.hypot(patch.x - target.x, patch.y - target.y);
      if (!(newDist < oldDist)) {
        errors.push({
          code: "movement.not_closer_actor",
          message: `action says to move toward ${target.id} but new position (${patch.x}, ${patch.y}) is not closer than current (${actor.x}, ${actor.y}): pick x,y strictly closer to ${target.id} at (${target.x}, ${target.y})`,
        });
      }
    }
  }
  // Teleport guard: a big single-turn jump that lands no closer to anyone
  // named is suspicious even without a resolved id — flag jumps longer than
  // half the perception radius that increase distance to every other actor.
  // (Weak judges sometimes miss the destination; this keeps cross-room
  // teleports from passing silently.)
  return errors;
}

/**
 * Landmark fidelity (action item 3): when the judged semantics name a
 * destination object ("my desk", "coffee machine"), the new position must
 * be strictly closer to that object than the old one — same rule as
 * actor destinations. Rejects teleports to unrelated areas and
 * wrong-direction moves.
 *
 * Arrival (exp-2 item 6, tick 27 repro): mere "walks toward X" only needs
 * strictly-closer, but prose that claims completion AT the landmark ("is at
 * his desk and begins typing", "fills her mug at the machine") must end
 * within ARRIVAL_RADIUS of it — closer-but-still-across-the-room is not
 * arrival.
 */
const ARRIVAL_RADIUS = 4;

export function narrativeClaimsArrival(narrative: string, objName: string, objId: string, strict = false): boolean {
  const lower = narrative.toLowerCase();
  const idSpaced = objId.toLowerCase().replace(/_/g, " ");
  const names = new Set([objName.toLowerCase(), objId.toLowerCase(), idSpaced]);
  // Also match the trailing kind word ("the coffee machine", "his desk") —
  // but ONLY in non-strict mode: for *other* landmarks a bare kind word
  // ("at his desk") cannot tell whose desk is meant, so it must not accuse
  // the wrong object (exp-3 item 4 wrong-desk check uses strict mode).
  const kind = objName.toLowerCase().split(/\s+/).slice(-1)[0] ?? "";
  const mentions =
    [...names].some((n) => n.length >= 3 && lower.includes(n)) ||
    (!strict &&
      (kind.length >= 4 && new RegExp(`\\b(at|to|beside|near|by)\\s+(?:the|his|her|their|my)?\\s*${kind}\\b`).test(lower)));
  if (!mentions) return false;
  return /\b(at|arrives?|arrived|reaches?|reached|sits?(?:\s+down)?\s+at|fills?|pours?|brews?|begins?\s+(typing|work)|starts?\s+(typing|work)|is\s+(now\s+)?at)\b/i.test(narrative);
}

export function validateDestinationObject(
  world: World,
  normalized: { narrative: string; actorPatches: { actorId: string; x?: number; y?: number }[] },
  action: Action,
  semantics: ActionSemantics,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (semantics.destinationObjectId === undefined) return errors;
  const obj = world.scene.objects.find((o) => o.id === semantics.destinationObjectId);
  if (!obj) return errors;
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!actor) return errors;
  // Object destinations only constrain turns with locomotion; a pure
  // "look at my desk" must not demand movement. Exp-2 item 8 (S4/S5):
  // same word-sense override as validateMovementIntent — a
  // facing/question turn has no locomotion to ground against a landmark.
  if (!semantics.moves || isNonLocomotionSense(action.text)) return errors;
  const patch = normalized.actorPatches.find((p) => p.actorId === action.actorId);
  // Phase 1: no patch means the engine could not move this turn (boxed in
  // / already adjacent) — an honest stationary turn, nothing to check.
  if (!patch || patch.x === undefined || patch.y === undefined) return errors;
  if (patch.x === actor.x && patch.y === actor.y) return errors;
  const oldDist = distanceToRect(actor.x, actor.y, obj);
  const newDist = distanceToRect(patch.x, patch.y, obj);
  if (!(newDist < oldDist)) {
    errors.push({
      code: "movement.not_closer_object",
      message: `action says to move toward ${obj.id} but new position (${patch.x}, ${patch.y}) is not closer than current (${actor.x}, ${actor.y}): pick x,y strictly closer to ${obj.name} (${obj.id})`,
    });
    // Exp-3 item 7 (S5, A2): the arrival/wrong-landmark sub-checks are
    // skipped only for FUZZY destinations (explicit === false). A fuzzy
    // keyword-fallback resolution may name the wrong object — enforcing
    // arrival AT it would reject good movement toward the true target.
    // Strictly-closer above still applies. Tri-state: undefined (legacy
    // or manually-built semantics) runs the checks — backward compatible.
  } else if (
    semantics.destinationObjectExplicit !== false &&
    narrativeClaimsArrival(normalized.narrative, obj.name, obj.id) &&
    newDist > ARRIVAL_RADIUS
  ) {
    errors.push({
      code: "movement.arrival_too_far",
      message: `narrative claims to be AT ${obj.name} (${obj.id}) but ends at (${patch.x}, ${patch.y}), ${newDist.toFixed(1)} cells away: land within ${ARRIVAL_RADIUS} cells of it (next to it, never inside) or drop the arrival claim`,
    });
  }
  // Phase 1: the old movement.no_progress_object token-shuffle rule is
  // gone — with engine-owned movement a token shuffle is impossible by
  // construction (the engine always takes the maximum-progress step).
  // Exp-3 item 4: forbid claiming a DIFFERENT landmark ("stands next to
  // Tanya's desk" for "my desk" — tick 15). Strict name/id matching only:
  // a bare kind word ("at his desk") cannot identify the object. Exp-3
  // item 7 (S5): skipped for fuzzy destinations (explicit === false) —
  // see the arrival gate above.
  if (semantics.destinationObjectExplicit !== false) {
    for (const other of world.scene.objects) {
      if (other.id === obj.id) continue;
      if (narrativeClaimsArrival(normalized.narrative, other.name, other.id, true)) {
        errors.push({
          code: "movement.wrong_landmark",
          message: `narrative claims arrival at ${other.name} (${other.id}) but the action targets ${obj.name} (${obj.id}): move toward the named target, never claim a different landmark`,
        });
        break;
      }
    }
  }
  return errors;
}

/**
 * Contact adjacency (action item 2): physical contact (handshake, hug,
 * handing coffee) requires the acting actor to END the turn next to the
 * target — same hardness as the inside-furniture rejection. A handshake
 * across 8 cells is rejected so the model retries with an approach.
 */
export function validateContactAdjacency(
  world: World,
  normalized: { actorPatches: { actorId: string; x?: number; y?: number }[] },
  action: Action,
  semantics: ActionSemantics,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (semantics.contactActorId === undefined) return errors;
  const target = world.actors.find((a) => a.id === semantics.contactActorId);
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!target || !actor || target.id === action.actorId) return errors;
  const patch = normalized.actorPatches.find((p) => p.actorId === action.actorId);
  const endX = patch?.x ?? actor.x;
  const endY = patch?.y ?? actor.y;
  const dist = Math.hypot(endX - target.x, endY - target.y);
  if (dist > CONTACT_RADIUS) {
    errors.push({
      code: "contact.too_far",
      message: `action implies physical contact with ${target.id} but ends at (${endX}, ${endY}), ${dist.toFixed(1)} cells from ${target.id} at (${target.x}, ${target.y}): move adjacent (within ${CONTACT_RADIUS} cells) before touching, or drop the contact from the narrative`,
    });
  }
  return errors;
}
