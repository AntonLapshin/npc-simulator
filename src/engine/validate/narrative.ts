// Narrative actor, observer-discipline, state-coherence and addressee checks
// (extracted from physicalValidator.ts).

import type { Action, ActionSemantics, EngineConfig, ValidationError, World } from "../../types.js";
import { defaultConfig } from "../../config.js";
import { getAudibleActors, getVisibleActors } from "../perceptionHelpers.js";
import { maskResumedActivity, quotedSegments } from "./speech.js";
import { isActorMentioned } from "../deterministicSemantics.js";
import { distanceToRect, isNonLocomotionSense, CONTACT_RADIUS } from "./movement.js";
import { OBJECT_INTERACT_RADIUS } from "./objects.js";

/**
 * Actors that perceived the acting actor's event (mirrors contextBuilder).
 * F7: takes the injected EngineConfig so perception-radius overrides apply.
 */
export function perceiverIds(
  world: World,
  actingActorId: string,
  cfg: EngineConfig = defaultConfig,
): Set<string> {
  const actor = world.actors.find((a) => a.id === actingActorId);
  const out = new Set<string>([actingActorId]);
  if (!actor) return out;
  for (const o of world.actors) {
    if (o.id === actingActorId) continue;
    const sees = getVisibleActors(world, o.id, cfg).some((a) => a.id === actingActorId);
    const hears = getAudibleActors(world, o.id, cfg).some((a) => a.id === actingActorId);
    const adjacent =
      Math.abs(o.x - actor.x) + Math.abs(o.y - actor.y) <= 2;
    if (sees || hears || adjacent) out.add(o.id);
  }
  return out;
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
/**
 * Exp-3 item 6 (S3, tick-20 repro): identity-consistency gate. The
 * consequence "Dana approaches Tanya's desk and greets her: 'Good morning,
 * Tanya. I'm Dana, the new hire.'" passed every prose gate — both names
 * are roster-valid, no observer-as-subject — yet Dana is the recruiter and
 * Anton is the new hire. The claim entered canonical history and then
 * Dana's compounding memory. First-person identity claims in the narrative
 * are checked against the roster:
 * - "I'm <Name>" / "I am <Name>" / "my name is <Name>" where <Name> is a
 *   DIFFERENT roster actor's name/id → identity theft.
 * - "I'm the new <role>" / "I'm a new <role>" where another actor's goal
 *   marks THEM as the newcomer (first day / new hire / newcomer /
 *   onboarding) and the claimant's goal does not → role theft.
 * Skipped when the ACTION text itself contains the claimed phrase — the
 * action is ground truth and the validator must not punish obedience.
 * Pure.
 */
const SELF_NAME_CLAIM_RES = [
  /\bi\s+am\s+([A-Z][a-z]{2,})\b/gi,
  /\bi[''']m\s+([A-Z][a-z]{2,})\b/gi,
  /\bmy\s+name\s+is\s+([A-Z][a-z]{2,})\b/gi,
];
const NEWCOMER_CLAIM_RE =
  /\bi[''']?\s*(?:a)?m\s+(?:[A-Z][a-z]+,?\s+)?(?:the\s+|a\s+)?new\s+([a-z]{3,})\b/i;
const NEWCOMER_MARKER_RE = /first day|new hire|newcomer|just joined|onboarding|first-day/i;

function rosterNameHits(world: World, actorId: string, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const a of world.actors) {
    if (a.id === actorId) continue;
    const candidates = [
      a.name.toLowerCase(),
      a.id.toLowerCase(),
      ...a.name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3),
    ];
    if (candidates.includes(lower)) return a.id;
  }
  return undefined;
}

export function validateIdentityConsistency(
  world: World,
  narrative: string,
  action: Action,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const actor = world.actors.find((a) => a.id === action.actorId);
  const actionLower = action.text.toLowerCase();
  // 1. "I'm <Name>" claims pointing at another roster actor.
  for (const re of SELF_NAME_CLAIM_RES) {
    for (const m of narrative.matchAll(re)) {
      const claimed = m[1]!;
      // Obedience: the action scripted this introduction — not theft.
      if (actionLower.includes(claimed.toLowerCase())) continue;
      const otherId = rosterNameHits(world, action.actorId, claimed);
      if (otherId !== undefined) {
        errors.push({
          code: "narrative.identity_theft",
          message: `narrative has ${action.actorId} claiming to be "${claimed}" (roster actor ${otherId}): an actor never claims another roster actor's name — describe only the acting actor's own role`,
        });
        return errors;
      }
    }
  }
  // 2. "I'm the new <role>" claims when someone else is the newcomer.
  {
    const re = new RegExp(NEWCOMER_CLAIM_RE.source, "i");
    const m = re.exec(narrative);
    if (m) {
      const role = m[1]!.toLowerCase();
      if (!actionLower.includes("new hire") && !actionLower.includes(`new ${role}`)) {
        const claimantIsNewcomer =
          actor !== undefined && NEWCOMER_MARKER_RE.test(actor.goal ?? "");
        if (!claimantIsNewcomer) {
          const newcomer = world.actors.find(
            (a) => a.id !== action.actorId && NEWCOMER_MARKER_RE.test(a.goal ?? ""),
          );
          if (newcomer !== undefined) {
            errors.push({
              code: "narrative.identity_theft",
              message: `narrative has ${action.actorId} claiming to be "the new ${role}" but ${newcomer.id} is the established newcomer (${newcomer.goal?.slice(0, 60) ?? "new-hire role"}): an actor never claims another character's role — stay in the acting actor's own role from the context`,
            });
          }
        }
      }
    }
  }
  return errors;
}

