// Object-interaction validation checks (extracted from physicalValidator.ts).

import type { Action, ValidationError, World } from "../../types.js";
import { contentWords, hasOwnUtterance, maskResumedActivity, quotedSegments, sameStem } from "./speech.js";
import { CONTACT_RADIUS } from "./movement.js";

/**
 * F4: object interaction radius. Moving/resizing an object or flipping its
 * passable/blocksVision/blocksSound flags requires the acting actor within
 * this many cells (Euclidean) of the object's center — no cross-room
 * telekinesis. Description-only patches are always allowed.
 */
export const OBJECT_INTERACT_RADIUS = 4;

/**
 * F8: object-noun vocabulary for the object/verb validators. When the
 * scenario declares `vocabulary.objectNouns`, those nouns (with simple
 * plural tolerance) drive the pick-up/open/take patterns; otherwise the
 * office default list below keeps existing scenarios working.
 */
const DEFAULT_PICKUP_NOUNS = "laptop|mug|cup|bag|chair|papers?|phone|monitor";
// The narrative-side open/boot gate historically matched only "laptop" —
// keep that exact default so office scenarios behave identically.
const DEFAULT_OPEN_NOUNS = "laptop";

function scenarioNounAlternation(world: World): string | undefined {
  const nouns = world.vocabulary?.objectNouns;
  if (nouns === undefined || nouns.length === 0) return undefined;
  return nouns
    .map((n) => {
      const e = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return /s$/i.test(n) ? e : `${e}s?`;
    })
    .join("|");
}

/** Noun alternation for pick-up/take patterns (F8). */
function pickupNounPattern(world: World): string {
  return scenarioNounAlternation(world) ?? DEFAULT_PICKUP_NOUNS;
}

/** Noun alternation for open/boot patterns (F8). */
function openNounPattern(world: World): string {
  return scenarioNounAlternation(world) ?? DEFAULT_OPEN_NOUNS;
}

/**
 * F21: word-boundary mention test shared by the contact block below.
 * A bare substring lets id "dan" match "Dana".
 */
