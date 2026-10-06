import type { Action, Actor, SceneObject, World } from "../types.js";
import { defaultConfig } from "../config.js";
import {
  getVisibleActors,
  getAudibleActors,
  getVisibleObjects,
  getActorById,
} from "./perceptionHelpers.js";

function formatList(items: string[]): string {
  return items.length > 0 ? items.map((m) => `- ${m}`).join("\n") : "(none)";
}

export type SubjectiveContextOptions = {
  /** Recent-history entries to include. Defaults to proposalHistoryLimit (20). */
  historyLimit?: number;
  /** Max suggestions requested. Defaults to maxProposalSuggestions (10). */
  maxSuggestions?: number;
};

function resolveHistoryLimit(opts?: SubjectiveContextOptions): number {
  return opts?.historyLimit ?? defaultConfig.proposalHistoryLimit;
}

function resolveMaxSuggestions(opts?: SubjectiveContextOptions): number {
  return opts?.maxSuggestions ?? defaultConfig.maxProposalSuggestions;
}

function formatVisibleActors(visible: Actor[]): string {
  if (visible.length === 0) return "(none)";
  return visible
    .map((a) => {
      const cues = [`emotion=${a.emotion || "unknown"}`];
      if (a.pose) cues.push(`pose=${a.pose}`);
      if (a.prop) cues.push(`prop=${a.prop}`);
      return `${a.name} (${a.id}) at (${a.x}, ${a.y}): ${a.state}; ${cues.join(", ")}`;
    })
    .join(" | ");
}

function formatVisibleObjects(objects: SceneObject[]): string {
  if (objects.length === 0) return "(none)";
  return objects
    .map((o) => `${o.name} (${o.id}) at (${o.x}, ${o.y}) [${o.passable ? "passable" : "blocked"}]: ${o.description}`)
    .join(" | ");
}

const THOUGHTS_GUIDANCE =
  "Thoughts (your immediate inner reaction to the last event — HIGH PRIORITY, this guides what you do next; private, never spoken aloud, never narrated; be blunt, candid, profane/explicit when in-character)";

// Proposal and Selection contexts contain ONLY what the current actor
// perceives, remembers, believes, and knows — never another actor's
// private memories, beliefs, hidden goals, or unperceived events.
//
// Proposal is a slim affordance brainstorm (position + high-priority
// thoughts + state + goal + perceivables + narrative/history + beliefs +
// memories + constraints). Persona, emotion, and relationships are
// deliberately dropped here — Selection (the Laya personality gate) owns
// personalization. Selection uses the full subjective context instead.
export function buildProposalContext(
  world: World,
  actorId: string,
  opts?: SubjectiveContextOptions,
): string {
  const actor = getActorById(world, actorId);
  if (!actor) throw new Error(`unknown actor: ${actorId}`);
  const visible = getVisibleActors(world, actorId);
  const objects = getVisibleObjects(world, actorId);
  const historyLimit = resolveHistoryLimit(opts);
  const maxSuggestions = resolveMaxSuggestions(opts);
  const recentHistory = world.history.slice(-historyLimit).join("\n") || "(no history yet)";

  return [
    "Current Actor",
    "",
    `ID: ${actor.id}`,
    `Name: ${actor.name}`,
    `State: ${actor.state}`,
    `Goal: ${actor.goal}`,
    `${THOUGHTS_GUIDANCE}: ${actor.thoughts || "(none yet)"}`,
    "",
    "Memories",
    "",
    formatList(actor.memories),
    "",
    "Beliefs",
    "",
    formatList(actor.beliefs),
    "",
    "Perceived Environment",
    "",
    `Position: ${actor.x}, ${actor.y}`,
    `Visible actors: ${formatVisibleActors(visible)}`,
    `Visible objects: ${formatVisibleObjects(objects)}`,
    `Current narrative: ${world.narrative}`,
    `Recent history: ${recentHistory}`,
    `Tick: ${world.tick}`,
    "",
    "Physical constraints: actors are points; non-passable objects block movement; movement must be reachable; stay inside scene bounds.",
    "",
    "Task",
    "",
    `Generate up to ${maxSuggestions} possible actions this actor could take right now.`,
    "Actions may be physical, verbal, emotional, social, object-related, or any combination.",
    "Do not use fixed action categories.",
    "Each suggestion must be one free-form action sentence or short paragraph.",
    "Return JSON only.",
  ].join("\n");
}

