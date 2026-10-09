// Pure core for engine-owned object manipulation (Phase 3 of the renderer
// architecture).
//
// Physical manipulation — pick up, put down, hand over — is executed by
// the engine from affordances, never by the model. This module is the
// deterministic foundation: given an immutable world snapshot, the action
// text, and an optional contact actor id, it PLANS the manipulation as
// DATA (`planManipulation`). It never mutates anything; the thin
// `src/engine/manipulationExecutor.ts` applies the plan to the world.
//
// Purity contract (P9): deterministic, no I/O, no argument mutation, no
// LLM calls, no Date.now()/Math.random(). All text patterns live here so
// the engine, the validator, and the tests share one verb ontology.

/** Physical reach for object manipulation (cells, Euclidean, object-center distance). */
export const MANIPULATION_REACH = 4;
/** Hand-over reach (cells, Euclidean, actor-point distance) — mirrors the contact adjacency rule. */
export const HAND_OVER_REACH = 2.5;

/**
 * Affordances of one object kind. Resolved from the object's id/name by
 * `affordanceForObject` — the single canonical kind table (no per-module
 * duplicates).
 */
export type ObjectKindAffordance = {
  /** The actor can take this into their hands in one turn. */
  pickable: boolean;
  /** Canonical held-item name when picked up ("cup", "laptop", …) — null when not holdable. */
  propName: string | null;
  /** Things get put down onto this (desks, tables). */
  surface: boolean;
  /** Things go inside this (bags, drawers) — recorded for later phases; Phase 3 never nests. */
  container: boolean;
  /** Brewing/pouring happens next to this (coffee machines, kettles). */
  brewSource: boolean;
};

const NON_HOLDABLE: ObjectKindAffordance = {
  pickable: false,
  propName: null,
  surface: false,
  container: false,
  brewSource: false,
};

/**
 * The canonical object-kind table. Ordered — first match wins on
 * `${id} ${name}`. Keep it small and physical: kinds, not scenarios.
 */
export const OBJECT_KIND_AFFORDANCES: Array<{
  kinds: RegExp;
  affordance: ObjectKindAffordance;
}> = [
  {
    kinds: /laptop/i,
    affordance: { pickable: true, propName: "laptop", surface: false, container: false, brewSource: false },
  },
  {
    kinds: /\bmugs?\b|\bcups?\b/i,
    affordance: { pickable: true, propName: "cup", surface: false, container: false, brewSource: false },
  },
  {
    kinds: /\bpapers?\b|\bdocuments?\b/i,
    affordance: { pickable: true, propName: "papers", surface: false, container: false, brewSource: false },
  },
  {
    kinds: /\breports?\b/i,
    affordance: { pickable: true, propName: "report", surface: false, container: false, brewSource: false },
  },
  {
    kinds: /\bphones?\b/i,
    affordance: { pickable: true, propName: "phone", surface: false, container: false, brewSource: false },
  },
  {
    kinds: /\bbooks?\b|\bnotebooks?\b/i,
    affordance: { pickable: true, propName: "book", surface: false, container: false, brewSource: false },
  },
  {
    kinds: /\bbottles?\b/i,
    affordance: { pickable: true, propName: "bottle", surface: false, container: false, brewSource: false },
  },
  {
    kinds: /\bbags?\b/i,
    affordance: { pickable: true, propName: "bag", surface: false, container: true, brewSource: false },
  },
  {
    kinds: /\bdesks?\b|\btables?\b/i,
    affordance: { pickable: false, propName: null, surface: true, container: false, brewSource: false },
  },
  {
    kinds: /\bdrawers?\b|\bbox\b|\bboxes\b|\bcabinets?\b/i,
    affordance: { pickable: false, propName: null, surface: false, container: true, brewSource: false },
  },
  {
    kinds: /coffee|machine|kettle|brewer|espresso|cooler|dispenser/i,
    affordance: { pickable: false, propName: null, surface: false, container: false, brewSource: true },
  },
];

