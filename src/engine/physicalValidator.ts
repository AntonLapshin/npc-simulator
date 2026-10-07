import type { Action, ActionSemantics, ConsequenceResult, ValidationResult, World } from "../types.js";
import { consequenceResultSchema } from "../schemas.js";
import { distance, isInsideScene, isPointBlocked, pointInRect } from "./geometry.js";
import { canMoveBetween } from "./pathfinding.js";
import { MAX_STEP_DISTANCE, requiredProgress } from "./movementAssist.js";
import { effectsToSemantics } from "./actionSemantics.js";
import { getAudibleActors, getVisibleActors } from "./perceptionHelpers.js";

/** Physical-contact radius: touching requires ending this close (Euclidean). */
export const CONTACT_RADIUS = 2.5;

/** Edit distance between two strings (case-insensitive). */
function editDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const dp: number[][] = Array.from({ length: x.length + 1 }, (_, i) =>
    Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      dp[i]![j]! = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[x.length]![y.length]!;
}

/**
 * Exp-3 item 7: fuzzy id repair. The validator already names the unknown
 * id — append the closest roster ids (edit distance, normalized names
 * compared so "coffee mug" meets "lounge_mug") so the retry can succeed
 * instead of falling back. Returns e.g. `"anton_mug", "dana_mug"` or "".
 */
