// Text UI command parsing + pure panel renderers (Milestone 3, §17).
//
// The presentation layer never mutates world state directly — it only
// formats world/log data for display and forwards action text to the
// engine (see textUi.ts). Everything in this file is pure and unit
// tested: no readline, no filesystem, no LLM calls.

import type { Actor, SceneObject, World } from "../../types.js";
import type { LogEntry } from "../../logging/logTypes.js";
import {
  getVisibleActors,
  getVisibleObjects,
  getActorById,
} from "../../engine/perceptionHelpers.js";

export type Command =
  | { kind: "start"; path?: string }
  | { kind: "next" }
  | { kind: "look" }
  | { kind: "lookActor"; actorId: string }
  | { kind: "lookObject"; objectId: string }
  | { kind: "thoughts"; actorId?: string }
  | { kind: "memories"; actorId?: string }
  | { kind: "beliefs"; actorId?: string }
  | { kind: "relationships"; actorId?: string }
  | { kind: "history"; limit?: number }
  | { kind: "save"; path?: string }
  | { kind: "load"; path: string }
  | { kind: "logTail"; limit?: number }
  | { kind: "logModule"; module: string; limit?: number }
  | { kind: "logTick"; tick: number; limit?: number }
  | { kind: "debug"; on: boolean }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "action"; text: string };

export type ParseError = { kind: "error"; message: string };

function numArg(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const n = Number(token);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Parse one raw input line into a Command.
 * Command words are case-insensitive; ids/paths keep their case.
 * Free-form actions use the `action:` prefix (colon optional):
 *   action: Walk to Ana and ask where your desk is.
 * No content filtering is applied — any text is accepted.
 */
export function parseCommand(line: string): Command | ParseError {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { kind: "error", message: "Empty input. Type 'help' for commands." };
  }

  // Free-form action input (checked first so "action ..." is never a command).
  const actionMatch = /^action\s*:?\s*(.*)$/is.exec(trimmed);
  if (actionMatch && /^action\b/i.test(trimmed)) {
    const text = (actionMatch[1] ?? "").trim();
    if (!text) return { kind: "error", message: "Empty action. Usage: action: <what you do or say>" };
    return { kind: "action", text };
  }

  const parts = trimmed.split(/\s+/);
  const head = parts[0]!.toLowerCase();
  const rest = parts.slice(1);

  switch (head) {
    case "start":
      return { kind: "start", path: rest[0] };
    case "next":
    case "n":
      return rest.length === 0
        ? { kind: "next" }
        : { kind: "error", message: "Usage: next" };
    case "look": {
      if (rest.length === 0) return { kind: "look" };
      if (rest[0]!.toLowerCase() === "actor" && rest[1]) {
        return { kind: "lookActor", actorId: rest[1]! };
      }
      if (rest[0]!.toLowerCase() === "object" && rest[1]) {
        return { kind: "lookObject", objectId: rest[1]! };
      }
      return { kind: "error", message: "Usage: look | look actor <id> | look object <id>" };
    }
    case "thoughts":
      return { kind: "thoughts", actorId: rest[0] };
    case "memories":
      return { kind: "memories", actorId: rest[0] };
    case "beliefs":
      return { kind: "beliefs", actorId: rest[0] };
    case "relationships":
      return { kind: "relationships", actorId: rest[0] };
    case "history": {
      if (rest.length === 0) return { kind: "history" };
      const limit = numArg(rest[0]);
      return limit === undefined
        ? { kind: "error", message: "Usage: history [n]" }
        : { kind: "history", limit };
    }
    case "save":
      return { kind: "save", path: rest[0] };
    case "load":
      return rest[0]
        ? { kind: "load", path: rest[0]! }
        : { kind: "error", message: "Usage: load <path>" };
    case "log": {
      const sub = (rest[0] ?? "").toLowerCase();
      if (sub === "tail") {
        if (rest.length === 1) return { kind: "logTail" };
        const limit = numArg(rest[1]);
        return limit === undefined
          ? { kind: "error", message: "Usage: log tail [n]" }
          : { kind: "logTail", limit };
      }
      if (sub === "module" && rest[1]) {
        const limit = rest[2] === undefined ? undefined : numArg(rest[2]);
        if (rest[2] !== undefined && limit === undefined) {
          return { kind: "error", message: "Usage: log module <module> [n]" };
        }
        return { kind: "logModule", module: rest[1]!, limit };
      }
      if (sub === "tick" && rest[1] !== undefined) {
        const tick = numArg(rest[1]);
        if (tick === undefined) return { kind: "error", message: "Usage: log tick <tick> [n]" };
        const limit = rest[2] === undefined ? undefined : numArg(rest[2]);
        if (rest[2] !== undefined && limit === undefined) {
          return { kind: "error", message: "Usage: log tick <tick> [n]" };
        }
        return { kind: "logTick", tick, limit };
      }
      return { kind: "error", message: "Usage: log tail [n] | log module <module> [n] | log tick <tick> [n]" };
    }
    case "debug": {
      const v = (rest[0] ?? "").toLowerCase();
      if (v === "on") return { kind: "debug", on: true };
      if (v === "off") return { kind: "debug", on: false };
      return { kind: "error", message: "Usage: debug on|off" };
    }
    case "help":
    case "h":
    case "?":
      return { kind: "help" };
    case "quit":
    case "exit":
    case "q":
      return { kind: "quit" };
    default:
      return {
        kind: "error",
        message: `Unknown command '${parts[0]}'. Type 'help' for commands. To act, use: action: <what you do or say>`,
      };
  }
}

