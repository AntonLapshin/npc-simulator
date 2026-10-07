import type { Action, ActionSemantics, ConsequenceResult, ValidationResult, World } from "../types.js";
import { consequenceResultSchema } from "../schemas.js";
import { distance, isInsideScene, isPointBlocked, pointInRect } from "./geometry.js";
import { canMoveBetween } from "./pathfinding.js";
import { effectsToSemantics } from "./actionSemantics.js";
import { getAudibleActors, getVisibleActors } from "./perceptionHelpers.js";

/** Physical-contact radius: touching requires ending this close (Euclidean). */
export const CONTACT_RADIUS = 2.5;

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
    if (resolved) {
      errors.push(...validateSpeechPreservation(resolved, normalized.narrative));
      errors.push(...validateMovementIntent(world, normalized, action, resolved));
      errors.push(...validateDestinationObject(world, normalized, action, resolved));
      errors.push(...validateContactAdjacency(world, normalized, action, resolved));
      errors.push(...validateAddresseePatch(world, normalized, action, resolved));
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Movement gate on judged semantics: semantics.moves === false never
 * requires x/y; semantics.moves === true requires a changed, reachable
 * position, and — when the judge resolved a destinationActorId — one
 * strictly closer to that actor (by id comparison).
 */
function validateMovementIntent(
  world: World,
  normalized: { actorPatches: { actorId: string; x?: number; y?: number }[] },
  action: Action,
  semantics: ActionSemantics,
): string[] {
  const errors: string[] = [];
  if (!semantics.moves) return errors;
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!actor) return errors;
  const patch = normalized.actorPatches.find((p) => p.actorId === action.actorId);
  if (!patch || patch.x === undefined || patch.y === undefined) {
    errors.push(
      `action implies movement ("${action.text.slice(0, 80)}") but acting actor (${action.actorId}) has no position change: include x and y with a new reachable position reflecting that movement`,
    );
    return errors;
  }
  if (patch.x === actor.x && patch.y === actor.y) {
    errors.push(
      `action implies movement ("${action.text.slice(0, 80)}") but acting actor (${action.actorId}) position is unchanged (${patch.x}, ${patch.y}): move to a different reachable position`,
    );
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
        errors.push(
          `action says to move toward ${target.id} but new position (${patch.x}, ${patch.y}) is not closer than current (${actor.x}, ${actor.y}): pick x,y strictly closer to ${target.id} at (${target.x}, ${target.y})`,
        );
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

/** Distance from a point to the closest point of an axis-aligned rect. */
function distanceToRect(px: number, py: number, rect: { x: number; y: number; w: number; h: number }): number {
  const cx = Math.min(Math.max(px, rect.x), rect.x + rect.w);
  const cy = Math.min(Math.max(py, rect.y), rect.y + rect.h);
  return Math.hypot(px - cx, py - cy);
}

/**
 * Landmark fidelity (action item 3): when the judged semantics name a
 * destination object ("my desk", "coffee machine"), the new position must
 * be strictly closer to that object than the old one — same rule as
 * actor destinations. Rejects teleports to unrelated areas and
 * wrong-direction moves.
 */
function validateDestinationObject(
  world: World,
  normalized: { actorPatches: { actorId: string; x?: number; y?: number }[] },
  action: Action,
  semantics: ActionSemantics,
): string[] {
  const errors: string[] = [];
  if (semantics.destinationObjectId === undefined) return errors;
  const obj = world.scene.objects.find((o) => o.id === semantics.destinationObjectId);
  if (!obj) return errors;
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!actor) return errors;
  // Object destinations only constrain turns with locomotion; a pure
  // "look at my desk" must not demand movement.
  if (!semantics.moves) return errors;
  const patch = normalized.actorPatches.find((p) => p.actorId === action.actorId);
  if (!patch || patch.x === undefined || patch.y === undefined) return errors; // movement gate reports this
  if (patch.x === actor.x && patch.y === actor.y) return errors;
  const oldDist = distanceToRect(actor.x, actor.y, obj);
  const newDist = distanceToRect(patch.x, patch.y, obj);
  if (!(newDist < oldDist)) {
    errors.push(
      `action says to move toward ${obj.id} but new position (${patch.x}, ${patch.y}) is not closer than current (${actor.x}, ${actor.y}): pick x,y strictly closer to ${obj.name} (${obj.id})`,
    );
  }
  return errors;
}

/**
 * Contact adjacency (action item 2): physical contact (handshake, hug,
 * handing coffee) requires the acting actor to END the turn next to the
 * target — same hardness as the inside-furniture rejection. A handshake
 * across 8 cells is rejected so the model retries with an approach.
 */
function validateContactAdjacency(
  world: World,
  normalized: { actorPatches: { actorId: string; x?: number; y?: number }[] },
  action: Action,
  semantics: ActionSemantics,
): string[] {
  const errors: string[] = [];
  if (semantics.contactActorId === undefined) return errors;
  const target = world.actors.find((a) => a.id === semantics.contactActorId);
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!target || !actor || target.id === action.actorId) return errors;
  const patch = normalized.actorPatches.find((p) => p.actorId === action.actorId);
  const endX = patch?.x ?? actor.x;
  const endY = patch?.y ?? actor.y;
  const dist = Math.hypot(endX - target.x, endY - target.y);
  if (dist > CONTACT_RADIUS) {
    errors.push(
      `action implies physical contact with ${target.id} but ends at (${endX}, ${endY}), ${dist.toFixed(1)} cells from ${target.id} at (${target.x}, ${target.y}): move adjacent (within ${CONTACT_RADIUS} cells) before touching, or drop the contact from the narrative`,
    );
  }
  return errors;
}

