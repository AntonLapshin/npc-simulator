// Object-interaction validation checks (extracted from physicalValidator.ts).

import type { Action, ValidationError, World } from "../../types.js";
import { contentWords, hasOwnUtterance, maskResumedActivity, quotedSegments, sameStem } from "./speech.js";
import { CONTACT_RADIUS, distanceToRect, isInterrogativeQuestion } from "./movement.js";
import { MANIPULATION_REACH, detectNarrativeManipulation } from "../../core/objects.js";
// Type-only: the full outcome type lives in the engine executor; the
// validator only needs its shape (no runtime dependency).
import type { ManipulationOutcome } from "../manipulationExecutor.js";

/**
 * F4: object interaction radius. Moving/resizing an object or flipping its
 * passable/blocksVision/blocksSound flags requires the acting actor within
 * this many cells (Euclidean) of the object's center — no cross-room
 * telekinesis. Description-only patches are always allowed. Single source:
 * the pure core's MANIPULATION_REACH (the engine plans manipulation with
 * the same radius, so engine output always satisfies this gate).
 */
export const OBJECT_INTERACT_RADIUS = MANIPULATION_REACH;

/** Scene objects that brewing/pouring must happen next to (Exp-4 item 10). */
const BREW_MACHINE_RE = /coffee|machine|kettle|brewer|espresso|cooler|dispenser/i;

/**
 * F21: word-boundary mention test shared by the contact block below.
 * A bare substring lets id "dan" match "Dana".
 */