/** Affordances for one scene object, from its id/name. Pure. */
export function affordanceForObject(
  obj: { id: string; name: string },
): ObjectKindAffordance {
  const hay = `${obj.id} ${obj.name}`;
  for (const { kinds, affordance } of OBJECT_KIND_AFFORDANCES) {
    if (kinds.test(hay)) return affordance;
  }
  return NON_HOLDABLE;
}

/** Immutable actor view for manipulation planning. */
export type CoreActor = {
  id: string;
  name: string;
  x: number;
  y: number;
  prop: string | null;
  /**
   * Stage-1 A3: the scene object backing the held prop, when the engine
   * recorded one. Null when the prop has no linked scene object (legacy
   * saves, prop-only flips).
   */
  heldObjectId: string | null;
};

/** Immutable scene-object view for manipulation planning. */
export type CoreObject = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  affordance: ObjectKindAffordance;
};

/** Immutable world view for manipulation planning. */
export type ManipulationSnapshot = {
  actors: CoreActor[];
  objects: CoreObject[];
};

export type ManipulationKind = "pick-up" | "put-down" | "hand-over";

/**
 * The engine's manipulation decision, as data. `objectId` is the scene
 * object that moves with the manipulation (null when the held prop has no
 * matching scene object nearby — the prop flip still happens). `rule` is
 * the deterministic rule trace for facts/logging.
 */
export type ManipulationPlan = {
  kind: ManipulationKind;
  actorId: string;
  objectId: string | null;
  /** Canonical held-item name (the prop value after the turn). */
  propName: string;
  /** Hand-over recipient. */
  targetActorId?: string;
  /** Put-down surface named by the action ("on the desk"). */
  surfaceId?: string;
  rule: string;
};

// ---------------------------------------------------------------------------
// Verb ontology (shared by planning and the phantom-manipulation gate).
// ---------------------------------------------------------------------------

/** Explicit take-into-hands verbs. */
const PICK_UP_VERB_RE = /\bpick(?:s|ed|ing)?\s+up\b|\bgrab(?:s|bed|bing)?\b/i;
/** Take/hold/carry — a manipulation only alongside a holdable kind word. */
const TAKE_HOLD_VERB_RE =
  /\btak(?:e|es|ing|en)\b|\bholds?\b|\bholding\b|\bheld\b|\bcarr(?:y|ies|ied|ying)\b/i;
/** "carry on" is resumption, not carrying — stripped before verb tests. */
const CARRY_ON_RE = /\bcarr(?:y|ies|ied|ying)\s+on\b/gi;
/**
 * Release verbs. Stage-1 A2: third-person forms — "puts/sets X down" and
 * "puts X aside" plan like their imperative counterparts ("put X down",
 * "set aside"). The first two alternatives take an optional object span
 * between verb and particle so "puts the laptop down" / "sets the book
 * aside" match; bare "puts down" / "sets down" still match (empty span).
 */
const PUT_DOWN_VERB_RE =
  /\b(?:puts?|sets?|lays?|laid)\b[\w\s]{0,48}?\bdown\b|\b(?:puts?|sets?|lays?|laid)\b[\w\s]{0,48}?\baside\b|\bplaces?\b[\w\s]{0,48}?\bon\b/i;
/**
 * Transfer frames for the hand/hands/handed/handing forms (Stage-2 B1).
 * The bare noun "hand"/"hands" is a body part ("raises a hand", "takes her
 * hand", "hands empty", "the task at hand") — it only reads as a transfer
 * inside a transfer frame:
 * - "hand(s/ed/ing) over" ("Hand it over", "handed the report over");
 * - "hand <object-phrase> to <recipient>" ("hands the report to Nadia",
 *   "hand it to her", "hands Nadia's report to Tanya");
 * - dative with a pronoun recipient ("hand him the report"). Proper-name
 *   dative ("hands Tanya the laptop") is NOT detected — the
 *   case-insensitive match cannot tell a capitalized name from "in a";
 *   prefer the "to" form. "lend/give a hand" idioms stay out (no transfer
 *   frame); "give" still matches as an unambiguous transfer verb below.
 * Exported for the narrative contact gate, which scopes its bare "hand"
 * noun the same way.
 */