/** True when free text names a roster actor (id, full name, or first name). Pure. */
function textMentionsActor(text: string, actor: { id: string; name: string }): boolean {
  const lower = text.toLowerCase();
  const first = actor.name.split(/[^a-z0-9]+/i)[0]?.toLowerCase() ?? "";
  return (
    (actor.id.length >= 2 && lower.includes(actor.id.toLowerCase())) ||
    (actor.name.length >= 2 && lower.includes(actor.name.toLowerCase())) ||
    (first.length >= 3 && new RegExp(`\\b${first}\\b`).test(lower))
  );
}

/**
 * Exp-6 item 7 (S4, tick-10 repro): relationship-label consistency. The
 * consequence relabeled a known coworker "the stranger" ("Tanya: approach
 * the stranger" — Anton is the ex-coworker who referred her). In a closed
 * roster an alienation label can only mislabel someone the actor knows.
 * Fires when the narrative carries such a label and the acting actor's
 * relationships name at least one other roster actor they actually know.
 * A "has not met X yet" entry does NOT count as knowing — Dana may
 * legitimately call Anton a stranger. Pure.
 */
const ALIENATION_LABEL_RE =
  /\b(a|the|some)\s+stranger\b|\bunknown\s+(person|man|woman|coworker|colleague|guy|visitor)\b/i;
const NOT_MET_RE =
  /\b(not met|never met|hasn't met|has not met|haven't met|have not met|unknown to)\b/i;

export function validateRelationshipLabel(
  world: World,
  narrative: string,
  action: Action,
): ValidationError[] {
  const m = ALIENATION_LABEL_RE.exec(narrative);
  if (!m) return [];
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!actor) return [];
  // The label is only certainly wrong when the actor knows at least one
  // roster coworker and has NO relationship naming someone they have not
  // met yet. Dana knows Tanya but has not met Anton — "the stranger" may
  // legitimately refer to Anton, so the gate fails open there.
  let knownOthers = 0;
  let hasUnknownOther = false;
  for (const o of world.actors) {
    if (o.id === action.actorId) continue;
    const entries = (actor.relationships ?? []).filter((r) =>
      textMentionsActor(r, o),
    );
    if (entries.length === 0) continue;
    if (entries.some((r) => NOT_MET_RE.test(r))) {
      hasUnknownOther = true;
    } else {
      knownOthers += 1;
    }
  }
  if (knownOthers === 0 || hasUnknownOther) return [];
  return [
    {
      code: "narrative.stranger_label",
      message:
        `narrative labels someone "${m[0]}" but ${action.actorId} knows their roster coworkers ` +
        `(${(actor.relationships ?? []).slice(0, 2).join("; ")}): in a closed roster there are ` +
        `no strangers — name the known coworker instead`,
    },
  ];
}

/**
 * Exp-6 item 7 (S4, tick-13 repro): invented-contact attribution. A
 * description-only object patch claimed "Tanya's papers now have a coffee
 * stain from Anton's cup" — Anton was 7 cells away and never touched the
 * papers. Description patches are exempt from the F4 proximity rule, so
 * cross-actor physical causation slips through. Fires when an objectPatch
 * description attributes a physical effect (stain/spill/break/tear/
 * scratch/dent/mark/dirty/burn/wet/knock/splash) to ANOTHER roster actor
 * (not the acting actor) who stands farther than OBJECT_INTERACT_RADIUS
 * (edge distance) from the object in the pre-patch world. Pure.
 */
const CONTACT_EFFECT_RE =
  /\b(stains?|stained|spills?|spilled|breaks?|brok(?:e|en)|tears?|tore|torn|scratch(?:es|ed)?|dents?|dented|marks?|marked|dirt(?:y|ied)|burn(?:s|ed|t)?|wets?|wetted|knocks?|knocked|splash(?:es|ed)?)\b/i;

/**
 * Exp-6 item 8 (M8): third-person fallback rewrite. User-turn fallbacks
 * canonicalize the raw user text ("Anton tried: I turn toward Dana and
 * say: …") — the first-person narrator then leaks into third-person
 * history (exp-6 ticks 9/18). Quoted segments are the character speaking
 * (legitimately first-person) and are preserved verbatim, as is the text
 * following a speech verb + colon ("say: Hi Dana, I am Anton" — the
 * utterance is the character's voice, correctly first-person); unquoted,
 * non-utterance first-person self-reference is rewritten deterministically
 * (I→they, my→their, me→them, myself→themself, we→they, …), with
 * sentence-start capitalization preserved. Pure.
 */
const SPEECH_TAIL_RE =
  /\b(says?|said|asks?|asked|tells?|told|replies?|replied|answers?|answered|shouts?|shouted|whispers?|whispered|exclaims?|exclaimed|utters?|uttered)\s*:/i;