function buildFullActorContext(
  world: World,
  actorId: string,
  opts?: SubjectiveContextOptions,
): string {
  const actor = getActorById(world, actorId);
  if (!actor) throw new Error(`unknown actor: ${actorId}`);
  const visible = getVisibleActors(world, actorId);
  const objects = getVisibleObjects(world, actorId);
  const historyLimit = resolveHistoryLimit(opts);
  const recentHistory = world.history.slice(-historyLimit).join("\n") || "(no history yet)";

  return [
    "Current Actor",
    "",
    `ID: ${actor.id}`,
    `Name: ${actor.name}`,
    `Persona: ${actor.persona}`,
    `State: ${actor.state}`,
    `Emotion: ${actor.emotion}`,
    `Goal: ${actor.goal}`,
    `${THOUGHTS_GUIDANCE}: ${actor.thoughts || "(none yet)"}`,
    "",
    "Memories",
    "",
    formatList(actor.memories),
    "",
    "Beliefs",
    "",
    formatList(actor.beliefs),
    "",
    "Relationships",
    "",
    formatList(actor.relationships),
    "",
    "Perceived Environment",
    "",
    `Position: ${actor.x}, ${actor.y}`,
    `Visible actors: ${formatVisibleActors(visible)}`,
    `Visible objects: ${formatVisibleObjects(objects)}`,
    `Current narrative: ${world.narrative}`,
    `Recent history: ${recentHistory}`,
    `Tick: ${world.tick}`,
    "",
    "Physical constraints: actors are points; non-passable objects block movement; movement must be reachable; stay inside scene bounds.",
    "",
    "Task",
    "",
    "Generate possible actions this actor could take right now.",
    "Actions may be physical, verbal, emotional, social, object-related, or any combination.",
    "Do not use fixed action categories.",
    "Each suggestion must be one free-form action sentence or short paragraph.",
    "Return JSON only.",
  ].join("\n");
}

export function buildSelectionContext(
  world: World,
  actorId: string,
  suggestions: string[],
  opts?: SubjectiveContextOptions,
): string {
  const fullContext = buildFullActorContext(world, actorId, opts);
  const candidates =
    suggestions.length > 0
      ? suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "(no candidates)";
  return [
    fullContext,
    "",
    "Candidate Actions",
    "",
    candidates,
    "",
    "Task",
    "",
    "Choose the action this actor actually performs.",
    "You may choose a candidate action or produce a different action if it better fits the actor and situation.",
    "Return the action text alone, without any leading candidate number (never '1. ...' or '3) ...').",
    "Return JSON only.",
  ].join("\n");
}