export const HAND_TRANSFER_FRAME_RE =
  /\bhand(?:s|ed|ing)?\s+(?:[\w'’\-]+\s+){0,3}over\b|\bhand(?:s|ed|ing)?\s+(?:the|a|an|his|her|their|its|my|your|our|this|that|these|those|me|him|us|them|it|\w+'s)\b[\w\s'’,\-]{0,32}?\bto\b|\bhand(?:s|ed|ing)?\s+(?:me|him|her|us|them)\s+(?:the|a|an|his|her|their|its|my|your|our|this|that|these|those)\s+\w+/i;
/**
 * Transfer verbs. "shake hands" is contact, not transfer — excluded.
 * Stage-2 B1: the hand/hands/handed/handing forms only match inside a
 * transfer frame (HAND_TRANSFER_FRAME_RE) — the bare noun is a body part.
 */
const HAND_OVER_VERB_RE = new RegExp(
  `${HAND_TRANSFER_FRAME_RE.source}|\\bgives?\\b|\\bgave\\b|\\bgiving\\b|\\bpass(?:es|ed|ing)?\\b`,
  "i",
);
/**
 * The handshake idiom in all its shapes ("shake hands", "shakes Tanya's
 * hand", "shook her hand") — contact, never a transfer. The optional
 * single word covers the possessive/pronoun owner; anything longer
 * ("shake the bottle and hand it over") is left alone so a real
 * transfer verb later in the sentence still counts. Exported for the
 * narrative contact gate: the handshake idiom IS a contact claim (just
 * never a transfer).
 */
export const SHAKE_HANDS_RE = /\bsh(?:ak(?:e|es|ing)|ook)\s+(?:\w+(?:'s)?\s+)?hands?\b/gi;
/** Use verbs that imply taking hold of a cup. */
const SIP_VERB_RE =
  /\bsips?\b|\bsipping\b|\bsipped\b|\bdrinks?\b|\bdrinking\b|\bdrank\b|\bswigs?\b|\bgulps?\b/i;
/** Use verbs that imply taking hold of a laptop. */
const TYPE_VERB_RE =
  /\btyp(?:e|es|ed|ing)\b|\bkeyboards?\b|\bcod(?:e|es|ed|ing)\b|\bprogram(?:s|med|ming)?\b|\bhack(?:s|ed|ing)?\b/i;
/** Pouring/brewing implies taking hold of a cup — only next to a brew source. */
const POUR_VERB_RE =
  /\bbrews?\b|\bbrewing\b|\bpours?\b|\bpouring\b|\bfills?\b[\w\s]{0,24}?\bmug\b|\bmak(?:e|es|ing)\s+coffee\b/i;
/** Open/boot/use — a manipulation only alongside a holdable kind word. */
const OPEN_USE_VERB_RE =
  /\bopens?\b|\bopening\b|\bopened\b|\bboots?\b|\bbooting\b|\buse\b|\buses\b|\busing\b|\bused\b/i;

/** Holdable kind words in free text → canonical prop name. */
const KIND_WORD_PROPS: Array<[RegExp, string]> = [
  [/\b(mugs?|cups?)\b/i, "cup"],
  [/\b(laptops?|computers?)\b/i, "laptop"],
  [/\b(papers?|documents?)\b/i, "papers"],
  [/\b(reports?)\b/i, "report"],
  [/\b(phones?)\b/i, "phone"],
  [/\b(books?|notebooks?)\b/i, "book"],
  [/\b(bottles?)\b/i, "bottle"],
  [/\b(bags?)\b/i, "bag"],
  [/\bcoffee\b|\btea\b|\bcocoa\b/i, "cup"],
];

/** Canonical prop name for a holdable kind word in the text, or null. Pure. */
export function kindWordProp(text: string): string | null {
  for (const [re, prop] of KIND_WORD_PROPS) {
    if (re.test(text)) return prop;
  }
  return null;
}

/** Word-boundary mention of an object's id, spaced id, or name. Pure. */
export function mentionsObject(text: string, obj: { id: string; name: string }): boolean {
  const variants = new Set<string>();
  if (obj.id.length >= 2) {
    variants.add(obj.id.toLowerCase());
    variants.add(obj.id.toLowerCase().replace(/_/g, " "));
  }
  if (obj.name.length >= 2) variants.add(obj.name.toLowerCase());
  return [...variants].some(
    (v) =>
      new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text),
  );
}

/** Word-boundary mention of an actor's id or name. Pure. */
function mentionsActor(text: string, actor: { id: string; name: string }): boolean {
  for (const v of [actor.id, actor.name]) {
    if (v.length < 2) continue;
    if (
      new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)
    )
      return true;
  }
  return false;
}

/**
 * Deterministic hand-over recipient from the action text: a hand-over
 * verb (never "shake hands") plus a word-boundary mention of another
 * actor. Null when the text names no recipient — the in-loop refresh
 * then tries the merged semantics' contactActorId. Pure.
 */
export function resolveContactMention(
  actors: CoreActor[],
  actorId: string,
  text: string,
): string | null {
  const clean = text.replace(SHAKE_HANDS_RE, " ");
  if (!HAND_OVER_VERB_RE.test(clean)) return null;
  for (const a of actors) {
    if (a.id === actorId) continue;
    if (mentionsActor(clean, a)) return a.id;
  }
  return null;
}

/**
 * Stage-1 A3: the scene object backing the actor's held prop, when the
 * engine recorded one at pick-up time. Preferred over proximity
 * re-linking — the object travels with its holder, so identity survives
 * movement and hand-over instead of snapping to the nearest same-kind
 * object. Null when no object is linked (legacy saves, prop-only flips);
 * callers fall back to `nearestKindObject`. Pure.
 */
function heldSceneObject(
  snapshot: ManipulationSnapshot,
  actor: CoreActor,
): CoreObject | null {
  const id = actor.heldObjectId;
  if (id === null || id === undefined) return null;
  return snapshot.objects.find((o) => o.id === id) ?? null;
}

/** Euclidean distance, actor point → object center. Pure. */
export function distanceToObjectCenter(
  actor: { x: number; y: number },
  obj: { x: number; y: number; w: number; h: number },
): number {
  return Math.hypot(actor.x - (obj.x + obj.w / 2), actor.y - (obj.y + obj.h / 2));
}

/**
 * Nearest pickable object of a prop kind within manipulation reach of
 * the actor. Ties break by object id (deterministic). Null when none is
 * in reach — the engine never invents props out of thin air. Pure.
 */
export function nearestKindObject(
  snapshot: ManipulationSnapshot,
  actor: CoreActor,
  propName: string,
): CoreObject | null {
  let best: CoreObject | null = null;
  let bestDist = Infinity;
  for (const o of snapshot.objects) {
    if (!o.affordance.pickable || o.affordance.propName !== propName) continue;
    const d = distanceToObjectCenter(actor, o);
    if (d > MANIPULATION_REACH + 1e-9) continue;
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && (best === null || o.id < best.id))) {
      best = o;
      bestDist = d;
    }
  }
  return best;
}

