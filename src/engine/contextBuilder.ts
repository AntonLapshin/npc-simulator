import type { Action, World } from "../types.js";
import {
  getVisibleActors,
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
  const lines = [
    "Full Objective World",
    "",
    JSON.stringify(world, null, 2),
    "",
    "Current Action",
    "",
    `Actor ID: ${action.actorId}`,
    `Action text: ${action.text}`,
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
  ];
  if (feedback) {
    lines.push("", "Validation Feedback (previous output was invalid)", "", feedback);
  }
  lines.push(
    "",
    "Task",
    "",
    "Interpret the action naturally and determine what happens next.",
    "Update only affected actors and objects.",
    "Add memories, beliefs, and relationships when relevant.",
    "Use concise natural-language strings.",
    "Return JSON only.",
  );
  return lines.join("\n");
}
