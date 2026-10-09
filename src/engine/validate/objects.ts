// Object-interaction validation checks (extracted from physicalValidator.ts).

import type { Action, ValidationError, World } from "../../types.js";
import { contentWords, maskResumedActivity, sameStem } from "./speech.js";
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
 * Phase 4: object grounding for the render contract. Pose is
 * engine-executed — a narrative that describes sitting requires the
 * engine's effective pose to be "sit"; brewing/pouring still requires
 * the actor within interact radius of a machine, measured at the
 * post-movement position. Pure.
 */
export function validateObjectGrounding(
  world: World,
  action: Action,
  narrative: string,
  /** Effective pose after the engine's pose plan (pose ?? actor.pose). */
  effectivePose: string,
  /** Post-movement position (engine outcome, or the actor's cell). */
  x: number,
  y: number,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const text = maskResumedActivity(narrative);

  if (/\b(sits?|sitting|sat)\b|\btakes? a seat\b/i.test(text)) {
    if (effectivePose !== "sit") {
      errors.push({
        code: "object_grounding.sit_no_pose",
        message: `narrative describes sitting but the engine did not set a sitting pose for the acting actor (${action.actorId}): narrate only what the engine executed — never invent sitting`,
      });
    }
  }
  if (/\b(brews?|brewing|pours?|pouring|fills?(?:ing)? (?:his|her|their|my|the|a) mug|makes? coffee)\b/i.test(text)) {
    // Exp-4 item 10 (S6, tick-29 repro): brewing/pouring from across the
    // room is telekinesis — the actor must be within interact radius of a
    // machine-like object. Fail open when the scene models no machine at
    // all. Measured at the post-movement position so a turn that walks to
    // the machine and pours stays legal.
    if (
      world.scene.objects.some((o) => BREW_MACHINE_RE.test(`${o.id} ${o.name}`)) &&
      !world.scene.objects.some(
        (o) =>
          BREW_MACHINE_RE.test(`${o.id} ${o.name}`) &&
          Math.hypot(x - (o.x + o.w / 2), y - (o.y + o.h / 2)) <=
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