/** True when a brew source (coffee machine, kettle, …) is within reach of the actor. Pure. */
export function nearBrewSource(snapshot: ManipulationSnapshot, actor: CoreActor): boolean {
  return snapshot.objects.some(
    (o) => o.affordance.brewSource && distanceToObjectCenter(actor, o) <= MANIPULATION_REACH + 1e-9,
  );
}

/**
 * Plan one turn's manipulation from the action text and an optional
 * contact actor id (deterministic pre-pass contact, or the merged
 * semantics' contactActorId in-loop). Returns the intended mutation as
 * DATA — never mutates the snapshot.
 *
 * Deterministic rules (documented — the single-manipulation contract):
 * - pick-up: explicit take verbs ("pick up", "grab", "take the X",
 *   "hold/carry the X"), or use verbs that imply holding (sip/drink →
 *   cup, typing → laptop, pour/brew → cup next to a brew source,
 *   open/boot/use + holdable kind → that kind). Requires: actor holds
 *   nothing, a pickable scene object of the kind within reach (no
 *   thin-air props).
 * - put-down: release verbs ("put/set/lay X down", "put/set X aside",
 *   "place X on Y" — imperative and third-person alike). Requires:
 *   actor holds something.
 * - hand-over: transfer verbs ("hand over/to", "give", "pass") + a
 *   recipient (contactActorId or a text mention — never "shake hands").
 *   Requires: actor holds something, recipient within 2.5 cells,
 *   recipient holds nothing.
 * - More than one manipulation kind in the text → null (split across
 *   turns; the engine executes exactly one manipulation per turn).
 * - A manipulation the guards reject → null (not attempted, not
 *   faked — the phantom-manipulation gate then polices the narrative).
 */