export function suggestSimilarIds(unknownId: string, candidates: string[], k = 3): string {
  const norm = (s: string): string[] => {
    const base = [s.toLowerCase()];
    // "tanya's_desk"-style possessives: compare the de-possessivized form too.
    const deposs = s.toLowerCase().replace(/['']s/g, "s").replace(/_/g, " ");
    if (deposs !== base[0]) base.push(deposs);
    return base;
  };
  const scored = candidates.map((c) => {
    const variants = norm(c);
    const uVariants = norm(unknownId);
    let best = Infinity;
    for (const cv of variants) {
      for (const uv of uVariants) {
        // Token overlap shortcut: "coffee mug" shares "mug" with "*_mug".
        const cToks = new Set(cv.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
        const uToks = new Set(uv.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
        const shared = [...uToks].filter((t) => cToks.has(t)).length;
        const d = editDistance(uv, cv) - shared * 3;
        if (d < best) best = d;
      }
    }
    return { id: c, score: best };
  });
  scored.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return scored
    .slice(0, k)
    .filter((s) => s.score <= Math.max(unknownId.length, 4) + 4)
    .map((s) => `"${s.id}"`)
    .join(", ");
}

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
    if (resolved) {
      errors.push(...validateSpeechPreservation(resolved, normalized.narrative));
      errors.push(...validateMovementIntent(world, normalized, action, resolved));
      errors.push(...validateDestinationObject(world, normalized, action, resolved));
      errors.push(...validateContactAdjacency(world, normalized, action, resolved));
      errors.push(...validateAddresseePatch(world, normalized, action, resolved));
      errors.push(...validateActingActorPresence(normalized, action, resolved));
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

/**
 * Movement gate on judged semantics: semantics.moves === false never
 * requires x/y; semantics.moves === true requires a changed, reachable
 * position, and — when the judge resolved a destinationActorId — one
 * strictly closer to that actor (by id comparison).
 *
 * Phase 2 (exp-3 item 3, ticks 8/20): the mirror direction also holds —
 * with moves === false the acting actor must STAY in place. A glance, a
 * question, or a sip never relocates the body, so a position change on
 * such a turn is a teleport, not progress. Contact-driven approaches are
 * exempt (a handshake turn legitimately closes to adjacency — enforced
 * separately by the contact gate).
 */
function validateMovementIntent(
  world: World,
  normalized: { actorPatches: { actorId: string; x?: number; y?: number }[] },
  action: Action,
  semantics: ActionSemantics,
): string[] {
  const errors: string[] = [];
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!actor) return errors;
  if (!semantics.moves) {
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
          errors.push(
            `action describes no movement ("${action.text.slice(0, 80)}") but acting actor (${action.actorId}) moves from (${actor.x}, ${actor.y}) to (${patch.x}, ${patch.y}): stay in place — perception, speech, and cognition never relocate the body (only explicit walk/go/head/move/approach/return-to-<place> verbs do)`,
          );
        }
      }
    }
    return errors;
  }
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
  // Exp-3 item 4: per-turn displacement cap. A glance must not teleport 9+
  // cells (ticks 8/20); cross-room walks are multi-turn arcs.
  const step = Math.hypot(patch.x - actor.x, patch.y - actor.y);
  if (step > MAX_STEP_DISTANCE + 1e-9) {
    errors.push(
      `acting actor (${action.actorId}) moves ${step.toFixed(1)} cells in one turn (from (${actor.x}, ${actor.y}) to (${patch.x}, ${patch.y})): a single turn covers at most ${MAX_STEP_DISTANCE} cells — land closer and continue next turn`,
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
      } else {
        // Exp-3 item 4: real progress for named cross-room walks — a
        // 0.8-cell shuffle toward a 12-cell-distant target is not a walk.
        // Tolerance of one cell covers integer-grid quantization (a full
        // 6-cell diagonal step closes ~5.9 cells of Euclidean distance).
        const need = requiredProgress(oldDist);
        if (need > 0 && oldDist - newDist < need - 1.0) {
          errors.push(
            `action says to move toward ${target.id} ${oldDist.toFixed(1)} cells away but only closes ${(oldDist - newDist).toFixed(1)} cells: make real progress (at least ${need.toFixed(1)} cells) or arrive — a token shuffle toward a distant target is not the walk`,
          );
        }
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
 *
 * Arrival (exp-2 item 6, tick 27 repro): mere "walks toward X" only needs
 * strictly-closer, but prose that claims completion AT the landmark ("is at
 * his desk and begins typing", "fills her mug at the machine") must end
 * within ARRIVAL_RADIUS of it — closer-but-still-across-the-room is not
 * arrival.
 */
const ARRIVAL_RADIUS = 4;

function narrativeClaimsArrival(narrative: string, objName: string, objId: string, strict = false): boolean {
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

function validateDestinationObject(
  world: World,
  normalized: { narrative: string; actorPatches: { actorId: string; x?: number; y?: number }[] },
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
  } else if (narrativeClaimsArrival(normalized.narrative, obj.name, obj.id) && newDist > ARRIVAL_RADIUS) {
    errors.push(
      `narrative claims to be AT ${obj.name} (${obj.id}) but ends at (${patch.x}, ${patch.y}), ${newDist.toFixed(1)} cells away: land within ${ARRIVAL_RADIUS} cells of it (next to it, never inside) or drop the arrival claim`,
    );
  } else {
    // Exp-3 item 4: real progress for named cross-room walks (tick 15: a
    // 1-cell shuffle toward a 12-cell-distant desk passed as "progress").
    // One-cell tolerance covers integer-grid quantization (see above).
    const need = requiredProgress(oldDist);
    if (need > 0 && oldDist - newDist < need - 1.0) {
      errors.push(
        `action says to move toward ${obj.name} (${obj.id}) ${oldDist.toFixed(1)} cells away but only closes ${(oldDist - newDist).toFixed(1)} cells: make real progress (at least ${need.toFixed(1)} cells) or arrive — a token shuffle is not the walk`,
      );
    }
  }
  // Exp-3 item 4: forbid claiming a DIFFERENT landmark ("stands next to
  // Tanya's desk" for "my desk" — tick 15). Strict name/id matching only:
  // a bare kind word ("at his desk") cannot identify the object.
  for (const other of world.scene.objects) {
    if (other.id === obj.id) continue;
    if (narrativeClaimsArrival(normalized.narrative, other.name, other.id, true)) {
      errors.push(
        `narrative claims arrival at ${other.name} (${other.id}) but the action targets ${obj.name} (${obj.id}): move toward the named target, never claim a different landmark`,
      );
      break;
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

/**
 * Placeholder/schema-leak gate (exp-2 item 1, tick 4 repro): a narrative of
 * `"string"`, `"(none)"`, or an echo of the action text means the model
 * emitted schema filler instead of a consequence. Cheap string check that
 * runs on every turn, with or without judged semantics.
 */
const PLACEHOLDER_NARRATIVES = new Set([
  "string", "(none)", "none", "n/a", "na", "no change", "(no change)",
  "no-change", "nothing", "nothing changes", "...", "-", "null", "undefined",
  "(...)", "tbd",
]);

function stripForCompare(s: string): string {
  return s
    .trim()
    .replace(/^["'(\[]+/, "")
    .replace(/["')\].,;:!?]+$/, "")
    .trim()
    .toLowerCase();
}

function validateNarrativePlaceholder(narrative: string, action?: Action): string[] {
  const stripped = stripForCompare(narrative);
  if (PLACEHOLDER_NARRATIVES.has(stripped)) {
    return [
      `narrative is a placeholder ("${narrative.slice(0, 80)}"): describe ONLY what the acting actor observably does, grounded in the action text — never emit schema filler`,
    ];
  }
  if (action && stripped.length > 0 && stripped === stripForCompare(action.text)) {
    return [
      `narrative echoes the action text verbatim instead of describing the outcome: narrate what observably happens as a result of the action`,
    ];
  }
  return [];
}

/**
 * Acting-actor presence (exp-2 item 2, tick 11 repro): a turn whose judged
 * meaning is locomotion or physical contact must leave a trace on the acting
 * actor itself. Patches on observers only (or no patches at all for contact)
 * mean the actor did nothing while someone else reacted — reject so the
 * model retries with the acting actor patched. Symmetric to the existing
 * observer-move rule. Speech-only turns with zero patches stay allowed
 * (a greeting need not change state), and fail-open turns without semantics
 * are untouched.
 */
function validateActingActorPresence(
  normalized: { actorPatches: { actorId: string }[] },
  action: Action,
  semantics: ActionSemantics,
): string[] {
  const needsActor = semantics.moves || semantics.contactActorId !== undefined;
  if (!needsActor) return [];
  const hasActing = normalized.actorPatches.some((p) => p.actorId === action.actorId);
  if (!hasActing) {
    const kind = semantics.contactActorId !== undefined ? "physical contact" : "movement";
    return [
      `action implies ${kind} but acting actor (${action.actorId}) has no actorPatch (only observers patched, or none): patch the acting actor itself with the movement/contact outcome`,
    ];
  }
  return [];
}

/** Capitalized words that are never person names (greetings, time, office vocab). */
const COMMON_CAPITALIZED = new Set(
  [
    "morning", "afternoon", "evening", "hello", "hi", "hey", "thanks", "thank",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
    "office", "coffee", "desk", "laptop", "mug", "chair", "room", "team", "work",
    "weekend", "lunch", "kitchen", "entrance", "door", "machine", "table", "sofa",
    "sixt", "qa", "api", "apis", "backend", "frontend",
    "welcome", "good", "great", "nice", "sorry",
    "okay", "well", "just", "still", "back", "here", "there", "this", "that",
    "what", "who", "how", "when", "where", "nothing", "something", "someone",
  ].map((w) => w.toLowerCase()),
);

/**
 * Narrative name audit (exp-2 item 3, ticks 2/5/14 repro): the patch-ID
 * checks above cannot see names that appear only in prose ("walks closer to
 * Jeff" with no Jeff patch passes them). Scan the narrative and reasoning
 * for person mentions in person-context positions (spoken address,
 * movement toward, or X-does-Y verbs) and fail names that match neither the
 * roster nor visible object vocabulary. Only person-context matches are
 * considered — not every capitalized word — so scene prose ("Office",
 * "Morning") does not trip the gate.
 */
function validateNarrativeActors(
  world: World,
  normalized: { narrative: string; reasoning?: string },
): string[] {
  const roster = new Map<string, string>();
  for (const a of world.actors) {
    roster.set(a.name.toLowerCase(), a.id);
    roster.set(a.id.toLowerCase(), a.id);
    for (const tok of a.name.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length >= 3 && !roster.has(tok)) roster.set(tok, a.id);
    }
  }
  const objectTokens = new Set<string>();
  for (const o of world.scene.objects) {
    for (const src of [o.name, o.id]) {
      for (const tok of src.toLowerCase().split(/[^a-z0-9]+/)) {
        if (tok.length >= 3) objectTokens.add(tok);
      }
    }
  }
  const text = `${normalized.narrative} ${normalized.reasoning ?? ""}`;
  const personContext: RegExp[] = [
    /\b(?:hey|hi|hello|dear|toward|towards|to|with|for|at|near|beside|behind|greets?|greeting|pats?|hugs?|embraces?|handshake with|welcomes?|thanks?|asks?|tells?|sees?|approaches?|walks?(?: closer)? to)\s+([A-Z][a-z]{2,})\b/g,
    /\b([A-Z][a-z]{2,})\s+(?:says|sips|walks|turns|nods|smiles|laughs|stands|waves|looks|replies|shouts|whispers|types|sits|stands up|picks)\b/g,
    // Quoted vocatives: "Hey Jeff, welcome!" — the greeting verb sits inside
    // quotes with punctuation between it and the addressee (tick 5 repro).
    // Case-sensitive on purpose: with the `i` flag [A-Z] would also match
    // lowercase words ("Hi all" -> "all").
    /\b(?:[Hh]ey|[Hh]i|[Hh]ello|[Dd]ear|[Ww]elcome)\s+([A-Z][a-z]{2,})\b/g,
  ];
  const suspects = new Set<string>();
  for (const re of personContext) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) suspects.add(m[1]!);
  }
  for (const s of suspects) {
    const lower = s.toLowerCase();
    if (roster.has(lower)) continue;
    if (objectTokens.has(lower)) continue;
    if (COMMON_CAPITALIZED.has(lower)) continue;
    return [
      `narrative names unknown actor "${s}" with no roster entry or patch: only the listed actors exist — describe only them, never invent or address anyone else`,
    ];
  }
  return [];
}

/**
 * Mask "return/back to <activity>" so resuming a task ("returns to typing")
 * is not read as starting an object interaction.
 */
function maskResumedActivity(t: string): string {
  let out = t;
  out = out.replace(
    /\breturn\w*\s+to\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?[a-z]+ing\b/gi,
    " ",
  );
  out = out.replace(
    /\breturn\w*\s+to\s+(work|tasks?|focus|focusing|business|dut(y|ies))\b/gi,
    " ",
  );
  out = out.replace(
    /\b(?:go\w*|get\w*|come\w*|turn\w*)\s+back\s+to\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?[a-z]+ing\b/gi,
    " ",
  );
  out = out.replace(
    /\bback\s+to\s+(?:(?:the|a|an|his|her|their|my|your|its)\s+)?[a-z]+ing\b/gi,
    " ",
  );
  out = out.replace(/\bback\s+to\s+(work|tasks?|focus|business|dut(y|ies))\b/gi, " ");
  return out;
}

/**
 * Object grounding (exp-2 item 7 — 30/30 empty objectPatches repro): prose
 * that brews, pours, sips, types, opens, picks up, or sits must be backed by
 * a matching patch. Narrative-side verb matching only (reads structured
 * output, never interprets action intent — that stays with the judge).
 * Already-held props satisfy sip/type (sipping from a held cup changes
 * nothing), but brewing/pouring/picking up always demand a fresh patch.
 */
function validateObjectGrounding(
  world: World,
  normalized: {
    narrative: string;
    actorPatches: { actorId: string; pose?: string; prop?: string | null }[];
    objectPatches: { objectId: string }[];
  },
  action?: Action,
): string[] {
  const errors: string[] = [];
  const text = maskResumedActivity(normalized.narrative);
  const actingId = action?.actorId;
  const actingPatch = actingId !== undefined
    ? normalized.actorPatches.find((p) => p.actorId === actingId)
    : undefined;
  const actingWorld = actingId !== undefined
    ? world.actors.find((a) => a.id === actingId)
    : undefined;
  const hasObjectPatch = normalized.objectPatches.length > 0;
  const holdsSomething =
    (actingPatch?.prop ?? undefined) !== undefined
      ? actingPatch!.prop !== null
      : (actingWorld?.prop ?? null) !== null;
  const propPatched = actingPatch?.prop !== undefined;

  if (/\b(sits?|sitting|sat)\b|\btakes? a seat\b/i.test(text)) {
    const poseOk =
      actingPatch?.pose !== undefined || (actingWorld?.pose ?? "stand") === "sit";
    if (!poseOk) {
      errors.push(
        `narrative describes sitting but no pose patch sets it: include pose ("sit") on the acting actor${actingId ? ` (${actingId})` : ""}`,
      );
    }
  }
  if (/\b(brews?|brewing|pours?|pouring|fills?(?:ing)? (?:his|her|their|my|the|a) mug|makes? coffee)\b/i.test(text)) {
    if (!hasObjectPatch && !propPatched) {
      errors.push(
        `narrative describes brewing/pouring but no object patch backs it: add an objectPatch for the coffee machine/mug (or a prop patch for the cup picked up)`,
      );
    }
  }
  if (/\b(picks?\s+up|picking\s+up|picked\s+up|grabs?|takes? (?:the|his|her|their|my|your|its|a|an) (?:laptop|mug|cup|bag|chair|papers?|phone|monitor))\b/i.test(text)) {
    if (!propPatched && !hasObjectPatch) {
      errors.push(
        `narrative describes picking something up but no prop/object patch backs it: set prop on the acting actor (or an objectPatch for what moved)`,
      );
    }
  }
  if (/\b(opens?(?:ing)? (?:his|her|their|my|the|a|an) laptop|boots?(?:ing)? (?:up )?(?:his|her|their|my|the|a|an)? ?laptop|powers? on)\b/i.test(text)) {
    if (!propPatched && !hasObjectPatch && !holdsSomething) {
      errors.push(
        `narrative describes opening/booting a laptop but no prop/object patch backs it: set prop ("laptop") on the acting actor or add the matching objectPatch`,
      );
    }
  }
  if (/\b(sips?|sipping|sipped|drinks?|drinking|drank|swigs?|gulps?|types?|typing|typed)\b/i.test(text)) {
    if (!propPatched && !hasObjectPatch && !holdsSomething) {
      errors.push(
        `narrative describes sipping/drinking/typing but the acting actor holds nothing and no prop/object patch backs it: set prop (cup/laptop) or add the matching objectPatch`,
      );
    }
  }
  // Phase 3 (exp-3 item 2, tick 11 shape): holding/carrying is an object
  // interaction like picking up — a narrative that holds a cup with no
  // prop/object patch is ungrounded, even when the verb is "hold".
  // ("carry on" / "held a meeting" are not object verbs — excluded so
  // task-resumption prose never trips this gate.)
  if (/\b(holds?|holding|carr(?:y|ies|ied|ying))\b(?!\s+on\b)/i.test(text)) {
    if (!propPatched && !hasObjectPatch && !holdsSomething) {
      errors.push(
        `narrative describes holding/carrying but the acting actor holds nothing and no prop/object patch backs it: set prop (cup/laptop) or add the matching objectPatch`,
      );
    }
  }
  return errors;
}

/**
 * Exp-3 item 2 (strict half): action-side verb coverage. The pose/prop/
 * object/contact gates read the *narrative*, so a consequence can dodge
 * them by omitting the verb ("stands" for a "sit" action, no "pour" for a
 * pour action, speech-only for a handshake). The action text is never
 * checked against patches — now it is:
 * - contact verb + named roster actor in the action → the narrative must
 *   mention the contact (handshake→shake/hand, hug→hug, ...). Adjacency is
 *   already enforced via semantics; this closes the silent-drop half.
 * - sit/stand in the action → a matching pose patch (or the narrative
 *   describing it — the narrative-side gate already demands the patch then).
 * - pour/brew/fill/open/boot in the action → an objectPatch or prop patch,
 *   regardless of what the narrative says.
 * - ask (or "?") in the action → the narrative must keep the question (a
 *   "?" or an ask-verb); answering-by-thanking flips fail here.
 */
function validateActionVerbCoverage(
  world: World,
  action: Action,
  normalized: {
    narrative: string;
    actorPatches: { actorId: string; x?: number; y?: number; pose?: string; prop?: string | null }[];
    objectPatches: { objectId: string }[];
  },
): string[] {
  const errors: string[] = [];
  const text = action.text;
  const narrative = normalized.narrative;
  const actingPatch = normalized.actorPatches.find((p) => p.actorId === action.actorId);

  const namesRosterActor =
    world.actors.filter((a) => a.id !== action.actorId).some((a) => {
      const lowered = text.toLowerCase();
      return (
        (a.id.toLowerCase().length >= 2 && lowered.includes(a.id.toLowerCase())) ||
        (a.name.toLowerCase().length >= 2 && lowered.includes(a.name.toLowerCase()))
      );
    });
  /** Roster actors (other than the acting actor) named in the action text. */
  const namedRosterActors = world.actors.filter((a) => {
    if (a.id === action.actorId) return false;
    const lowered = text.toLowerCase();
    return (
      (a.id.toLowerCase().length >= 2 && lowered.includes(a.id.toLowerCase())) ||
      (a.name.toLowerCase().length >= 2 && lowered.includes(a.name.toLowerCase()))
    );
  });

  if (
    /\b(handshake|shake\s+.*hands?|shake\s+.*hand|hug|embrace|kiss|high[\s-]?five|fist[\s-]?bump|\bpat\b|slap|hands?\s+over|handing|hands?\s+(him|her|them)|give\s+.*(coffee|cup)|pass\s+.*(coffee|cup))\b/i.test(
      text,
    ) &&
    namesRosterActor
  ) {
    if (!/\b(shake|shook|hands?|hug|embrace|kiss|high[\s-]?five|fist|pat|slap|give|gave|pass|hand)\b/i.test(narrative)) {
      errors.push(
        `action describes physical contact ("${text.slice(0, 80)}") but the narrative never mentions it: narrate the handshake/hug/handover (dodging the verb does not excuse dropping the contact)`,
      );
    }
    // Phase 3 (exp-3 item 2, tick 12 symmetric hole): the semantics-owned
    // adjacency gate only fires when effects/judge declare contactActorId —
    // a consequence that silently drops the contact declaration dodges it.
    // The action text itself names the contact, so require the acting actor
    // to end adjacent to at least one named roster actor regardless of
    // what was declared.
    const actor = world.actors.find((a) => a.id === action.actorId);
    if (actor && namedRosterActors.length > 0) {
      const patch = normalized.actorPatches.find((p) => p.actorId === action.actorId);
      const endX = patch?.x ?? actor.x;
      const endY = patch?.y ?? actor.y;
      const close = namedRosterActors.some(
        (t) => Math.hypot(endX - t.x, endY - t.y) <= CONTACT_RADIUS,
      );
      if (!close) {
        const t = namedRosterActors[0]!;
        const dist = Math.hypot(endX - t.x, endY - t.y).toFixed(1);
        errors.push(
          `action describes physical contact with ${t.id} but ends at (${endX}, ${endY}), ${dist} cells away: end adjacent (within ${CONTACT_RADIUS} cells) before touching — a handshake across the room is not contact`,
        );
      }
    }
  }

  const sitMatch = /\bsit\b|\bsits\b|\bsitting\b|\bsat\b|\btake[sn]?\s+a\s+seat\b/i.test(text);
  const standMatch = /\bstand\b|\bstands\b|\bstanding\b|\bstood\b|\bstand\s+up\b/i.test(text);
  if (sitMatch && !standMatch) {
    const poseOk =
      actingPatch?.pose === "sit" || /\b(sit|sits|sitting|sat|seat|seated)\b/i.test(narrative);
    if (!poseOk) {
      errors.push(
        `action says to sit ("${text.slice(0, 80)}") but the consequence neither sets pose ("sit") nor describes sitting: sitting without the matching patch is incomplete (saying "stands" instead fails)`,
      );
    }
  } else if (standMatch && !sitMatch) {
    const poseOk =
      actingPatch?.pose === "stand" || /\b(stand|stands|standing|stood)\b/i.test(narrative);
    if (!poseOk) {
      errors.push(
        `action says to stand ("${text.slice(0, 80)}") but the consequence neither sets pose ("stand") nor describes standing`,
      );
    }
  }

  // "open" counts only as a verb with an object ("open the door", "open his
  // laptop") — never as an adjective ("an open and welcoming demeanor").
  if (
    /\b(brew|brews|pour|pours|fill|fills|boot|boots|mak(e|es|ing)\s+coffee)\b/i.test(text) ||
    /\bopens?\s+(?:his|her|their|my|the|a|an|that|this)\s+[a-z]+\b/i.test(text)
  ) {
    const backed =
      normalized.objectPatches.length > 0 || actingPatch?.prop !== undefined;
    if (!backed) {
      errors.push(
        `action says to pour/brew/open ("${text.slice(0, 80)}") but no objectPatch/prop patch backs it: omitting the verb from the narrative does not excuse omitting the patch`,
      );
    }
  }

  // Phase 3 (exp-3 item 2): taking hold of something is an object
  // interaction like pouring — "Set down the mug" / "Hold the cup" with no
  // prop/object patch dodges the grounding gate by omission. "take" only
  // counts with a concrete object ("take the laptop" — never "take a walk",
  // "take a seat", "take notes"); "carry on" is resumption, not carrying.
  if (
    /\bpick(?:s|ed|ing)?\s+up\b/i.test(text) ||
    /\bgrab(?:s|bed|bing)?\b/i.test(text) ||
    /\bholds?\b|\bholding\b/i.test(text) ||
    /\bcarr(?:y|ies|ied|ying)\b(?!\s+on\b)/i.test(text) ||
    /\btakes?\s+(?:the|his|her|their|my|your|its|a|an)\s+(?:laptop|mug|cup|bag|chair|papers?|phone|monitor)\b/i.test(text)
  ) {
    const backed =
      normalized.objectPatches.length > 0 || actingPatch?.prop !== undefined;
    if (!backed) {
      errors.push(
        `action says to pick up/hold ("${text.slice(0, 80)}") but no objectPatch/prop patch backs it: omitting the verb from the narrative does not excuse omitting the patch`,
      );
    }
  }

  if (/\bask\w*\b|\?/.test(text)) {
    if (!narrative.includes("?") && !/\bask\w*|questions?\b/i.test(narrative)) {
      errors.push(
        `action asks a question ("${text.slice(0, 80)}") but the narrative keeps no question (no "?" and no ask-verb): preserve the question instead of replacing it (e.g. with thanks)`,
      );
    }
  }

  // Phase 3 (exp-3 item 2, tick 18): speech dropped without a trace. The
  // quote gate only guards quoted segments, and the ask gate only guards
  // questions — so "Thank both, then head to the desk" narrated as "looks
  // around" passes with the entire utterance erased (the judge even agreed
  // speaks=false). When the action text carries an explicitly verbal verb
  // (thank/say/tell — ask/? stays with the ask gate above), the narrative
  // must render speech: a quote or a speech verb of its own.
  // Greet/welcome are deliberately excluded: they can be rendered
  // non-verbally (walking over, waving), and the golden path relies on it.
  if (
    /\b(say|says|said|tell|tells|told|thank|thanks|thanked|answer|answers|answered|repl(?:y|ies|ied)|mention|mentions|mentioned|explain|explains|explained|announce|announces|announced|shout|shouts|shouted|whisper|whispers|whispered|talk|talks|talked|speak|speaks|spoke|spoken|call|calls|called)\b/i.test(text) ||
    /\bcall\s+out\b/i.test(text)
  ) {
    if (!/\bask\w*\b|\?/.test(text)) {
      const rendersSpeech =
        narrative.includes("?") ||
        quotedSegments(narrative).length > 0 ||
        /\b(say|says|said|tell|tells|told|thank|thanks|thanked|greet|greets|greeted|greeting|welcome|welcomes|welcomed|ask|asks|asked|answer|answers|answered|repl(?:y|ies|ied)|mentions?|mentioned|explain|explains|explained|announce|announces|announced|shout|shouts|shouted|whisper|whispers|whispered|talk|talks|talked|speak|speaks|spoke|spoken|call|calls|called)\b/i.test(narrative);
      if (!rendersSpeech) {
        errors.push(
          `action says something ("${text.slice(0, 80)}") but the narrative renders no speech (no quote and no speech verb): preserve what is said instead of replacing it with silent behavior`,
        );
      }
    }
  }

  return errors;
}

/**
 * Exp-3 item 5: observer-as-subject prose check (tick 13 repro). The
 * narrative must describe ONLY the acting actor — the name audit catches
 * unknown names, but a roster observer cast as the grammatical subject
 * ("Anton shakes Tanya's hand." on Tanya's turn) sails through. Split the
 * narrative into clauses (sentence boundaries and "and"-joins) and fail
 * clauses led by a roster observer's name/id directly followed by an
 * observable-action verb. Name-as-landmark ("toward Jeff") and possessives
 * ("Tanya's hand") do not match — only Name + verb.
 */
const OBSERVER_SUBJECT_VERBS = new Set(
  [
    "is", "was", "are", "were", "has", "had",
    "says", "said", "speak", "speaks", "spoke", "talks", "talked", "tells", "told",
    "asks", "asked", "replies", "replied", "answers", "answered", "shouts", "shouted",
    "whispers", "whispered", "mutters", "muttered", "calls", "called", "thanks", "thanked",
    "greets", "greeted", "welcomes", "welcomed", "waves", "waved",
    "walks", "walked", "goes", "went", "comes", "came", "moves", "moved",
    "stands", "stood", "sits", "sat", "turns", "turned", "approaches", "approached",
    "enters", "entered", "leaves", "left", "returns", "returned", "joins", "joined",
    "follows", "followed", "runs", "ran",
    "looks", "looked", "watches", "watched", "sees", "saw", "nods", "nodded",
    "smiles", "smiled", "laughs", "laughed", "shakes", "shook", "hugs", "hugged",
    "hands", "handed", "gives", "gave", "takes", "took", "picks", "picked",
    "opens", "opened", "pours", "poured", "types", "typed", "sips", "sipped",
    "gestures", "gestured", "points", "pointed", "shrugs", "shrugged",
  ].map((w) => w.toLowerCase()),
);

function validateObserverSubject(
  world: World,
  normalized: { narrative: string },
  action: Action,
): string[] {
  const observers = world.actors.filter((a) => a.id !== action.actorId);
  if (observers.length === 0) return [];
  const names: Array<{ token: string; id: string }> = [];
  for (const o of observers) {
    names.push({ token: o.name.toLowerCase(), id: o.id });
    names.push({ token: o.id.toLowerCase(), id: o.id });
    const first = o.name.toLowerCase().split(/[^a-z0-9]+/)[0];
    if (first && first.length >= 3) names.push({ token: first, id: o.id });
  }
  const clauses = normalized.narrative
    .split(/[.!?;]+\s*|\s+and\s+/i)
    .map((c) => c.replace(/^["'(\[]+/, "").trim().toLowerCase())
    .filter((c) => c.length > 0);
  for (const clause of clauses) {
    for (const { token, id } of names) {
      if (token.length < 2) continue;
      if (!clause.startsWith(token)) continue;
      const rest = clause.slice(token.length);
      // Name must be a whole word followed by whitespace + verb
      // ("Anton shakes..." matches; "Anton's hand" and "Anton," do not).
      const verbMatch = rest.match(/^\s+([a-z]+)/);
      if (!verbMatch) continue;
      if (OBSERVER_SUBJECT_VERBS.has(verbMatch[1]!)) {
        return [
          `narrative casts roster observer "${id}" as the acting subject ("${clause.slice(0, 60)}...") on ${action.actorId}'s turn: describe ONLY what the acting actor (${action.actorId}) observably does — observers react in thoughts patches, never in the narrative`,
        ];
      }
      break; // clause starts with this observer's name but no verb — no error
    }
  }
  return [];
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

/**
 * Exp-3 item 2 (lenient half): an interrogative quote ("could you show me
 * where my desk is?") survives as a paraphrase when the narrative keeps the
 * question structure — a "?" or an ask-verb (asks for directions) — plus at
 * least one shared content word (the topic, e.g. "desk"). This passes the
 * tick-3 paraphrase ("Anton asks Tanya for directions to his desk") while
 * still failing truncations ("Hi, I'm Anton" keeps no ?/ask verb) and
 * flipped speech ("thanks Anton, looking pleased" has no ask verb).
 */
function questionPreserved(actionQuote: string, narrative: string): boolean {
  if (!actionQuote.includes("?")) return false;
  const hasQuestionForm = narrative.includes("?") || /\bask\w*|questions?\b/i.test(narrative);
  if (!hasQuestionForm) return false;
  const words = contentWords(actionQuote);
  return words.some((w) => contentWords(narrative).some((nw) => sameStem(w, nw)));
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
  // survive for short quotes (1-3 words: all-but-one may be reworded), and
  // floor(n/2) for longer quotes — so "Hi, I'm Anton,
  // where is my desk?" cannot collapse to just "Hi, I'm Anton", while a
  // 5-word question may keep 2 words plus its question structure (see the
  // interrogative path below).
  for (const q of actionQuotes) {
    const words = contentWords(q);
    if (words.length === 0) continue;
    const kept = words.filter((w) => contentWords(narrative).some((nw) => sameStem(w, nw)));
    const need = words.length <= 3 ? Math.ceil(words.length / 2) : Math.floor(words.length / 2);
    if (kept.length < need && !questionPreserved(q, narrative)) {
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