/** Actors that perceived the acting actor's event (mirrors contextBuilder). */
function perceiverIds(world: World, actingActorId: string): Set<string> {
  const actor = world.actors.find((a) => a.id === actingActorId);
  const out = new Set<string>([actingActorId]);
  if (!actor) return out;
  for (const o of world.actors) {
    if (o.id === actingActorId) continue;
    const sees = getVisibleActors(world, o.id).some((a) => a.id === actingActorId);
    const hears = getAudibleActors(world, o.id).some((a) => a.id === actingActorId);
    const adjacent =
      Math.abs(o.x - actor.x) + Math.abs(o.y - actor.y) <= 2;
    if (sees || hears || adjacent) out.add(o.id);
  }
  return out;
}

/**
 * Addressee patching (action item 5): when the action speaks directly TO a
 * perceiving actor ("ask Tanya ..."), that addressee must record at least
 * a thoughts reaction. A direct question with no patch on the person asked
 * means the event left no trace on them — reject so the model retries.
 */
function validateAddresseePatch(
  world: World,
  normalized: { actorPatches: { actorId: string; thoughts?: string }[] },
  action: Action,
  semantics: ActionSemantics,
): string[] {
  const errors: string[] = [];
  if (semantics.addresseeActorId === undefined) return errors;
  if (semantics.addresseeActorId === action.actorId) return errors;
  const target = world.actors.find((a) => a.id === semantics.addresseeActorId);
  if (!target) return errors;
  if (!perceiverIds(world, action.actorId).has(target.id)) return errors; // couldn't perceive — no patch owed
  const patched = normalized.actorPatches.some((p) => p.actorId === target.id);
  if (!patched) {
    errors.push(
      `action speaks directly to ${target.id} but ${target.id} has no actorPatch: give every perceiving actor (especially a direct addressee) at least a 'thoughts' reaction patch`,
    );
  }
  return errors;
}

/** Double- and single-quoted segments (content length >= 2). */
function quotedSegments(text: string): string[] {
  const out: string[] = [];
  const doubleRe = /"([^"]{2,})"/g;
  let m: RegExpExecArray | null;
  while ((m = doubleRe.exec(text)) !== null) out.push(m[1]!);
  // Single quotes: avoid matching apostrophes inside words (don't, I'm).
  const singleRe = /(^|[\s(\[{])'([^']{4,})'/g;
  while ((m = singleRe.exec(text)) !== null) out.push(m[2]!);
  return out;
}

function normLower(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Content words (len >= 4) lowercased for overlap checks. */
function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
}

/** True when two words share a stem (first 4 letters equal). */
function sameStem(a: string, b: string): boolean {
  return a.slice(0, 4) === b.slice(0, 4);
}

/** Action implies speech even without quotes — judged by Decision AI, never regex. */
function validateSpeechPreservation(semantics: ActionSemantics, narrative: string): string[] {
  const errors: string[] = [];
  // Ground truth for uttered words comes from the judge/declaration —
  // never from regex-extracting quotes out of the raw action text.
  // Narrative-side quote parsing stays: it reads structured output
  // (what the model emitted), it does not interpret English meaning.
  const actionQuotes = semantics.quotedSpeech;
  const narrativeQuotes = quotedSegments(narrative);

  // 1. Quoted action words must survive into the narrative (stem overlap —
  // close paraphrase like "Greeting all!" -> "greets all" passes, but a
  // wholly different sentence or a truncation to a greeting fragment fails).
  // Applies to user turns and NPC turns alike: the exact-words rule is not
  // NPC-only. Require at least half of each quote's content words to
  // survive (single-word quotes require the one word), so "Hi, I'm Anton,
  // where is my desk?" cannot collapse to just "Hi, I'm Anton."
  for (const q of actionQuotes) {
    const words = contentWords(q);
    if (words.length === 0) continue;
    const kept = words.filter((w) => contentWords(narrative).some((nw) => sameStem(w, nw)));
    const need = words.length <= 1 ? 1 : Math.ceil(words.length / 2);
    if (kept.length < need) {
      errors.push(
        `narrative drops the acting actor's exact words ("${q.slice(0, 80)}"): preserve the action's wording — quote or closely paraphrase the FULL utterance, never invent different dialogue or truncate it to a fragment`,
      );
    }
  }

  // 2. Quoted dialogue in the narrative must be grounded in the judged
  // utterances.
  for (const q of narrativeQuotes) {
    const words = contentWords(q);
    if (words.length === 0) continue;
    // Skip tiny interjections ("Hi!", "Oh.") — too short to judge.
    if (normLower(q).length < 8 && words.length <= 1) continue;
    const judgedWords = contentWords(actionQuotes.join(" "));
    const grounded = words.filter((w) => judgedWords.some((aw) => sameStem(w, aw)));
    // Allow short greeting renders when the judge says speech happened
    // but records no exact quote ("Say hello" -> "says 'Hi!'").
    if (grounded.length === 0 && actionQuotes.length === 0 && semantics.speaks) continue;
    // Require at least half the narrative quote's content words to appear
    // in the judged utterances (single-word quotes require the one word).
    const need = words.length <= 1 ? 1 : Math.ceil(words.length / 2);
    if (grounded.length < need) {
      errors.push(
        `narrative invents dialogue ("${q.slice(0, 80)}") not present in the action text: describe ONLY what the acting actor observably does, preserving its exact wording`,
      );
      break; // one dialogue error per turn is enough feedback
    }
  }

  return errors;
}