function mentionsWordBoundary(text: string, variant: string): boolean {
  if (variant.length < 2) return false;
  return new RegExp(`\\b${variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

/**
 * Exp-3 item 8 (S6): seating check. True when (x, y) can host a seated
 * actor: on or adjacent (≤1.5 cells, edge distance) to a chair/sofa
 * object. The 1.5-radius adjacency covers non-passable lounge chairs
 * (which can never be stood on); desk chairs are standable 1×1 passable
 * cells, so standing on the chair cell counts. No `kind` field exists on
 * scene objects — chairs are identified by id/name convention.
 * Pure.
 */
export function isSeatingCell(world: World, x: number, y: number): boolean {
  return world.scene.objects.some(
    (o) =>
      /chair|sofa/i.test(`${o.id} ${o.name}`) && distanceToRect(x, y, o) <= 1.5,
  );
}

/**
 * Exp-3 item 8 (S6, tick-28/11 repro): pose:sit must be backed by a chair.
 * Tanya drifted (8,7)→(8,10) while `state` still implied sitting and
 * `pose:sit` persisted at a non-chair cell; Dana sat at (12,11), 3 cells
 * from his chair. Fires when the effective pose is "sit" AND the turn
 * either sets pose:sit or moves the actor (>1 cell — catches stale sit
 * drifting with the body) AND the effective position is not a seating
 * cell. Reject, don't repair — silently snapping pose→stand rewrites
 * fiction; the retry message names the nearest chair so the model can sit
 * legally. Pure.
 */
export function validateSitPoseSeating(
  world: World,
  normalized: {
    actorPatches: { actorId: string; x?: number; y?: number; pose?: string }[];
  },
  action: Action,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const chairs = world.scene.objects.filter((o) => /chair|sofa/i.test(`${o.id} ${o.name}`));
  // Fail open when the scene models no seating at all — without chair
  // objects there is nothing to validate against (minimal test worlds,
  // chairless scenes); the gate only constrains scenes that DO model
  // chairs, where sitting in mid-air is a real error.
  if (chairs.length === 0) return errors;
  for (const patch of normalized.actorPatches) {
    const actor = world.actors.find((a) => a.id === patch.actorId);
    if (!actor) continue;
    const effectivePose = patch.pose ?? actor.pose;
    if (!/^sit$/i.test(effectivePose ?? "")) continue;
    const poseChanged = patch.pose !== undefined && patch.pose !== actor.pose;
    const ex = patch.x ?? actor.x;
    const ey = patch.y ?? actor.y;
    const moved = Math.hypot(ex - actor.x, ey - actor.y) > 1;
    if (!poseChanged && !moved) continue;
    if (isSeatingCell(world, ex, ey)) continue;
    const nearest = chairs
      .map((o) => ({ o, d: distanceToRect(ex, ey, o) }))
      .sort((a, b) => a.d - b.d)[0];
    errors.push({
      code: "pose.sit_no_chair",
      message:
        `actor ${patch.actorId}: pose is "sit" at (${ex}, ${ey}) but no chair/sofa within 1.5 cells` +
        (nearest !== undefined
          ? ` (nearest: ${nearest.o.id} at (${nearest.o.x}, ${nearest.o.y}), ${nearest.d.toFixed(1)} cells away)`
          : " (no chair/sofa in this scene)") +
        `: move adjacent to a chair before sitting, or drop the sit`,
    });
  }
  return errors;
}

/**
 * Object grounding (exp-2 item 7 — 30/30 empty objectPatches repro).
 *
 * Phase 3: object/prop patches are ENGINE-OWNED — the model never emits
 * them (stripped + ignored by `applyEngineManipulation`), so the old
 * "narrate the verb → demand the patch" gates are deleted
 * (brew_no_patch, pickup_no_patch, open_no_patch, sip_no_prop,
 * hold_no_prop). What remains are the gates that police the MODEL's own
 * responsibilities: pose (still model-emitted) and the physical-reach
 * rule for brewing/pouring. Transfer events (pick up / put down / hand
 * over) are policed by `validateManipulationGrounding` below — the
 * phantom-manipulation gate.
 */
export function validateObjectGrounding(
  world: World,
  normalized: {
    narrative: string;
    actorPatches: { actorId: string; pose?: string; prop?: string | null; x?: number; y?: number; thoughts?: string }[];
    objectPatches: { objectId: string }[];
  },
  action?: Action,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const text = maskResumedActivity(normalized.narrative);
  const actingId = action?.actorId;
  const actingPatch = actingId !== undefined
    ? normalized.actorPatches.find((p) => p.actorId === actingId)
    : undefined;
  const actingWorld = actingId !== undefined
    ? world.actors.find((a) => a.id === actingId)
    : undefined;

  if (/\b(sits?|sitting|sat)\b|\btakes? a seat\b/i.test(text)) {
    const poseOk =
      actingPatch?.pose !== undefined || (actingWorld?.pose ?? "stand") === "sit";
    if (!poseOk) {
      errors.push({
        code: "object_grounding.sit_no_pose",
        message: `narrative describes sitting but no pose patch sets it: include pose ("sit") on the acting actor${actingId ? ` (${actingId})` : ""}`,
      });
    }
  }
  if (/\b(brews?|brewing|pours?|pouring|fills?(?:ing)? (?:his|her|their|my|the|a) mug|makes? coffee)\b/i.test(text)) {
    // Exp-4 item 10 (S6, tick-29 repro): brewing/pouring from across the
    // room is telekinesis — the actor must be within interact radius of a
    // machine-like object. Fail open when the scene models no machine at
    // all. Measured at the effective (post-patch) position so a turn that
    // walks to the machine and pours stays legal. (Phase 3: the patch
    // demand is gone — the engine plans the cup pick-up itself when the
    // actor is actually next to a machine.)
    const ex = actingPatch?.x ?? actingWorld?.x;
    const ey = actingPatch?.y ?? actingWorld?.y;
    if (
      ex !== undefined &&
      ey !== undefined &&
      world.scene.objects.some((o) => BREW_MACHINE_RE.test(`${o.id} ${o.name}`)) &&
      !world.scene.objects.some(
        (o) =>
          BREW_MACHINE_RE.test(`${o.id} ${o.name}`) &&
          Math.hypot(ex - (o.x + o.w / 2), ey - (o.y + o.h / 2)) <=
            OBJECT_INTERACT_RADIUS,
      )
    ) {
      errors.push({
        code: "object_grounding.pour_too_far",
        message: `narrative describes brewing/pouring but the actor is not within ${OBJECT_INTERACT_RADIUS} cells of a coffee machine/kettle/cooler: walk there first — pouring is a separate turn once adjacent`,
      });
    }
  }
  return errors;
}

/**
 * Phase 3: the phantom-manipulation gate. Pick-up, put-down, and
 * hand-over are engine-owned — the engine executes exactly what the
 * action text supports (pickable object within reach, free hands,
 * adjacent recipient). A narrative that describes a transfer event the
 * engine did NOT execute is fiction ("phantom props" — the killed
 * category): it fails here with a targeted retry hint instead of
 * silently entering history.
 *
 * - `executed === undefined`: unknown (older callers) — fail open.
 * - `executed === null`: the engine executed nothing — any transfer
 *   event in the narrative is phantom.
 * - `executed !== null`: the engine executed `plan.kind` — a narrative
 *   transfer of a DIFFERENT kind is phantom (the engine owns every
 *   transfer; prose cannot add or swap one).
 */
export function validateManipulationGrounding(
  world: World,
  action: Action,
  normalized: { narrative: string },
  executed: ManipulationOutcome | null | undefined,
): ValidationError[] {
  if (executed === undefined) return [];
  void world;
  void action;
  const described = detectNarrativeManipulation(normalized.narrative);
  if (described.length === 0) return [];
  const executedKind = executed?.plan.kind;
  const phantom = described.filter((k) => k !== executedKind);
  if (phantom.length === 0) return [];
  return [
    {
      code: "object.phantom_manipulation",
      message:
        `narrative describes ${phantom.join("/")} but the engine executed ` +
        (executedKind !== undefined
          ? `a different manipulation (${executedKind})`
          : "no manipulation") +
        " this turn: pick-up/put-down/hand-over are engine-executed from the action text " +
        "(the object must be pickable and within reach, hands free, recipient adjacent) — " +
        "narrate only the EXECUTED MANIPULATION facts, never invent a transfer the engine did not perform",
    },
  ];
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
export function validateActionVerbCoverage(
  world: World,
  action: Action,
  normalized: {
    narrative: string;
    actorPatches: { actorId: string; x?: number; y?: number; pose?: string; prop?: string | null }[];
    objectPatches: { objectId: string }[];
  },
): ValidationError[] {
  const errors: ValidationError[] = [];
  const text = action.text;
  const narrative = normalized.narrative;
  const actingPatch = normalized.actorPatches.find((p) => p.actorId === action.actorId);

  // F21: word-boundary mention matching — a bare substring lets id "dan"
  // match "Dana".
  const namesRosterActor = world.actors
    .filter((a) => a.id !== action.actorId)
    .some(
      (a) =>
        mentionsWordBoundary(text, a.id) ||
        mentionsWordBoundary(text, a.name),
    );
  /** Roster actors (other than the acting actor) named in the action text. */
  const namedRosterActors = world.actors.filter((a) => {
    if (a.id === action.actorId) return false;
    return mentionsWordBoundary(text, a.id) || mentionsWordBoundary(text, a.name);
  });

  if (
    /\b(handshake|shake\s+.*hands?|shake\s+.*hand|hug|embrace|kiss|high[\s-]?five|fist[\s-]?bump|\bpat\b|slap|hands?\s+over|handing|hands?\s+(him|her|them)|give\s+.*(coffee|cup)|pass\s+.*(coffee|cup))\b/i.test(
      text,
    ) &&
    namesRosterActor
  ) {
    if (!/\b(shake|shook|hands?|hug|embrace|kiss|high[\s-]?five|fist|pat|slap|give|gave|pass|hand)\b/i.test(narrative)) {
      errors.push({
        code: "contact.narrative_drops_contact",
        message: `action describes physical contact ("${text.slice(0, 80)}") but the narrative never mentions it: narrate the handshake/hug/handover (dodging the verb does not excuse dropping the contact)`,
      });
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
        errors.push({
          code: "contact.action_too_far",
          message: `action describes physical contact with ${t.id} but ends at (${endX}, ${endY}), ${dist} cells away: end adjacent (within ${CONTACT_RADIUS} cells) before touching — a handshake across the room is not contact`,
        });
      }
    }
  }

  // Exp-2 item 8 (S4): a *question* about sitting ("where I should sit?")
  // is not a sit action — exempt interrogative questions from the pose
  // demand (isInterrogativeQuestion also requires no genuine movement
  // clause, so "walk over and ask where I should sit" still moves).
  const isQuestion = isInterrogativeQuestion(text);
  const sitMatch = !isQuestion && /\bsit\b|\bsits\b|\bsitting\b|\bsat\b|\btake[sn]?\s+a\s+seat\b/i.test(text);
  const standMatch = /\bstand\b|\bstands\b|\bstanding\b|\bstood\b|\bstand\s+up\b/i.test(text);
  if (sitMatch && !standMatch) {
    const poseOk =
      actingPatch?.pose === "sit" || /\b(sit|sits|sitting|sat|seat|seated)\b/i.test(narrative);
    if (!poseOk) {
      errors.push({
        code: "action.sit_no_pose",
        message: `action says to sit ("${text.slice(0, 80)}") but the consequence neither sets pose ("sit") nor describes sitting: sitting without the matching patch is incomplete (saying "stands" instead fails)`,
      });
    }
  } else if (standMatch && !sitMatch) {
    const poseOk =
      actingPatch?.pose === "stand" || /\b(stand|stands|standing|stood)\b/i.test(narrative);
    if (!poseOk) {
      errors.push({
        code: "action.stand_no_pose",
        message: `action says to stand ("${text.slice(0, 80)}") but the consequence neither sets pose ("stand") nor describes standing`,
      });
    }
  }

  // Phase 3: the action-side pour/brew/open and pick-up/hold patch demands
  // (action.pour_no_patch, action.pickup_no_patch) are deleted — object and
  // prop patches are engine-owned now (the engine plans the manipulation
  // from the action text itself and applies it before validation), so
  // there is no patch left for the model to emit. A narrative that
  // describes a transfer the engine didn't execute fails the
  // phantom-manipulation gate (validateManipulationGrounding) instead.

  if (/\bask\w*\b|\?/.test(text)) {
    if (!narrative.includes("?") && !/\bask\w*|questions?\b/i.test(narrative)) {
      errors.push({
        code: "speech.question_dropped",
        message: `action asks a question ("${text.slice(0, 80)}") but the narrative keeps no question (no "?" and no ask-verb): preserve the question instead of replacing it (e.g. with thanks)`,
      });
    }
  }

  // Phase 3 (exp-3 item 2, tick 18) + Exp-5 item 8 (ticks 14/20): speech
  // dropped without a trace. The quote gate only guards quoted segments,
  // and the ask gate only guards questions — so "Thank both, then head to
  // the desk" narrated as "looks around" passes with the entire utterance
  // erased (the judge even agreed speaks=false). When the action text
  // carries an explicitly verbal verb (thank/say/tell/explain/describe —
  // ask/? stays with the ask gate above, explain/describe/discuss stay
  // with the explanation gate below), the narrative must render speech: a
  // quote or a speech verb of its own.
  // Greet/welcome are deliberately excluded: they can be rendered
  // non-verbally (walking over, waving), and the golden path relies on it.
  // Exp-5 item 8: describe/discuss/brief/present/outline added — "describe
  // the layout" narrated as silent behavior was the hollow-pass class that
  // survived every gate.
  const EXPLANATORY_VERBS =
    "explain|explains|explained|explaining|describ(?:e|es|ed|ing)|discuss(?:es|ed|ing)?|brief(?:s|ed|ing)?|present(?:s|ed|ing)?|outlin(?:e|es|ed|ing)";
  // Item C9 (S5): fire only for the actor's OWN utterance — reported-speech
  // mentions ("keep an ear open for what Jeff says next") describe someone
  // else's speech and must not demand rendered dialogue.
  if (hasOwnUtterance(text)) {
    if (!/\bask\w*\b|\?/.test(text)) {
      const rendersSpeech =
        narrative.includes("?") ||
        quotedSegments(narrative).length > 0 ||
        new RegExp(`\\b(say|says|said|tell|tells|told|thank|thanks|thanked|greet|greets|greeted|greeting|welcome|welcomes|welcomed|ask|asks|asked|answer|answers|answered|repl(?:y|ies|ied)|mentions?|mentioned|${EXPLANATORY_VERBS}|announce|announces|announced|shout|shouts|shouted|whisper|whispers|whispered|talk|talks|talked|speak|speaks|spoke|spoken|call|calls|called)\\b`, "i").test(narrative);
      if (!rendersSpeech) {
        errors.push({
          code: "speech.no_speech_rendered",
          message: `action says something ("${text.slice(0, 80)}") but the narrative renders no speech (no quote and no speech verb): preserve what is said instead of replacing it with silent behavior`,
        });
      }
    }
  }

  errors.push(...validateExplanationCoverage(action, normalized));

  return errors;
}

/**
 * Exp-5 item 8 (ticks 14/20): explanation hollow-pass gate. A selected
 * "explain/describe/discuss/brief/present/outline" action whose consequence
 * keeps no question and no explanation is the hollow-pass class that
 * survived every gate: the quote gate guards quoted segments, the ask gate
 * guards questions, and the renders-speech check above accepts ANY speech
 * verb anywhere ("explain the office layout" narrated as "greets everyone
 * warmly" passes it). This gate additionally requires the TOPIC to survive:
 * at least one shared content-word stem between the action and the
 * narrative beyond the explanatory verb itself — so the greeting-substitute
 * fails while "explains the layout of the desks" passes.
 */
const EXPLANATION_VERBS_RE =
  /\b(explain|explains|explained|explaining|describ(?:e|es|ed|ing)|discuss(?:es|ed|ing)?|brief(?:s|ed|ing)?|present(?:s|ed|ing)?|outlin(?:e|es|ed|ing)|walk(?:s|ed|ing)?\s+(?:\w+\s+)?through|run\s+(?:\w+\s+)?through)\b/i;

/** Explanatory verb forms excluded from topic-overlap (they always match). */
const EXPLANATION_STOP_WORDS = new Set(
  [
    "explain", "explains", "explained", "explaining",
    "describe", "describes", "described", "describing",
    "discuss", "discusses", "discussed", "discussing",
    "brief", "briefs", "briefed", "briefing",
    "present", "presents", "presented", "presenting",
    "outline", "outlines", "outlined", "outlining",
    "walk", "walks", "walked", "walking", "run", "through",
    "with", "that", "this", "these", "those", "from", "your",
    "their", "them", "they", "then", "than", "have", "has",
    "will", "would", "could", "should", "there", "here",
    "when", "where", "which", "while", "after", "before",
    "about", "into", "over", "under",
  ].map((w) => w.slice(0, 4)),
);

export function validateExplanationCoverage(
  action: Action,
  normalized: { narrative: string },
): ValidationError[] {
  if (!EXPLANATION_VERBS_RE.test(action.text)) return [];
  const topic = contentWords(action.text).filter(
    (w) => !EXPLANATION_STOP_WORDS.has(w.slice(0, 4)),
  );
  if (topic.length === 0) return [];
  const narrativeWords = contentWords(normalized.narrative);
  const kept = topic.filter((w) => narrativeWords.some((nw) => sameStem(w, nw)));
  if (kept.length === 0) {
    return [
      {
        code: "speech.topic_dropped",
        message: `action explains/describes something ("${action.text.slice(0, 80)}") but the narrative keeps none of its topic words (${topic.slice(0, 4).join(", ") || "none"}): preserve WHAT is explained (the topic), not just that someone spoke — a greeting substitute for an explanation is hollow`,
      },
    ];
  }
  return [];
}