// Consequence context includes the full objective world because it
// updates all affected actors and objects.
export function buildConsequenceContext(
  world: World,
  action: Action,
  feedback?: string,
): string {
  const actor = getActorById(world, action.actorId);
  const perceivers = actor
    ? world.actors.filter((o) => {
        if (o.id === action.actorId) return true;
        const from = { x: o.x, y: o.y };
        const to = { x: actor.x, y: actor.y };
        return (
          getVisibleActors(world, o.id).some((a) => a.id === action.actorId) ||
          getAudibleActors(world, o.id).some((a) => a.id === action.actorId) ||
          Math.abs(from.x - to.x) + Math.abs(from.y - to.y) <= 2
        );
      })
    : [];
  const lines = [
    "Full Objective World",
    "",
    JSON.stringify(world),
    "",
    "Current Action",
    "",
    `Actor ID: ${action.actorId}`,
    `Action text: ${action.text}`,
    "",
    `Acting actor position: ${actor ? `${actor.name} (${actor.id}) at (${actor.x}, ${actor.y})` : "(unknown)"}`,
    `All actor positions: ${world.actors.length > 0 ? world.actors.map((a) => `${a.name} (${a.id}) at (${a.x}, ${a.y})`).join(" | ") : "(none)"}`,
    "If the action says to move toward/close to/next to/beside someone, the new x,y MUST be strictly closer to that actor than the current position (Euclidean distance). Example: an actor at (1,10) moving toward someone at (8,8) could go to (5,8) — never inside a desk rect, stand NEXT to it.",
    "",
    `Perceiving actors (MUST each get an actorPatch with a fresh 'thoughts' reaction, even if nothing else changes): ${
      perceivers.length > 0 ? perceivers.map((a) => `${a.name} (${a.id})`).join(" | ") : "(acting actor only)"
    }`,
    "Actors NOT listed here perceived nothing — do NOT patch them.",
    "",
    "Physical Constraints",
    "",
    `Scene bounds: 0,0 to ${world.scene.width},${world.scene.height}`,
    "Actors are points.",
    "Objects are axis-aligned rectangles.",
    "Objects with passable=false block movement.",
    "Objects with blocksVision=true block sight.",
    "Objects with blocksSound=true strongly reduce hearing.",
    "Movement is immediate but must be physically reachable.",
    "Do not move actors outside the scene.",
    "Do not move actors into non-passable objects.",
    "MOVEMENT RULE: declare what the action does in \"effects\" (\"moved\" true ONLY for the acting actor's own whole-body locomotion — a position change).",
    "Emit x and y for the acting actor IFF \"moved\" is true, with a NEW position reflecting that movement; if it names another actor, the new position MUST be strictly closer to that actor and \"destinationActorId\" MUST carry that actor's exact id.",
    "\"spoke\" is true when the acting actor utters words; \"quotedSpeech\" lists the exact uttered segments (empty when nothing is said).",
    "In-place gestures (turn/look/shake or nod the head, wave/raise a hand, reach for an object, sip/drink) and someone ELSE's motion in a subordinate clause ('as he enters') are NOT locomotion — no x/y change needed. Resuming a task ('return/returning/back to typing/staring/work/task/focus') is NOT locomotion either — only 'return to <place>' counts. Never place an actor INSIDE a desk/table rect; stand NEXT to it.",
  ];
  if (feedback) {
    lines.push("", "Validation Feedback (previous output was invalid)", "", feedback);
  }
  lines.push(
    "",
    "TURN DISCIPLINE (strict — a character only acts on its own turn)",
    "",
    `Acting actor this turn: ${action.actorId}. ONLY this actor may speak, move, change physical state, or perform any observable action.`,
    "All other actors are observers of this event. They MUST NOT speak (no dialogue, no quoted replies, no 'calls back' / 'says' / 'nods welcome'), MUST NOT move (no x/y changes), and MUST NOT change state.",
    "Observers may only react INTERNALLY: set their one-time 'thoughts' field (private immediate inner reaction to this event — never spoken aloud, never narrated; be blunt, candid, profane/explicit when in-character, e.g. surprise, recognition, annoyance), and optionally adjust emotion, goal, memoriesAppend, beliefsAppend, relationshipsAppend.",
    "Set 'thoughts' for EVERY perceiving actor listed above (including the acting actor — its take on what just happened). Thoughts are one-time and will guide that actor's next turn. An event with no observer patch means that observer recorded no reaction.",
    `Narrative rule: describe ONLY what ${action.actorId} observably does, grounded strictly in the given action text.`,
    "If the action is speech, preserve its wording — quote or closely paraphrase it, never invent different dialogue lines. If the action contains quoted words, the narrative MUST contain those same words.",
    "Do NOT describe any other actor perceiving, hearing, speaking, moving, glancing, looking up, or reacting — even passively.",
    "You may name another actor only as a stationary spatial landmark for the acting actor's own movement (e.g. 'toward Jeff'), never as someone doing something.",
    "Observer awareness belongs ONLY in their thoughts/memoriesAppend patches, never in the narrative. Each observer's visible response belongs to their own future turn.",
    "",
    "Task",
    "",
    "Interpret the action naturally and determine what happens next.",
    "Patch ONLY affected actors/objects (listed perceivers + observably changed objects) — never re-emit unchanged walls/furniture.",
    "Add memories, beliefs, and relationships when relevant.",
    "Use concise natural-language strings.",
    "Return COMPACT single-line JSON only.",
  );
  return lines.join("\n");
}