export function thirdPersonFallbackText(text: string): string {
  // Split off the spoken tail first: "say: Hi Dana, I am Anton" keeps its
  // first-person voice (it is the character speaking, not the narrator).
  const tailMatch = SPEECH_TAIL_RE.exec(text);
  let head = text;
  let tail = "";
  if (tailMatch) {
    const cut = tailMatch.index + tailMatch[0].length;
    head = text.slice(0, cut);
    tail = text.slice(cut);
  }
  const quotes = quotedSegments(head);
  let out = head;
  const saved: string[] = [];
  quotes.forEach((q, i) => {
    const placeholder = `Q${i}`;
    saved.push(q);
    out = out.split(q).join(placeholder);
  });
  const atSentenceStart = (offset: number): boolean => {
    const before = out.slice(0, offset).replace(/\s+$/, "");
    return before.length === 0 || /[.!?]$/.test(before);
  };
  const rules: Array<[RegExp, string]> = [
    [/\bI'm\b/g, "they're"],
    [/\bI've\b/g, "they've"],
    [/\bI'll\b/g, "they'll"],
    [/\bI'd\b/g, "they'd"],
    [/\bI\b/g, "they"],
    [/\bmyself\b/gi, "themself"],
    [/\bmy\b/gi, "their"],
    [/\bmine\b/gi, "theirs"],
    [/\bme\b/gi, "them"],
    [/\bourselves\b/gi, "themselves"],
    [/\bours\b/gi, "theirs"],
    [/\bour\b/gi, "their"],
    [/\bwe\b/gi, "they"],
    [/\bus\b/gi, "them"],
  ];
  for (const [re, word] of rules) {
    out = out.replace(re, (_m, offset: number) =>
      atSentenceStart(offset) ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    );
  }
  saved.forEach((q, i) => {
    out = out.split(`Q${i}`).join(q);
  });
  return out + tail;
}

/**
 * Exp-3 item 10 (S8, tick-3 repro): thought-grounding check. Triage gates
 * WHETHER thoughts are written; nothing gates WHAT they claim — so
 * "Giving Dana the pen she requested" (Dana never asked for a pen) and
 * identity-echo thoughts land as canonical inner life. Two deterministic
 * content rules, applied to every thoughts patch (acting actor and
 * observers):
 * - no new proper nouns: findUnknownPersonNames over the thoughts text —
 *   a thought naming someone outside the roster/object vocabulary is
 *   rejected ("Another day, same Liam."-class false memories).
 * - no ungrounded request/grant claims: "the pen she requested", "gave me
 *   the laptop", "told me I could take it" — the claimed object noun must
 *   appear somewhere in world history (or the action text); otherwise the
 *   thought invents a past that never happened.
 * Hard errors in the retry loop (the model rewrites the thought cheaply);
 * the codes join TIER2 so salvage may downgrade them to warnings rather
 * than killing an otherwise good turn.
 * Pure.
 */
const THOUGHT_CLAIM_RES = [
  // "the pen she requested" / "the laptop Dana promised"
  /\b(?:the|a|an|my|his|her|their)\s+([a-z]{3,})\s+(?:she|he|they|[A-Z][a-z]+)\s+(requested|asked for|wanted|promised|offered)\b/i,
  // "gave me the pen" / "handed me the laptop"
  /\b(?:gave|given|handed|lent|offered)\s+me\s+(?:the|a|an|my|his|her|their)\s+([a-z]{3,})\b/i,
  // "told me I could take the car" / "said I could use her laptop"
  /\b(?:told|said)\s+me\s+(?:i\s+could|to\s+take|to\s+use|to\s+have)\b[^.]{0,40}\b(?:the|a|an|my|his|her|their)\s+([a-z]{3,})\b/i,
];

/** Nouns too generic to demand history support (never ungrounded). */
const THOUGHT_GENERIC_NOUNS = new Set([
  "time", "day", "way", "thing", "things", "stuff", "lot", "bit", "chance",
  "idea", "plan", "work", "job", "help", "hand",
]);

function thoughtNounGrounded(world: World, action: Action, noun: string): boolean {
  const lower = noun.toLowerCase();
  if (THOUGHT_GENERIC_NOUNS.has(lower)) return true;
  if (action.text.toLowerCase().includes(lower)) return true;
  return world.history.some((h) => h.text.toLowerCase().includes(lower));
}

/**
 * Phase 4: thought grounding for the render contract. The render result
 * carries the acting actor's flat `thoughts` string (no patches) — it must
 * not invent people and must not claim ungrounded past requests/grants.
 * Pure.
 */
export function validateThoughtGrounding(
  world: World,
  action: Action,
  actorId: string,
  thoughts: string | undefined,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (thoughts === undefined || thoughts.trim().length === 0) return errors;
  const unknown = findUnknownPersonNames(world, thoughts);
  if (unknown.length > 0) {
    errors.push({
      code: "thoughts.unknown_proper_noun",
      message: `thoughts for ${actorId} name unknown person "${unknown[0]}" — only roster actors exist; inner reactions never invent people`,
    });
    return errors;
  }
  for (const re of THOUGHT_CLAIM_RES) {
    const m = re.exec(thoughts);
    if (m?.[1] !== undefined && !thoughtNounGrounded(world, action, m[1])) {
      errors.push({
        code: "thoughts.ungrounded_claim",
        message: `thoughts for ${actorId} claim "${m[0].trim().slice(0, 60)}" with no history support — nothing in the story mentions "${m[1].toLowerCase()}"; thoughts describe reactions to what actually happened, never invent past requests or grants`,
      });
      break;
    }
  }
  return errors;
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
    // Item C6 (S3): pronouns — widening the verb list must not turn
    // "She walks" into an unknown-actor hit.
    "he", "she", "they", "it", "him", "her", "them", "his", "hers",
    "their", "theirs", "we", "us", "you", "i",
  ].map((w) => w.toLowerCase()),
);

/**
 * Copulas/auxiliaries: kept in OBSERVER_SUBJECT_VERBS (observer-as-subject
 * detection) but excluded from the unknown-actor name-first audit — "The X
 * is ..." shapes are too noisy there.
 */
const NAME_AUDIT_SKIP_VERBS = new Set(["is", "was", "are", "were", "has", "had"]);

/**
 * Item C6 (S3): person-context patterns shared by the unknown-actor audit
 * and the salvage thought sanitizer (item C5). The name-first verb
 * alternation is derived from OBSERVER_SUBJECT_VERBS minus copulas — one
 * audited verb list, no drift between the two prose gates. Covers the
 * experiment holes: "Liam greets" (greet was missing), "John takes a
 * drink" (takes was missing), "Anton leans against the desk" (leans was
 * missing), plus the ask/tell/answer/thank/call/give/hand/show/meet/join/
 * follow/visit family in both verb-first and name-first positions.
 */
function buildPersonContextRes(): RegExp[] {
  const nameFirstVerbs = [...OBSERVER_SUBJECT_VERBS]
    .filter((v) => !NAME_AUDIT_SKIP_VERBS.has(v))
    .join("|");
  return [
    /\b(?:hey|hi|hello|dear|toward|towards|to|with|for|at|near|beside|behind|greets?|greeting|gives?|gave|pats?|hugs?|embraces?|handshake with|welcomes?|welcomed?|thanks?|thanked?|asks?|tells?|told?|sees?|saw|approaches?|walks?(?: closer)? to|meets?|met|joins?|joined|follows?|followed|calls?|called|shows?|showed|introduces?|introduced|hands?|handed|visits?|visited)\s+([A-Z][a-z]{2,})\b/g,
    new RegExp(`\\b([A-Z][a-z]{2,})\\s+(?:${nameFirstVerbs})\\b`, "g"),
    // Quoted vocatives: "Hey Jeff, welcome!" — the greeting verb sits inside
    // quotes with punctuation between it and the addressee (tick 5 repro).
    // Case-sensitive on purpose: with the `i` flag [A-Z] would also match
    // lowercase words ("Hi all" -> "all").
    /\b(?:[Hh]ey|[Hh]i|[Hh]ello|[Dd]ear|[Ww]elcome)\s+([A-Z][a-z]{2,})\b/g,
    // Appositives with no verb for the audit to catch ("Another day, same
    // Liam." — the tick-10 thought that implanted a false memory).
    /\b(?:same|damn|poor|old|young)\s+([A-Z][a-z]{2,})\b/g,
  ];
}

/**
 * Item C5: person names in person-context positions that match neither the
 * roster nor object vocabulary. Shared core of validateNarrativeActors
 * and the salvage thought sanitizer — exported so turnSalvage can re-run
 * the prose gates after patch-stripping.
 */
export function findUnknownPersonNames(world: World, text: string): string[] {
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
  const suspects = new Set<string>();
  for (const re of buildPersonContextRes()) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) suspects.add(m[1]!);
  }
  const unknown: string[] = [];
  for (const s of suspects) {
    const lower = s.toLowerCase();
    if (roster.has(lower)) continue;
    if (objectTokens.has(lower)) continue;
    if (COMMON_CAPITALIZED.has(lower)) continue;
    unknown.push(s);
  }
  return unknown;
}

/**
 * Narrative name audit (exp-2 item 3, ticks 2/5/14 repro): the patch-ID
 * checks above cannot see names that appear only in prose ("walks closer to
 * Jeff" with no Jeff patch passes them). Fails the first person-context
 * name matching neither the roster nor object vocabulary (see
 * findUnknownPersonNames for the shared scan).
 *
 * Exp-5 item 5 (S4, tick-27 repro): the audit scans the NARRATIVE only —
 * never `reasoning`. Reasoning never becomes canonical history, and the
 * engine itself writes pipeline words into it ("Fallback due to
 * Consequence Engine failure."), so scanning it false-positived on a
 * perfect quote-preserving salvage. Quoted speech inside the narrative is
 * still scanned (it is part of the narrative).
 */
export function validateNarrativeActors(
  world: World,
  normalized: { narrative: string },
): ValidationError[] {
  const unknown = findUnknownPersonNames(world, normalized.narrative);
  if (unknown.length === 0) return [];
  return [
    {
      code: "narrative.unknown_actor",
      message: `narrative names unknown actor "${unknown[0]}" with no roster entry or patch: only the listed actors exist — describe only them, never invent or address anyone else`,
    },
  ];
}

/**
 * Exp-4 item 2 (reverse verb-drop, ticks 2/16): narrative locomotion/pose
 * verbs with no backing patch. The action-side gates check action→patch;
 * the mirror hole is the consequence *adding* "stands up, walks to the
 * kitchen" with `moved=true` and zero coordinates and passing (tick 2).
 * Require: `effects.moved=true` ⇒ position patch present; narrative
 * locomotion verb ⇒ position change; narrative pose-change verb
 * (stand up / sit down) ⇒ pose patch. Only the narrative→patch direction:
 * a movement patch with undescriptive prose (deterministic repairs) stays
 * allowed, so the repair/salvage paths keep validating.
 */
const NARRATIVE_LOCOMOTION_RE =
  /\b(walk|walks|walked|walking|go|goes|went|going|headed|heading|move|moves|moved|moving|approach|approaches|approached|approaching|enter|enters|entered|entering|leave|leaves|left|leaving|return|returns|returned|returning|advance|advances|proceed|proceeds|come|comes|came|coming|follow|follows|followed|join|joins|joined|hurry|hurries|rush|rushes|stroll|strolls|saunter|saunters|drift|drifts|sidle|sidles)\b/i;
// F34: "heads to/toward" (and the headed/heading variants) are locomotion.
const HEAD_VERB_RE = /\b(heads?\s+(to|toward|towards|for|into|out|off|over|back|down|up|north|south|east|west|through|across|along))\b/i;
const NARRATIVE_POSE_CHANGE_RE =
  /\b((stand|stands|standing|stood)\s+up\b|\bsit(s|ting)?\s+down\b|\bsat\s+down\b|\btakes?\s+a\s+seat\b|\bget(s|ting)?\s+up\b)/i;
const STAY_NEGATION_RE = /\b(stay|stays|staying|stayed|remain|remains|remaining|remained|keep|keeps|keeping|kept|continue|continues|continuing|still|without\s+(moving|standing\s+up|sitting\s+down))\b/i;

/**
 * Phase 4: narrative movement/pose grounding for the render contract.
 * Movement and pose are engine-executed — the narrative must describe
 * exactly what the engine did, no more:
 * - narrated locomotion requires the engine to have moved the actor;
 * - a narrated stand-up requires engine pose "stand" (sit-down: "sit");
 * - an explicit stay action ("stay where you are") with an engine move is
 *   always a violation (the tick-11 hole — the action text is ground
 *   truth, immune to any declaration).
 * Pure.
 */
const NARRATIVE_STAND_UP_RE =
  /\b((stand|stands|standing|stood)\s+up\b|\bget(s|ting)?\s+up\b)/i;
const NARRATIVE_SIT_DOWN_RE =
  /\b(sit(s|ting)?\s+down\b|\bsat\s+down\b|\btakes?\s+a\s+seat\b)/i;

export function validateNarrativeMovementGrounding(
  world: World,
  action: Action,
  narrative: string,
  moved: boolean,
  pose: "sit" | "stand" | null,
): ValidationError[] {
  const errors: ValidationError[] = [];
  // Narrated locomotion must move (mask resumed activity + body-part
  // "head" + staying-negations so "return to typing", "shake his head",
  // and "stays seated" never trip this gate).
  let masked = maskResumedActivity(narrative);
  masked = masked.replace(/\b(his|her|my|your|their|its|the|a|an)\s+heads?\b/gi, " ");
  // Metaphor is not movement ("go the extra mile" — mirrors the
  // deterministic action-side mask).
  masked = masked.replace(/\bgo\s+(?:the\s+)?extra\s+mile\b/gi, " ");
  const claimsLocomotion =
    (NARRATIVE_LOCOMOTION_RE.test(masked) || HEAD_VERB_RE.test(masked)) &&
    !STAY_NEGATION_RE.test(masked);
  if (claimsLocomotion && !moved) {
    errors.push({
      code: "movement.narrated_without_move",
      message: `narrative describes movement ("${narrative.slice(0, 80)}") but the engine executed no movement for ${action.actorId} this turn: narrate only the EXECUTED MOVEMENT facts — never describe a walk the engine did not perform`,
    });
  }
  // Narrated pose change must match the engine-executed pose.
  if (NARRATIVE_STAND_UP_RE.test(narrative) && pose !== "stand") {
    errors.push({
      code: "movement.pose_change_ungrounded",
      message: `narrative describes standing up but the engine did not set a standing pose for ${action.actorId} this turn: narrate only what the engine executed — never invent a pose change`,
    });
  }
  if (NARRATIVE_SIT_DOWN_RE.test(narrative) && pose !== "sit") {
    errors.push({
      code: "movement.pose_change_ungrounded",
      message: `narrative describes sitting down but the engine did not set a sitting pose for ${action.actorId} this turn: narrate only what the engine executed — never invent a pose change`,
    });
  }
  // Explicit-stay actions never move, no matter what.
  if (moved && isExplicitStayAction(action.text)) {
    const actor = world.actors.find((a) => a.id === action.actorId);
    errors.push({
      code: "movement.unexpected_move",
      message: `action explicitly says to stay ("${action.text.slice(0, 60)}") but the engine moved ${action.actorId}${actor !== undefined ? ` from (${actor.x}, ${actor.y})` : ""}: a stay action never moves`,
    });
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
    // Item C6 (S3): audit gaps — "Anton leans against the desk" (tick 15)
    // and "John exclaims" walked through both prose gates on these.
    "greet", "lean", "leans", "leaned", "exclaim", "exclaims", "exclaimed",
  ].map((w) => w.toLowerCase()),
);

export function validateObserverSubject(
  world: World,
  normalized: { narrative: string },
  action: Action,
): ValidationError[] {
  const names = observerNameTokens(world, action.actorId);
  if (names.length === 0) return [];
  const observerError = (id: string, clause: string): ValidationError[] => [
    {
      code: "narrative.observer_as_subject",
      message: `narrative casts roster observer "${id}" as the acting subject ("${clause.slice(0, 60)}...") on ${action.actorId}'s turn: describe ONLY what the acting actor (${action.actorId}) observably does — observers react in thoughts patches, never in the narrative`,
    },
  ];
  // Exp-5 item 7 (S3, tick-23 repro): observer-led coordinations, checked
  // on the UNSPLIT clause first. Splitting "Tanya and Dana turn to look…"
  // on "and" shreds it into a bare "tanya" fragment (no Name+verb shape)
  // and an acting-actor-led "dana turn…" clause, so both gates miss the
  // observer cast as co-subject.
  const sentences = normalized.narrative
    .split(/[.!?;]+\s*/)
    .map((c) => c.replace(/^["'(\[]+/, "").trim().toLowerCase())
    .filter((c) => c.length > 0);
  for (const s of sentences) {
    const hit = matchObserverCoordination(s, names);
    if (hit !== undefined && OBSERVER_SUBJECT_VERBS.has(hit.word)) {
      return observerError(hit.id, s);
    }
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
        return observerError(id, clause);
      }
      break; // clause starts with this observer's name but no verb — no error
    }
  }
  return [];
}

/**
 * Exp-5 item 7 (S3, tick-23 repro): observer name tokens shared by the
 * two observer-as-subject gates (validator verb-list version above and
 * the verb-agnostic supplement in turnSalvageGates.ts) so they cannot
 * drift apart.
 */
export function observerNameTokens(
  world: World,
  actingActorId: string,
): Array<{ token: string; id: string }> {
  const names: Array<{ token: string; id: string }> = [];
  for (const o of world.actors) {
    if (o.id === actingActorId) continue;
    names.push({ token: o.name.toLowerCase(), id: o.id });
    names.push({ token: o.id.toLowerCase(), id: o.id });
    const first = o.name.toLowerCase().split(/[^a-z0-9]+/)[0];
    if (first && first.length >= 3) names.push({ token: first, id: o.id });
  }
  return names;
}

/**
 * Exp-5 item 7 (S3, tick-23 repro): observer-led coordination on an
 * unsplit clause. "Tanya and Dana turn to look at Anton" on Dana's turn
 * dodges the and-split gates, so match the coordination directly: a
 * clause leading with an observer name, optionally followed by "and
 * <name>" groups, then another word, casts the observer as (co-)subject.
 * Possessives ("Tanya's hand") and vocatives ("Tanya, …") do not match —
 * the name must be a whole word followed by whitespace — and a trailing
 * "and" never counts as the verb ("Tanya and Dana." is a fragment, not a
 * subject). Returns the observer id and the trailing word, or undefined.
 * Pure.
 */
export function matchObserverCoordination(
  clause: string,
  tokens: Array<{ token: string; id: string }>,
): { id: string; word: string } | undefined {
  for (const { token, id } of tokens) {
    if (token.length < 2) continue;
    const m = new RegExp(
      `^${escapeName(token)}(?![a-z'’])((?:\\s+and\\s+[a-z][a-z'’]*)+)?\\s+(?!and\\b)([a-z]+)`,
    ).exec(clause);
    if (m) return { id, word: m[2]! };
  }
  return undefined;
}

/**
 * Exp-5 item 7 (S3, ticks 23/24 repro): stale "enters the office" prose.
 * Entering is a first-turn event; afterwards the actor is already inside,
 * so "X enters the office/room" is stale (tick 24: "Anton enters the
 * office." 24 ticks after he entered; tick 23 narrated it for Anton on
 * Dana's turn). Fails when any candidate enterer — the acting actor or a
 * roster actor named in the narrative — already has a completed prior
 * turn in history (fallback "tried:" entries count: the turn happened).
 * Known limitation: re-entry across a modeled exit would false-positive;
 * the office scenario models no exits. Pure.
 */
const STALE_ENTER_RE = /\benter(s|ed|ing)?\b[^.?!]{0,60}\b(office|room|building)\b/i;

export function validateEnterFreshness(
  world: World,
  narrative: string,
  action: Action,
): ValidationError[] {
  if (!STALE_ENTER_RE.test(narrative)) return [];
  const candidates = new Set<string>([action.actorId]);
  const lower = narrative.toLowerCase();
  for (const a of world.actors) {
    const idRe = new RegExp(`\\b${escapeName(a.id.toLowerCase())}\\b`);
    const nameRe = new RegExp(`\\b${escapeName(a.name.toLowerCase())}\\b`);
    if (idRe.test(lower) || nameRe.test(lower)) candidates.add(a.id);
  }
  const hasPriorTurn = (actorId: string): boolean => {
    const actor = world.actors.find((a) => a.id === actorId);
    const prefixes =
      actor !== undefined
        ? [`${actor.name}:`, `${actor.id}:`, `${actor.name} tried:`, `${actor.id} tried:`]
        : [`${actorId}:`, `${actorId} tried:`];
    return world.history.some((h) => prefixes.some((p) => h.text.startsWith(p)));
  };
  const staleId = [...candidates].find((id) => hasPriorTurn(id));
  if (staleId === undefined) return [];
  return [
    {
      code: "narrative.stale_enter",
      message: `narrative claims an entrance ("${narrative.slice(0, 80)}...") but ${staleId} already has a completed prior turn — entering the office/room is a first-turn event; describe the actor as already inside`,
    },
  ];
}
/**
 * Exp-4 item 6 (S4/M1): narrative voice gate. NPC action text and canonical
 * narratives are third-person — first-person self-reference ("I point…",
 * "I gesture…") reads as a diary entry in world history (exp-4 M1: 6+
 * occurrences on NPC turns). Quoted speech is stripped first: an uttered
 * "I" inside quotes is the character speaking, not the narrator slipping.
 * Also catches the doubled-name prefix ("Dana: Dana: I glance…", tick 11).
 * Pure.
 */
export type VoiceViolationCode = "first_person" | "doubled_prefix";

export interface VoiceViolation {
  code: VoiceViolationCode;
  detail: string;
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripQuotedForVoice(text: string): string {
  let out = text;
  for (const q of quotedSegments(text)) {
    // Remove the quoted content (the quote marks may stay — harmless).
    out = out.split(q).join(" ");
  }
  return out;
}

export function detectVoiceViolation(
  text: string,
  actorName?: string,
): VoiceViolation[] {
  const out: VoiceViolation[] = [];
  const trimmed = text.trim();
  if (actorName !== undefined && actorName.length > 0) {
    // "Dana: Dana: …" — two or more stacked author prefixes.
    const m = new RegExp(`^(${escapeName(actorName)}\\s*:\\s*){2,}`, "i").exec(trimmed);
    if (m) {
      out.push({
        code: "doubled_prefix",
        detail: `narrative starts with a doubled author prefix ("${m[0].trim()}"): emit exactly one "Name:" prefix`,
      });
    }
  }
  const unquoted = stripQuotedForVoice(text);
  // Capital-I is always the pronoun (\bI\b also catches I'm/I'll/I've —
  // the apostrophe is a word boundary). The rest match case-insensitively.
  const m =
    /\bI\b/.exec(unquoted) ??
    /\b(me|my|mine|we|us|our|ours|myself|ourselves)\b/i.exec(unquoted);
  if (m) {
    const ctx = unquoted
      .slice(Math.max(0, m.index - 32), m.index + 32)
      .replace(/\s+/g, " ")
      .trim();
    out.push({
      code: "first_person",
      detail: `first-person self-reference ("${m[0]}" in "…${ctx}…"): NPC action text and canonical narrative are third-person — rewrite without I/my/me/we outside quoted speech`,
    });
  }
  return out;
}

/** Validator wrapper: voice violations surface as `narrative.*` errors. */
export function validateNarrativeVoice(
  narrative: string,
  actorName?: string,
): ValidationError[] {
  return detectVoiceViolation(narrative, actorName).map((v) => ({
    code: `narrative.${v.code}`,
    message: v.detail,
  }));
}

const MASCULINE_PRONOUNS = ["he", "him", "his", "himself"];
const FEMININE_PRONOUNS = ["she", "her", "hers", "herself"];
/** Subject-case pronouns — the unambiguous self-reference slot. */
const MASCULINE_SUBJECT = ["he"];
const FEMININE_SUBJECT = ["she"];

/**
 * Exp-7 item A6: wrong-set pronouns for an explicit `pronouns` tag.
 * Returns the first offending pronoun, or undefined.
 *
 * `subjectOnly`: check only subject-case pronouns (she/he). Object and
 * possessive pronouns (her/him/his) are genuinely ambiguous in narrative
 * prose — "greets her" after "Tanya's desk" is Tanya, not a misgendering —
 * so narrative prose only flags the unambiguous subject slot ("she
 * says", "as she walks"). State strings are self-descriptive ("sitting
 * at HER desk" = the actor's own desk), so they check the full set.
 *
 * Singular "they" is never flagged for he/him or she/her actors (plural
 * "they" for a group is legitimate); they/them actors check both binary
 * sets.
 */
function findWrongPronoun(
  text: string,
  pronouns: string,
  subjectOnly: boolean,
): string | undefined {
  const wrongFull = pronouns.startsWith("he")
    ? FEMININE_PRONOUNS
    : pronouns.startsWith("she")
      ? MASCULINE_PRONOUNS
      : [...MASCULINE_PRONOUNS, ...FEMININE_PRONOUNS];
  const wrongSubject = pronouns.startsWith("he")
    ? FEMININE_SUBJECT
    : pronouns.startsWith("she")
      ? MASCULINE_SUBJECT
      : [...MASCULINE_SUBJECT, ...FEMININE_SUBJECT];
  const set = subjectOnly ? wrongSubject : wrongFull;
  return set.find((p) => new RegExp(`\\b${p}\\b`, "i").test(text));
}

/**
 * Exp-7 item A6: third-person pronoun check for narrative prose
 * (exp-7 B5: Dana, he/him, rendered "as she says"). Opt-in: only fires
 * when the scenario sets explicit `actor.pronouns`. Quoted speech is
 * stripped first (a quote may mention anyone). Only the subject slot is
 * checked — "greets her" / "near him" refer to the other party, not a
 * misgendering — and clauses naming another actor are skipped entirely.
 * Requires the actor's name in the prose (house style). A hit costs a
 * retry with a targeted hint, never a corrupt world state.
 * Pure.
 */
export function validateNarrativePronouns(
  world: World,
  narrative: string,
  action: Action,
): ValidationError[] {
  const actor = world.actors.find((a) => a.id === action.actorId);
  const pronouns = actor?.pronouns?.trim().toLowerCase();
  if (!actor || !pronouns) return [];
  const unquoted = stripQuotedForVoice(narrative);
  const nameHit = new RegExp(
    `\\b${actor.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i",
  ).test(unquoted);
  if (!nameHit) return [];
  const others = world.actors.filter((a) => a.id !== actor.id);
  // Clause-level: a clause naming another actor may use that actor's
  // pronouns legitimately — only check clauses where no other actor is
  // mentioned.
  for (const clause of unquoted.split(/[.!?;,]+/)) {
    if (others.some((o) => isActorMentioned(world, clause, o.id))) continue;
    const hit = findWrongPronoun(clause, pronouns, true);
    if (hit !== undefined) {
      return [
        {
          code: "narrative.pronoun_mismatch",
          message:
            `narrative uses "${hit}" for ${actor.name}, whose pronouns are ${actor.pronouns} — ` +
            `keep every pronoun for ${actor.name} in the ${actor.pronouns} set (prefer the name over pronouns when another actor is involved)`,
        },
      ];
    }
  }
  return [];
}

/**
 * Deterministic repair for the doubled-prefix shape: "Dana: Dana: …" →
 * "Dana: …". Pure. First-person prose is NOT auto-rewritten (too risky) —
 * it fails the voice gate with a targeted retry hint instead.
 */
export function collapseDoubledPrefix(
  narrative: string,
  actorName?: string,
): string {
  if (actorName === undefined || actorName.length === 0) return narrative;
  return narrative.replace(
    new RegExp(`^(${escapeName(actorName)}\\s*:\\s*){2,}`, "i"),
    `${actorName}: `,
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Item 5 (S2): strip a leading turn-attribution prefix ("Ana: …", "ana - …")
 * before prose checks. Narratives in this codebase carry the acting actor's
 * name as a prefix (see synthesizeActionNarrative), but
 * `validateObserverSubject` matches clause-leading observer names — with
 * the prefix in place the true grammatical subject ("Jeff introduces…")
 * hides behind "Ana:" and the gate never fires. Only the ACTING actor's
 * own name/id is stripped; an observer's prefix ("Jeff: …" on Ana's turn)
 * is left in place so the gates still see it. Pure.
 */
export function stripAttributionPrefix(
  narrative: string,
  actorName: string,
  actorId: string,
): string {
  const dequoted = narrative.replace(/^["'(\[]+/, "");
  for (const label of [actorName, actorId]) {
    if (label.trim().length === 0) continue;
    const m = dequoted.match(new RegExp(`^${escapeRegExp(label.trim())}\\s*[:\\-]\\s*`, "i"));
    if (m) return dequoted.slice(m[0].length);
  }
  return narrative;
}

/**
 * Item 5 (S2): verb-agnostic observer-as-subject supplement. The
 * validator's OBSERVER_SUBJECT_VERBS list missed "introduces" (tick 10:
 * "Jeff introduces Ana to Dan." passed), and any verb list can miss the
 * next one. Per turn discipline the narrative must describe ONLY the
 * acting actor — so ANY clause led by a roster observer's name + word is
 * a violation, regardless of verb. Mirrors validateObserverSubject's
 * clause-splitting and name/boundary handling (possessives like "Tanya's
 * hand" and comma-led "Jeff, smiling," do not match); strictly more
 * sensitive, so it subsumes the validator's list on the stripped narrative.
 * Pure.
 */
export function findSupplementObserverSubject(
  world: World,
  narrative: string,
  action: Action,
): ValidationError[] {
  const names = observerNameTokens(world, action.actorId);
  if (names.length === 0) return [];
  const observerError = (id: string, clause: string): ValidationError[] => [
    {
      code: "narrative.observer_as_subject",
      message: `narrative casts roster observer "${id}" as the acting subject ("${clause.slice(0, 60)}...") on ${action.actorId}'s turn: describe ONLY what the acting actor (${action.actorId}) observably does`,
    },
  ];
  // Exp-5 item 7 (S3, tick-23 repro): observer-led coordinations, checked
  // on the unsplit clause first — the and-split below shreds "Tanya and
  // Dana turn…" into a bare "tanya" fragment and an acting-actor-led
  // clause, hiding the observer. Verb-agnostic here (any trailing word
  // counts); the validator version additionally requires a verb from its
  // list.
  const sentences = narrative
    .split(/[.!?;]+\s*/)
    .map((c) => c.replace(/^["'(\[]+/, "").trim().toLowerCase())
    .filter((c) => c.length > 0);
  for (const s of sentences) {
    const hit = matchObserverCoordination(s, names);
    if (hit !== undefined) return observerError(hit.id, s);
  }
  const clauses = narrative
    .split(/[.!?;]+\s*|\s+and\s+/i)
    .map((c) => c.replace(/^["'(\[]+/, "").trim().toLowerCase())
    .filter((c) => c.length > 0);
  for (const clause of clauses) {
    for (const { token, id } of names) {
      if (token.length < 2) continue;
      if (!clause.startsWith(token)) continue;
      const rest = clause.slice(token.length);
      // Name must be a whole word followed by whitespace + another word
      // ("Jeff introduces…" matches; "Jeff's desk", "Jeff," do not).
      if (/^\s+[a-z]+/.test(rest)) {
        return observerError(id, clause);
      }
      break;
    }
  }
  return [];
}

/**
 * Item 5 (S2): explicit-stay actions. "Stay where you are." carries no
 * locomotion verb, so the movement gates stay silent. The action TEXT is
 * the ground truth: an unambiguous stay instruction plus an actual
 * position change on the acting actor is always a violation. Pure.
 */
const EXPLICIT_STAY_RE =
  /\bstay\b/i;
const EXPLICIT_HOLD_RE =
  /\b(don't|dont|do not) move\b|\bhold (still|your position)\b|\bremain\s+(in place|put|seated|standing|where (you|he|she|they) are|still)\b/i;

export function isExplicitStayAction(text: string): boolean {
  return EXPLICIT_STAY_RE.test(text) || EXPLICIT_HOLD_RE.test(text);
}

/**
 * Phase 4: prose half of the old contact coverage check (the
 * patch-based adjacency half died with the patch channel). When the
 * action describes physical contact with a named roster actor, the
 * narrative must mention the contact — dodging the verb does not excuse
 * dropping it. Pure.
 */
const ACTION_CONTACT_RE =
  /\b(handshake|shake\s+.*hands?|shake\s+.*hand|hug|embrace|kiss|high[\s-]?five|fist[\s-]?bump|\bpat\b|slap|hands?\s+over|handing|hands?\s+(him|her|them)|give\s+.*(coffee|cup)|pass\s+.*(coffee|cup))\b/i;
const NARRATIVE_CONTACT_RE =
  /\b(shake|shook|hands?|hug|embrace|kiss|high[\s-]?five|fist|pat|slap|give|gave|pass|hand)\b/i;

export function validateContactCoverage(
  world: World,
  action: Action,
  narrative: string,
): ValidationError[] {
  if (!ACTION_CONTACT_RE.test(action.text)) return [];
  const namesRosterActor = world.actors.some(
    (a) => a.id !== action.actorId && isActorMentioned(world, action.text, a.id),
  );
  if (!namesRosterActor) return [];
  if (NARRATIVE_CONTACT_RE.test(narrative)) return [];
  return [
    {
      code: "contact.narrative_drops_contact",
      message: `action describes physical contact ("${action.text.slice(0, 80)}") but the narrative never mentions it: narrate the handshake/hug/handover (dodging the verb does not excuse dropping the contact)`,
    },
  ];
}

/**
 * Phase 4: narrated contact must be physically possible. If the narrative
 * claims physical contact with a named roster actor (handshake, hug, ...)
 * but the acting actor's post-move position is not adjacent to them, the
 * contact is invented — the engine closes what it can (6-cell cap), but a
 * handshake across the room is narrative invention beyond the facts.
 * Pure.
 */
export function validateNarratedContactAdjacency(
  world: World,
  action: Action,
  narrative: string,
  x: number,
  y: number,
): ValidationError[] {
  if (!NARRATIVE_CONTACT_RE.test(narrative)) return [];
  const target = world.actors.find(
    (a) => a.id !== action.actorId && isActorMentioned(world, narrative, a.id),
  );
  if (!target) return [];
  const dist = Math.hypot(x - target.x, y - target.y);
  if (dist <= CONTACT_RADIUS) return [];
  return [
    {
      code: "contact.too_far",
      message: `narrative claims physical contact with ${target.id} but the acting actor ends at (${x}, ${y}), ${dist.toFixed(1)} cells away: narrate the approach instead, or drop the contact`,
    },
  ];
}