function mentionsWordBoundary(text: string, variant: string): boolean {
  if (variant.length < 2) return false;
  return new RegExp(`\\b${variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

/**
 * Object grounding (exp-2 item 7 — 30/30 empty objectPatches repro): prose
 * that brews, pours, sips, types, opens, picks up, or sits must be backed by
 * a matching patch. Narrative-side verb matching only (reads structured
 * output, never interprets action intent — that stays with the judge).
 * Already-held props satisfy sip/type (sipping from a held cup changes
 * nothing), but brewing/pouring/picking up always demand a fresh patch.
 */
export function validateObjectGrounding(
  world: World,
  normalized: {
    narrative: string;
    actorPatches: { actorId: string; pose?: string; prop?: string | null }[];
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
      errors.push({
        code: "object_grounding.sit_no_pose",
        message: `narrative describes sitting but no pose patch sets it: include pose ("sit") on the acting actor${actingId ? ` (${actingId})` : ""}`,
      });
    }
  }
  if (/\b(brews?|brewing|pours?|pouring|fills?(?:ing)? (?:his|her|their|my|the|a) mug|makes? coffee)\b/i.test(text)) {
    if (!hasObjectPatch && !propPatched) {
      errors.push({
        code: "object_grounding.brew_no_patch",
        message: `narrative describes brewing/pouring but no object patch backs it: add an objectPatch for the coffee machine/mug (or a prop patch for the cup picked up)`,
      });
    }
  }
  if (
    new RegExp(
      `\\b(picks?\\s+up|picking\\s+up|picked\\s+up|grabs?|takes? (?:the|his|her|their|my|your|its|a|an) (?:${pickupNounPattern(world)}))\\b`,
      "i",
    ).test(text)
  ) {
    if (!propPatched && !hasObjectPatch) {
      errors.push({
        code: "object_grounding.pickup_no_patch",
        message: `narrative describes picking something up but no prop/object patch backs it: set prop on the acting actor (or an objectPatch for what moved)`,
      });
    }
  }
  if (new RegExp(`\\b(opens?(?:ing|ed)?\\s+(?:up\\s+)?(?:(?:his|her|their|my|the|a|an)\\s+)?(?:${openNounPattern(world)})|boots?(?:ing)?\\s+(?:up\\s+)?(?:(?:his|her|their|my|the|a|an)\\s+)?(?:${openNounPattern(world)})|powers?\\s+on)\\b`, "i").test(text)) {
    if (!propPatched && !hasObjectPatch && !holdsSomething) {
      errors.push({
        code: "object_grounding.open_no_patch",
        message: `narrative describes opening/booting but no prop/object patch backs it: set the matching prop on the acting actor or add the objectPatch`,
      });
    }
  }
  if (/\b(sips?|sipping|sipped|drinks?|drinking|drank|swigs?|gulps?|types?|typing|typed)\b/i.test(text)) {
    if (!propPatched && !hasObjectPatch && !holdsSomething) {
      errors.push({
        code: "object_grounding.sip_no_prop",
        message: `narrative describes sipping/drinking/typing but the acting actor holds nothing and no prop/object patch backs it: set prop (cup/laptop) or add the matching objectPatch`,
      });
    }
  }
  // Phase 3 (exp-3 item 2, tick 11 shape): holding/carrying is an object
  // interaction like picking up — a narrative that holds a cup with no
  // prop/object patch is ungrounded, even when the verb is "hold".
  // ("carry on" / "held a meeting" are not object verbs — excluded so
  // task-resumption prose never trips this gate.)
  if (/\b(holds?|holding|carr(?:y|ies|ied|ying))\b(?!\s+on\b)/i.test(text)) {
    if (!propPatched && !hasObjectPatch && !holdsSomething) {
      errors.push({
        code: "object_grounding.hold_no_prop",
        message: `narrative describes holding/carrying but the acting actor holds nothing and no prop/object patch backs it: set prop (cup/laptop) or add the matching objectPatch`,
      });
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

  const sitMatch = /\bsit\b|\bsits\b|\bsitting\b|\bsat\b|\btake[sn]?\s+a\s+seat\b/i.test(text);
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

  // "open" counts as a verb with a concrete object ("open the door", "open
  // his laptop", bare "open laptop") — never as an adjective ("an open and
  // welcoming demeanor", where "open" is followed by "and", not a noun).
  // Exp-5 tick 15: the old regex required a determiner ("open MY laptop"),
  // so bare "open laptop" dodged this gate while "opens his laptop" in the
  // narrative tripped the narrative-side one — identical omissions passed
  // or failed on prose luck. The determiner is now optional but the object
  // noun is required. Partial semantics for triple-verb actions
  // (sit + open in one action): sit applies now via the pose patch, the
  // laptop opens next turn — a turn that sits without the laptop patch
  // still fails here, and the message says so (Tier-2 salvage may advance
  // the movement/sit with the laptop miss logged as a warning instead).
  //
  // F8: the object nouns come from the scenario vocabulary when declared,
  // else the office default list below.
  const OPEN_OBJECT_NOUNS =
    scenarioNounAlternation(world) ??
    "laptop|mug|cup|door|bag|chair|papers?|phone|monitor|book|box|window|desk|machine|notes?|documents?|bottle|drawer|lid";
  if (
    /\b(brew|brews|pour|pours|fill|fills|boot|boots|mak(e|es|ing)\s+coffee)\b/i.test(text) ||
    new RegExp(
      `\\bopens?(?:ed|ing)?\\s+(?:up\\s+)?(?:(?:his|her|their|my|the|a|an|that|this)\\s+)?(?:${OPEN_OBJECT_NOUNS})\\b`,
      "i",
    ).test(text)
  ) {
    const backed =
      normalized.objectPatches.length > 0 || actingPatch?.prop !== undefined;
    if (!backed) {
      errors.push({
        code: "action.pour_no_patch",
        message: `action says to pour/brew/open ("${text.slice(0, 80)}") but no objectPatch/prop patch backs it: omitting the verb from the narrative does not excuse omitting the patch (split triple-verb actions across turns — sit now via the pose patch, open the laptop next turn)`,
      });
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
    new RegExp(
      `\\btakes?\\s+(?:the|his|her|their|my|your|its|a|an)\\s+(?:${pickupNounPattern(world)})\\b`,
      "i",
    ).test(text)
  ) {
    const backed =
      normalized.objectPatches.length > 0 || actingPatch?.prop !== undefined;
    if (!backed) {
      errors.push({
        code: "action.pickup_no_patch",
        message: `action says to pick up/hold ("${text.slice(0, 80)}") but no objectPatch/prop patch backs it: omitting the verb from the narrative does not excuse omitting the patch`,
      });
    }
  }

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
