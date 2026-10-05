import type { Action, World } from "../types.js";
import {
  getVisibleActors,
  getAudibleActors,
  getVisibleObjects,
  getActorById,
} from "./perceptionHelpers.js";

function formatList(items: string[]): string {
  return items.length > 0 ? items.map((m) => `- ${m}`).join("\n") : "(none)";
}

// Proposal and Selection contexts contain ONLY what the current actor
// perceives, remembers, believes, and knows — never another actor's
// private memories, beliefs, hidden goals, or unperceived events.
export function buildProposalContext(world: World, actorId: string): string {
  const actor = getActorById(world, actorId);
  if (!actor) throw new Error(`unknown actor: ${actorId}`);
  const visible = getVisibleActors(world, actorId);
  const objects = getVisibleObjects(world, actorId);
  const recentHistory = world.history.slice(-6).join("\n") || "(no history yet)";

  return [
    "Current Actor",
    "",
    `ID: ${actor.id}`,
    `Name: ${actor.name}`,
    `Persona: ${actor.persona}`,
    `State: ${actor.state}`,
    `Emotion: ${actor.emotion}`,
    `Goal: ${actor.goal}`,
    `Thoughts (your immediate inner reaction to the last event — this guides what you do next): ${actor.thoughts || "(none yet)"}`,
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
    `Visible actors: ${visible.length > 0 ? visible.map((a) => `${a.name} (${a.id}) at (${a.x}, ${a.y}): ${a.state}`).join(" | ") : "(none)"}`,
    `Visible objects: ${objects.length > 0 ? objects.map((o) => `${o.name} (${o.id}) at (${o.x}, ${o.y}): ${o.description}`).join(" | ") : "(none)"}`,
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
): string {
  const proposalContext = buildProposalContext(world, actorId);
  const candidates =
    suggestions.length > 0
      ? suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "(no candidates)";
  return [
    proposalContext,
    "",
    "Candidate Actions",
    "",
    candidates,
    "",
    "Task",
    "",
    "Choose the action this actor actually performs.",
    "You may choose a candidate action or produce a different action if it better fits the actor and situation.",
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
    "MOVEMENT RULE: if the action text describes movement (walk/go/move/run/step/come/approach/head/enter/leave/follow/closer/toward/next to),",
    "the acting actor's patch MUST include x and y with a NEW position reflecting that movement; if it names another actor, the new position MUST be strictly closer to that actor.",
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
    "Observers may only react INTERNALLY: set their one-time 'thoughts' field (immediate inner reaction to this event, e.g. surprise, recognition, annoyance), and optionally adjust emotion, goal, memoriesAppend, beliefsAppend, relationshipsAppend.",
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