export const HELP_TEXT = [
  "Commands:",
  "  start [path]              Load a scenario JSON (default: scenarios/office.json).",
  "  next                      Advance one turn (on an NPC turn, auto-runs NPCs until your turn).",
  "  action: <text>            Act on your turn — NPCs then respond automatically until your next turn.",
  "  look                      Scene panel (title, tick, current actor, narrative, nearby).",
  "  look actor <id>           Actor panel (state, emotion, goal, memories, beliefs, relations).",
  "  look object <id>          Object panel (description, rectangle, flags).",
  "  thoughts [actor]          Show one-time thoughts (default: your actor).",
  "  memories [actor]          Show memories (default: your actor).",
  "  beliefs [actor]           Show beliefs (default: your actor).",
  "  relationships [actor]     Show relationships (default: your actor).",
  "  history [n]               Show world history (default: last 10).",
  "  save [path]               Save world JSON (default: saves/<id>_tick<tick>.json).",
  "  load <path>               Load a saved world JSON.",
  "  log tail [n]              Show recent log entries (default: last 10).",
  "  log module <module> [n]   Filter logs by module (turn, proposal, selection, ...).",
  "  log tick <tick> [n]       Filter logs by tick.",
  "  debug on|off              Debug view: full world + LLM prompts/responses/reasoning.",
  "  help                      Show this help.",
  "  quit                      Exit.",
  "",
  "Tip: on your turn, type a number shown in [brackets] to use a suggestion,",
  "or type any free-form text (optionally prefixed with 'action:').",
].join("\n");

// --- Panels ----------------------------------------------------------------

function bullet(items: string[]): string {
  return items.length > 0 ? items.map((m) => `  - ${m}`).join("\n") : "  (none)";
}

function currentActorId(world: World): string {
  return world.order[world.turnIndex % world.order.length] ?? "(none)";
}

/**
 * Scene panel (§17.1). Default view shows only what the user actor
 * perceives (visible actors/objects); debug view shows the objective
 * world (every actor and object with coordinates).
 */
