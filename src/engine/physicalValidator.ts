import type { Action, ConsequenceResult, ValidationResult, World } from "../types.js";
import { consequenceResultSchema } from "../schemas.js";
import { isInsideScene, isPointBlocked } from "./geometry.js";
import { canMoveBetween } from "./pathfinding.js";

/**
 * Validate ConsequenceResult output. Checks schema, referenced ids,
 * coordinates, collisions, movement paths, object rectangles, turn
 * discipline (only the acting actor may move/speak/act — other
 * actors may only change internal state: thoughts, emotion, goal,
 * memories, beliefs, relationships), and speech preservation (the
 * narrative must not invent dialogue the acting actor never said).
 * Never judges tone, morality, or social realism.
 */
export function validateConsequence(
  world: World,
  result: ConsequenceResult,
  action?: Action,
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
      ["thoughts", patch.thoughts],
    ] as const) {
      if (value !== undefined && typeof value !== "string") {
        errors.push(`actor ${patch.actorId}: ${field} must be a string`);
      }
    }
    // Turn discipline: a character only acts on its own turn. Observers
    // of someone else's action must not move (x/y) or change physical
    // state — they may only react internally (thoughts, emotion, goal,
    // memories, beliefs, relationships). Any observable reply, approach,
    // or gesture belongs to their own future turn.
    if (action && patch.actorId !== action.actorId) {
      if (patch.x !== undefined || patch.y !== undefined) {
        errors.push(
          `actor ${patch.actorId}: only the acting actor (${action.actorId}) may move; observers must not change position`,
        );
      }
      if (patch.state !== undefined) {
        errors.push(
          `actor ${patch.actorId}: only the acting actor (${action.actorId}) may change state; observers may only update thoughts/emotion/goal/memories/beliefs/relationships`,
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

  for (const patch of result.objectPatches) {    const obj = objectById.get(patch.objectId);
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

  // Speech preservation: the narrative must be grounded strictly in the
  // action text. If the user/NPC said specific words, the narrative must
  // keep them — never invent different quoted dialogue. Conversely, quoted
  // dialogue in the narrative must come from the action text (unless the
  // action clearly implies speech without quoting it, e.g. "introduce
  // yourself", where a short greeting quote is a reasonable rendering).
  if (action) {
    errors.push(...validateSpeechPreservation(action.text, result.narrative));
  }

  return { valid: errors.length === 0, errors };
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

/** Action implies speech even without quotes ("introduce yourself", ...). */
function looksLikeSpeechIntent(text: string): boolean {
  return /\b(say|says|said|speak|speaks|talk|talks|tell|tells|ask|asks|greet|greets|greeting|hello|hi\b|hey|introduce|speech|shout|whisper|reply|replies|answer|answers|exclaim|announce)\b/i.test(
    text,
  );
}

function validateSpeechPreservation(actionText: string, narrative: string): string[] {
  const errors: string[] = [];
  const actionQuotes = quotedSegments(actionText);
  const narrativeQuotes = quotedSegments(narrative);
  const narrativeNorm = normLower(narrative);
  const actionNorm = normLower(actionText);

  // 1. Quoted action words must survive into the narrative (stem overlap —
  // close paraphrase like "Greeting all!" -> "greets all" passes, but a
  // wholly different sentence fails).
  for (const q of actionQuotes) {
    const words = contentWords(q);
    if (words.length === 0) continue;
    const kept = words.filter((w) => contentWords(narrative).some((nw) => sameStem(w, nw)));
    if (kept.length === 0) {
      errors.push(
        `narrative drops the acting actor's exact words ("${q.slice(0, 80)}"): preserve the action's wording — never invent different dialogue`,
      );
    }
  }

  // 2. Quoted dialogue in the narrative must be grounded in the action.
  for (const q of narrativeQuotes) {
    const words = contentWords(q);
    if (words.length === 0) continue;
    // Skip tiny interjections ("Hi!", "Oh.") — too short to judge.
    if (normLower(q).length < 8 && words.length <= 1) continue;
    const actionWords = contentWords(actionNorm);
    const grounded = words.filter((w) => actionWords.some((aw) => sameStem(w, aw)));
    // Allow short greeting renders when the action implies speech without
    // quoting it ("Say hello" -> "says 'Hi!'").
    if (grounded.length === 0 && actionQuotes.length === 0 && looksLikeSpeechIntent(actionText)) continue;
    // Require at least half the narrative quote's content words to appear
    // in the action (single-word quotes require the one word).
    const need = words.length <= 1 ? 1 : Math.ceil(words.length / 2);
    if (grounded.length < need) {
      errors.push(
        `narrative invents dialogue ("${q.slice(0, 80)}") not present in the action text: describe ONLY what the acting actor observably does, preserving its exact wording`,
      );
      break; // one dialogue error per turn is enough feedback
    }
  }

  void narrativeNorm;
  return errors;
}