export function planManipulation(
  snapshot: ManipulationSnapshot,
  actorId: string,
  actionText: string,
  contactActorId?: string,
): ManipulationPlan | null {
  const actor = snapshot.actors.find((a) => a.id === actorId);
  if (!actor) return null;
  const text = actionText.replace(CARRY_ON_RE, " ");

  const handOverMention = resolveContactMention(snapshot.actors, actorId, text);
  const wantsHandOver =
    HAND_OVER_VERB_RE.test(text.replace(SHAKE_HANDS_RE, " ")) &&
    (contactActorId !== undefined || handOverMention !== null);
  const wantsPutDown = PUT_DOWN_VERB_RE.test(text);
  const wantsPickUp =
    PICK_UP_VERB_RE.test(text) ||
    SIP_VERB_RE.test(text) ||
    TYPE_VERB_RE.test(text) ||
    POUR_VERB_RE.test(text) ||
    ((TAKE_HOLD_VERB_RE.test(text) || OPEN_USE_VERB_RE.test(text)) &&
      kindWordProp(text) !== null);

  const kinds = [
    wantsPickUp ? "pick-up" : null,
    wantsPutDown ? "put-down" : null,
    wantsHandOver ? "hand-over" : null,
  ].filter((k): k is ManipulationKind => k !== null);
  // Single-manipulation contract: contradictory end states ("pick up the
  // mug and hand it to Ana") are not executed — split them across turns.
  if (kinds.length !== 1) return null;
  const kind = kinds[0]!;

  if (kind === "pick-up") {
    // Already holding something: nothing to pick up.
    if ((actor.prop ?? null) !== null) return null;
    const propName = pickUpPropName(text, snapshot, actor);
    if (propName === null) return null;
    const object = pickUpObject(text, snapshot, actor, propName);
    // No matching pickable object within reach — the engine never
    // invents props out of thin air.
    if (object === null) return null;
    return {
      kind,
      actorId,
      objectId: object.id,
      propName,
      rule: `pick-up:${pickUpRule(text, object.id)}`,
    };
  }

  if (kind === "put-down") {
    const held = actor.prop ?? null;
    if (held === null) return null;
    const object =
      heldSceneObject(snapshot, actor) ?? nearestKindObject(snapshot, actor, held);
    const surface = putDownSurface(text, snapshot, actor);
    return {
      kind,
      actorId,
      objectId: object?.id ?? null,
      propName: held,
      ...(surface !== null ? { surfaceId: surface.id } : {}),
      rule: `put-down:held(${held})${surface !== null ? `+surface(${surface.id})` : ""}`,
    };
  }

  // hand-over
  const held = actor.prop ?? null;
  if (held === null) return null;
  const recipientId = contactActorId ?? handOverMention;
  if (recipientId === null || recipientId === undefined) return null;
  const recipient = snapshot.actors.find((a) => a.id === recipientId);
  if (!recipient || recipient.id === actorId) return null;
  if (Math.hypot(actor.x - recipient.x, actor.y - recipient.y) > HAND_OVER_REACH + 1e-9)
    return null;
  // The recipient's hands must be free — the engine never stacks props.
  if ((recipient.prop ?? null) !== null) return null;
  const object =
    heldSceneObject(snapshot, actor) ?? nearestKindObject(snapshot, actor, held);
  return {
    kind,
    actorId,
    objectId: object?.id ?? null,
    propName: held,
    targetActorId: recipient.id,
    rule: `hand-over:held(${held})->${recipient.id}`,
  };
}

