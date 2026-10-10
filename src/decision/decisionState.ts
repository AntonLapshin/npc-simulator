// Slim state builders for Laya: persona + goal + recent events +
// roster/landmarks, hard-budgeted so the state stays well under the
// 512-token checkpoint limit (~1600 chars total, ~400 tokens).
// Pure functions — no I/O, fully unit-tested.

import type { Actor, World } from "../types.js";
import { CONTACT_RADIUS } from "../engine/validate/movement.js";
import { OBJECT_INTERACT_RADIUS } from "../engine/validate/objects.js";

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

/**
 * Stage 3 C1: a history entry carries spoken dialogue when it embeds a
 * multi-word quoted span. Double quotes are unambiguous; single quotes
 * only count after a says-verb (bare apostrophes pair up across
 * contractions — "doesn't … Tanya's" — and must never count as speech).
 * The space requirement keeps single-word scare-quotes out.
 */
export function historyEntryHasSpeech(text: string): boolean {
  return /"[^"]*\s[^"]*"|\bsays?,?\s*'[^']*\s[^']*'/.test(text);
}

/**
 * Stage 3 C1: deterministic conversation-context hint for the intent
 * cascade. When at least 2 of the last 3 history entries are dialogue,
 * the actor most likely speaks next — the static cascade misclassified
 * 9/10 turns of a dialogue-heavy office scene as interact/object, so the
 * state now says the quiet part out loud. Pure and unit-tested; the live
 * Laya model still makes the final call.
 */
export function conversationHint(world: World): string {
  const recent = world.history.slice(-3);
  if (recent.length < 2) return "";
  const spoken = recent.filter((e) => historyEntryHasSpeech(e.text)).length;
  return spoken >= 2
    ? "Conversation context: the last few events are dialogue — the actor most likely speaks next unless they need an object or need to move."
    : "";
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
 * PLAN_V2 Phase 1: the physical facts for the intent call — who stands
 * where, who holds what, what is within reach. Positions are first-class
 * because the intent model must ground its single action in the real
 * scene (no invented people, objects, or positions). Reachability uses
 * the engine's own radii (contact for actors, manipulation reach for
 * objects), so "within reach" here means the same thing downstream.
 * Pure and budgeted — unit-tested.
 */
export function buildPhysicalFacts(world: World, actorId: string): string {
  const actor = findActor(world, actorId);
  if (!actor) throw new Error(`buildPhysicalFacts: unknown actor "${actorId}"`);
  const selfLine =
    `You are ${actor.name} at (${actor.x}, ${actor.y}), pose ${actor.pose || "stand"}` +
    `${actor.prop ? `, holding ${actor.prop}` : ""}.`;
  const others = world.actors
    .filter((a) => a.id !== actorId)
    .map((a) => {
      const d = Math.hypot(actor.x - a.x, actor.y - a.y);
      const reach = d <= CONTACT_RADIUS ? ", within reach" : "";
      return `- ${a.name} at (${a.x}, ${a.y}), ${d.toFixed(1)} cells away${a.prop ? `, holding ${a.prop}` : ""}${reach}`;
    })
    .join("\n");
  const nearby = world.scene.objects
    .map((o) => {
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      return { o, d: Math.hypot(actor.x - cx, actor.y - cy) };
    })
    .filter(({ d }) => d <= OBJECT_INTERACT_RADIUS)
    .sort((a, b) => a.d - b.d)
    .slice(0, 8)
    .map(
      ({ o, d }) =>
        `- ${o.name} at (${o.x}, ${o.y}), ${d.toFixed(1)} cells away (within reach)`,
    )
    .join("\n");
  return assemble([
    selfLine,
    others ? truncateToChars(`Others:\n${others}`, 500) : "",
    nearby ? truncateToChars(`Objects within reach:\n${nearby}`, 400) : "",
  ]);
}

