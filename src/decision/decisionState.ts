// Slim state builders for Laya: persona + goal + recent events +
// roster/landmarks, hard-budgeted so the state stays well under the
// 512-token checkpoint limit (~1600 chars total, ~400 tokens).
// Pure functions — no I/O, fully unit-tested.

import type { Actor, World } from "../types.js";

/** Hard ceiling for any built state document (chars). */
export const STATE_CHAR_BUDGET = 1600;

/** Rough token estimate: ~4 chars per token for English prose. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate to n chars, preferring a word boundary, with an ellipsis marker. */
export function truncateToChars(text: string, n: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= n) return clean;
  const cut = clean.slice(0, n - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > n * 0.5 ? cut.slice(0, lastSpace) : cut}…`;
}

function findActor(world: World, actorId: string): Actor | undefined {
  return world.actors.find((a) => a.id === actorId);
}

function personaBlock(actor: Actor, budget: number): string {
  const bits = [
    `Persona: ${actor.persona}`,
    `Goal: ${actor.goal}`,
    `Feeling: ${actor.emotion || "neutral"}; doing: ${actor.state || "idle"}`,
  ];
  // thoughts is optional at runtime (untyped callers such as
  // scripts/diagnose-ai.ts build worlds without it, and the field is
  // one-time/consumable) — a missing field must never crash the state
  // build that feeds the Laya selection engine.
  if (actor.thoughts?.trim()) bits.push(`Thinking: ${actor.thoughts}`);
  return truncateToChars(bits.join(" "), budget);
}

function recentEventsBlock(world: World, budget: number, count: number): string {
  const entries = world.history.slice(-count);
  if (entries.length === 0) return "";
  const lines = entries.map((e, i) => `${i + 1}. ${e.text}`);
  return truncateToChars(`Recent events:\n${lines.join("\n")}`, budget);
}

function rosterBlock(world: World, actorId: string, budget: number): string {
  const others = world.actors.filter((a) => a.id !== actorId);
  if (others.length === 0) return "";
  const lines = others.map(
    (a) => `- ${a.name}: ${a.emotion || "neutral"}, ${a.state || "idle"}`,
  );
  return truncateToChars(`Others present:\n${lines.join("\n")}`, budget);
}

function landmarksBlock(world: World, budget: number): string {
  const names = world.scene.objects.map((o) => o.name).filter(Boolean);
  if (names.length === 0) return "";
  return truncateToChars(`Landmarks: ${names.join(", ")}`, budget);
}

function assemble(sections: string[]): string {
  return truncateToChars(
    sections.filter((s) => s.length > 0).join("\n\n"),
    STATE_CHAR_BUDGET,
  );
}

/** Slim state for the intent cascade: who the actor is + what just happened. */
export function buildIntentState(world: World, actorId: string): string {
  const actor = findActor(world, actorId);
  if (!actor) throw new Error(`buildIntentState: unknown actor "${actorId}"`);
  return assemble([
    `You are ${actor.name}.`,
    personaBlock(actor, 500),
    recentEventsBlock(world, 600, 3),
    rosterBlock(world, actorId, 300),
    landmarksBlock(world, 200),
  ]);
}

/** Slim state for the candidate-fit choice: intent state + numbered candidates. */
export function buildCandidateState(
  world: World,
  actorId: string,
  candidates: string[],
): string {
  const base = buildIntentState(world, actorId);
  const numbered = candidates
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  const list = truncateToChars(`Candidate actions:\n${numbered}`, 700);
  return assemble([base, list]);
}

/**
 * Slim state for the semantic judge set: the action text plus the name
 * inventories the choice questions resolve against.
 */
export function buildJudgeState(
  actionText: string,
  rosterNames: string[],
  landmarkNames: string[],
): string {
  return assemble([
    truncateToChars(`Action: ${actionText}`, 800),
    rosterNames.length > 0
      ? truncateToChars(`People: ${rosterNames.join(", ")}`, 400)
      : "",
    landmarkNames.length > 0
      ? truncateToChars(`Places: ${landmarkNames.join(", ")}`, 400)
      : "",
  ]);
}

/**
 * Slim state for the renderability score: the actor (position/pose/prop),
 * the chosen action text, nearby people with positions, nearby objects
 * with positions, and whether the action contains quoted speech. The
 * renderability question is spatial ("can this be faithfully turned into
 * concrete world changes here?"), so positions are first-class.
 */
export function buildRenderabilityState(
  world: World,
  actorId: string,
  actionText: string,
): string {
  const actor = findActor(world, actorId);
  if (!actor) throw new Error(`buildRenderabilityState: unknown actor "${actorId}"`);
  const others = world.actors
    .filter((a) => a.id !== actorId)
    .map((a) => `- ${a.name} at (${a.x}, ${a.y}), ${a.pose || "stand"}`)
    .join("\n");
  const nearby = world.scene.objects
    .map((o) => {
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      return { o, d: Math.hypot(actor.x - cx, actor.y - cy) };
    })
    .filter(({ d }) => d <= 6)
    .sort((a, b) => a.d - b.d)
    .slice(0, 8)
    .map(({ o, d }) => `- ${o.name} at (${o.x}, ${o.y}), ${d.toFixed(1)} cells away`)
    .join("\n");
  const hasQuote = /"[^"]+"/.test(actionText);
  return assemble([
    `You are ${actor.name} at (${actor.x}, ${actor.y}), pose ${actor.pose || "stand"}${actor.prop ? `, holding ${actor.prop}` : ""}.`,
    truncateToChars(`Action to render: ${actionText}`, 400),
    others ? truncateToChars(`Others:\n${others}`, 300) : "",
    nearby ? truncateToChars(`Nearby objects:\n${nearby}`, 400) : "",
    hasQuote ? "The action contains quoted speech." : "The action contains no quoted speech.",
  ]);
}