/** Canonical prop name for a pick-up intent, or null when the text implies none. Pure. */
function pickUpPropName(
  text: string,
  snapshot: ManipulationSnapshot,
  actor: CoreActor,
): string | null {
  // Explicit mention of a pickable object names the prop.
  const mentioned = snapshot.objects.filter(
    (o) => o.affordance.pickable && mentionsObject(text, o),
  );
  if (mentioned.length > 0) {
    let best = mentioned[0]!;
    let bestDist = Infinity;
    for (const o of mentioned) {
      const d = distanceToObjectCenter(actor, o);
      if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && o.id < best.id)) {
        best = o;
        bestDist = d;
      }
    }
    return best.affordance.propName;
  }
  // Use verbs imply the kind: sipping → cup, typing → laptop, pouring →
  // cup (but only next to a brew source — pouring across the room is not
  // a pick-up), open/boot/use + kind word → that kind.
  if (SIP_VERB_RE.test(text)) return "cup";
  if (TYPE_VERB_RE.test(text)) return "laptop";
  if (POUR_VERB_RE.test(text)) return nearBrewSource(snapshot, actor) ? "cup" : null;
  return kindWordProp(text);
}

/** Short rule trace for a pick-up plan. Pure. */
function pickUpRule(text: string, objectId: string): string {
  if (PICK_UP_VERB_RE.test(text)) return `verb+mention(${objectId})`;
  if (SIP_VERB_RE.test(text)) return `sip->cup(${objectId})`;
  if (TYPE_VERB_RE.test(text)) return `type->laptop(${objectId})`;
  if (POUR_VERB_RE.test(text)) return `pour->cup(${objectId})`;
  return `kind(${objectId})`;
}

/**
 * The pick-up's scene object: the explicitly mentioned pickable object
 * (nearest on ties), else the nearest pickable object of the implied
 * kind within reach. Null when nothing qualifies. Pure.
 */