export function renderScenePanel(
  world: World,
  options: { viewerId?: string; debug?: boolean } = {},
): string {
  const debug = options.debug ?? false;
  const viewerId = options.viewerId ?? world.userActorId;
  const viewer = getActorById(world, viewerId);
  const current = currentActorId(world);

  let perception: string;
  if (debug) {
    perception = [
      `Actors (${world.actors.length}): ${world.actors.map((a) => `${a.name} (${a.id}) at (${a.x}, ${a.y}): ${a.state} [${a.emotion}]`).join(" | ")}`,
      `Objects (${world.scene.objects.length}): ${world.scene.objects.map((o) => `${o.name} (${o.id}) at (${o.x}, ${o.y}, ${o.w}x${o.h})`).join(" | ")}`,
    ].join("\n");
  } else if (viewer) {
    const actors = getVisibleActors(world, viewer.id);
    const objects = getVisibleObjects(world, viewer.id);
    perception = [
      `Nearby actors: ${actors.length > 0 ? actors.map((a) => `${a.name} (${a.id}) at (${a.x}, ${a.y}): ${a.state}`).join(" | ") : "(none)"}`,
      `Nearby objects: ${objects.length > 0 ? objects.map((o) => `${o.name} (${o.id}): ${o.description}`).join(" | ") : "(none)"}`,
    ].join("\n");
  } else {
    perception = "(viewer unknown)";
  }

  const historyTail = world.history.slice(-2);
  return [
    `=== ${world.title} ===`,
    `Tick ${world.tick} | turn ${world.turnIndex} | current actor: ${current}${current === world.userActorId ? " (you)" : ""}`,
    `Narrative: ${world.narrative}`,
    perception,
    historyTail.length > 0 ? `Latest:\n${historyTail.map((h) => `  ${h}`).join("\n")}` : "",
    debug ? "(debug view: objective world)" : `(subjective view: what ${viewer?.name ?? viewerId} perceives)`,
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

/** Actor panel (§17.1). */
export function renderActorPanel(actor: Actor): string {
  return [
    `--- ${actor.name} (${actor.id}) at (${actor.x}, ${actor.y}) ---`,
    `State: ${actor.state}`,
    `Emotion: ${actor.emotion}`,
    `Goal: ${actor.goal}`,
    `Thoughts: ${actor.thoughts || "(none)"}`,
    `Persona: ${actor.persona}`,
    "Memories:",
    bullet(actor.memories),
    "Beliefs:",
    bullet(actor.beliefs),
    "Relationships:",
    bullet(actor.relationships),
  ].join("\n");
}

/** Object panel. */
export function renderObjectPanel(obj: SceneObject): string {
  return [
    `--- ${obj.name} (${obj.id}) ---`,
    `Description: ${obj.description}`,
    `Rect: (${obj.x}, ${obj.y}, ${obj.w}x${obj.h})`,
    `passable=${obj.passable} blocksVision=${obj.blocksVision} blocksSound=${obj.blocksSound}`,
  ].join("\n");
}

/** Action panel (§17.1): numbered suggestions + consequence narrative. */
export function renderSuggestions(suggestions: string[]): string {
  if (suggestions.length === 0) return "No suggestions.";
  return [
    "Suggested actions (type the number, or any free-form text):",
    ...suggestions.map((s, i) => `  [${i + 1}] ${s}`),
  ].join("\n");
}

/** World history (most recent last; limit defaults to 10). */
export function renderHistory(world: World, limit = 10): string {
  const entries = world.history.slice(-limit);
  if (entries.length === 0) return "(no history yet)";
  return entries.map((h) => `  ${h}`).join("\n");
}

/** One log entry as a single line. Debug adds reasoning/errors/prompt info. */
export function formatLogEntry(entry: LogEntry, debug = false): string {
  const head = `tick=${entry.tick} ${entry.module}/${entry.event}${entry.actorId ? ` actor=${entry.actorId}` : ""}`;
  if (!debug) {
    const extra = entry.error ? ` error=${truncate(entry.error, 160)}` : "";
    return `${head}${extra}`;
  }
  const parts = [head];
  if (entry.reasoning) parts.push(`reasoning=${truncate(entry.reasoning, 200)}`);
  if (entry.validationErrors?.length) parts.push(`validationErrors=[${entry.validationErrors.map((e) => truncate(e, 120)).join("; ")}]`);
  if (entry.error) parts.push(`error=${truncate(entry.error, 300)}`);
  if (entry.rawResponse) parts.push(`raw=${truncate(entry.rawResponse, 300)}`);
  if (entry.prompt) parts.push(`prompt=${truncate(entry.prompt, 200)}…`);
  if (entry.durationMs !== undefined) parts.push(`${entry.durationMs}ms`);
  return parts.join(" | ");
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