function pickUpObject(
  text: string,
  snapshot: ManipulationSnapshot,
  actor: CoreActor,
  propName: string,
): CoreObject | null {
  const mentioned = snapshot.objects.filter(
    (o) => o.affordance.pickable && mentionsObject(text, o),
  );
  const pool =
    mentioned.length > 0
      ? mentioned
      : snapshot.objects.filter(
          (o) => o.affordance.pickable && o.affordance.propName === propName,
        );
  let best: CoreObject | null = null;
  let bestDist = Infinity;
  for (const o of pool) {
    const d = distanceToObjectCenter(actor, o);
    if (d > MANIPULATION_REACH + 1e-9) continue;
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && (best === null || o.id < best.id))) {
      best = o;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Surface object the action puts something down onto ("place the report
 * on the desk"): a surface-affordance object mentioned in the text and
 * within reach. Null otherwise (put down at the actor's feet). Pure.
 */
function putDownSurface(
  text: string,
  snapshot: ManipulationSnapshot,
  actor: CoreActor,
): CoreObject | null {
  for (const o of snapshot.objects) {
    if (!o.affordance.surface) continue;
    if (!mentionsObject(text, o)) continue;
    if (distanceToObjectCenter(actor, o) <= MANIPULATION_REACH + 1e-9) return o;
  }
  return null;
}

/**
 * One fact line describing the executed manipulation for the render
 * input — alongside EXECUTED MOVEMENT / EXACT QUOTE. Pure.
 */
export function describeManipulation(
  plan: ManipulationPlan,
  actorName: string,
  targetName?: string,
): string {
  if (plan.kind === "pick-up") {
    return (
      `${actorName} picked up the ${plan.propName}` +
      (plan.objectId !== null ? ` (${plan.objectId})` : "") +
      ` — ${actorName} now holds the ${plan.propName}.`
    );
  }
  if (plan.kind === "put-down") {
    return (
      `${actorName} set down the ${plan.propName}` +
      (plan.surfaceId !== undefined ? ` on ${plan.surfaceId}` : "") +
      ` — ${actorName} now holds nothing.`
    );
  }
  const to = targetName ?? plan.targetActorId ?? "someone";
  return (
    `${actorName} handed the ${plan.propName} to ${to} — ` +
    `${to} now holds the ${plan.propName}, ${actorName} holds nothing.`
  );
}

/**
 * Manipulation kinds the NARRATIVE describes (transfer events only —
 * pick up / put down / hand over). Stative "holds/carries" is not an
 * event; use verbs (sip/type/open) are not transfers. Used by the
 * phantom-manipulation gate: the engine owns every transfer, so prose
 * describing one the engine didn't execute is fiction. Pure.
 */
export function detectNarrativeManipulation(narrative: string): ManipulationKind[] {
  const kinds: ManipulationKind[] = [];
  if (PICK_UP_VERB_RE.test(narrative)) kinds.push("pick-up");
  if (PUT_DOWN_VERB_RE.test(narrative)) kinds.push("put-down");
  const clean = narrative.replace(SHAKE_HANDS_RE, " ");
  if (HAND_OVER_VERB_RE.test(clean)) kinds.push("hand-over");
  return kinds;
}

/**
 * Engine-output invariants for a manipulation plan (Phase 1 pattern:
 * the validator's object checks become these assertions, not retry
 * triggers). Returns violation strings — empty means the plan is sound.
 * Pure.
 */
export function assertManipulationInvariants(
  snapshot: ManipulationSnapshot,
  plan: ManipulationPlan,
): string[] {
  const violations: string[] = [];
  const actor = snapshot.actors.find((a) => a.id === plan.actorId);
  if (!actor) {
    violations.push(`unknown actor ${plan.actorId}`);
    return violations;
  }
  if (plan.objectId !== null) {
    const obj = snapshot.objects.find((o) => o.id === plan.objectId);
    if (!obj) {
      violations.push(`unknown object ${plan.objectId}`);
    } else if (plan.kind === "pick-up" && !obj.affordance.pickable) {
      violations.push(`object ${plan.objectId} is not pickable`);
    }
  }
  if (plan.kind === "pick-up" && (actor.prop ?? null) !== null) {
    violations.push(`actor ${plan.actorId} already holds ${actor.prop}`);
  }
  if (plan.kind !== "pick-up" && (actor.prop ?? null) !== plan.propName) {
    violations.push(
      `actor ${plan.actorId} holds ${actor.prop ?? "nothing"}, plan moves ${plan.propName}`,
    );
  }
  if (plan.kind === "hand-over") {
    if (plan.targetActorId === undefined) {
      violations.push("hand-over has no recipient");
    } else {
      const recipient = snapshot.actors.find((a) => a.id === plan.targetActorId);
      if (!recipient) {
        violations.push(`unknown recipient ${plan.targetActorId}`);
      } else {
        if (Math.hypot(actor.x - recipient.x, actor.y - recipient.y) > HAND_OVER_REACH + 1e-9) {
          violations.push(`recipient ${recipient.id} out of hand-over reach`);
        }
        if ((recipient.prop ?? null) !== null) {
          violations.push(`recipient ${recipient.id} already holds ${recipient.prop}`);
        }
      }
    }
  }
  return violations;
}
