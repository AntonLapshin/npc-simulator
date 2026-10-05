// Text UI command parsing + pure panel renderers (Milestone 3, §17).
//
// The presentation layer never mutates world state directly — it only
// formats world/log data for display and forwards action text to the
// engine (see textUi.ts). Everything in this file is pure and unit
// tested: no readline, no filesystem, no LLM calls.

import type { Actor, SceneObject, World } from "../../types.js";
import type { LogEntry } from "../../logging/logTypes.js";
import { actorColorCode, paint, paintError } from "../../logging/colors.js";

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
  | { kind: "story"; tick?: number; limit?: number }
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
    case "story": {
      if (rest.length === 0) return { kind: "story" };
      if (rest.length === 1) {
        const n = numArg(rest[0]);
        return n === undefined
          ? { kind: "error", message: "Usage: story [tick] [n]" }
          : { kind: "story", tick: n };
      }
      if (rest.length === 2) {
        const tick = numArg(rest[0]);
        const limit = numArg(rest[1]);
        return tick === undefined || limit === undefined
          ? { kind: "error", message: "Usage: story [tick] [n]" }
          : { kind: "story", tick, limit };
      }
      return { kind: "error", message: "Usage: story [tick] [n]" };
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
  "  look                      Scene narrative (opening text only; details via look actor/object).",
  "  look actor <id>           Actor panel (state, emotion, goal, memories, beliefs, relations).",
  "  look object <id>          Object panel (description, rectangle, flags).",
  "  thoughts [actor]          Show one-time thoughts (default: your actor).",
  "  memories [actor]          Show memories (default: your actor).",
  "  beliefs [actor]           Show beliefs (default: your actor).",
  "  relationships [actor]     Show relationships (default: your actor).",
  "  history [n]               Show world history (default: last 10).",
  "  story [tick] [n]          Show concise story trace (module chain) for a tick or last n turns.",
  "  save [path]               Save world JSON (default: saves/<id>_tick<tick>.json).",
  "  load <path>               Load a saved world JSON.",
  "  log tail [n]              Show recent log entries (default: last 10).",
  "  log module <module> [n]   Filter logs by module (turn, proposal, selection, ...).",
  "  log tick <tick> [n]       Filter logs by tick.",
  "  debug on|off              Debug view: concise story trace after each turn (no prompts).",
  "  help                      Show this help.",
  "  quit                      Exit.",
  "",
  "Tip: on your turn, just type what you do or say (optionally prefixed with 'action:').",
  "No suggestions are generated for you — you decide freely.",
].join("\n");

// --- Panels ----------------------------------------------------------------

function bullet(items: string[]): string {
  return items.length > 0 ? items.map((m) => `  - ${m}`).join("\n") : "  (none)";
}

/**
 * Scene panel (§17.1, trimmed per UX request).
 *
 * "Nearby actors/objects" and the "Latest:" history tail were removed:
 * they duplicated per-turn NPC output and added noise. The panel now
 * shows only the opening narrative when `includeNarrative` is true,
 * otherwise an empty string (callers skip empty panels).
 */
export function renderScenePanel(
  world: World,
  _options: { viewerId?: string; debug?: boolean; includeNarrative?: boolean } = {},
): string {
  if (_options.includeNarrative) return `Narrative: ${world.narrative}`;
  return "";
}

/** Strip legacy "Tick N - " prefixes so no ticks are ever displayed. */
function stripTickPrefix(entry: string): string {
  return entry.replace(/^Tick \d+ - /, "");
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
  const entries = world.history.slice(-limit).map(stripTickPrefix);
  if (entries.length === 0) return "(no history yet)";
  return entries.map((h) => `  ${h}`).join("\n");
}

/** One log entry as a single line. Debug adds reasoning/errors/prompt info. */
export function formatLogEntry(entry: LogEntry, debug = false, color = false): string {
  // Whole line carries the acting actor's color (errors stay red) so
  // `log tail/module/tick` output is distinguishable per character.
  const ok = (s: string): string =>
    color && entry.actorId ? paint(s, actorColorCode(entry.actorId)) : s;
  const actorBit = entry.actorId
    ? ` actor=${color ? paint(entry.actorId, actorColorCode(entry.actorId)) : entry.actorId}`
    : "";
  const head = ok(`tick=${entry.tick} ${entry.module}/${entry.event}`) + actorBit;
  const errBit = (s: string): string => (color ? paintError(s) : s);
  if (!debug) {
    const extra = entry.error ? ` error=${truncate(entry.error, 160)}` : "";
    return extra ? `${head}${errBit(extra)}` : head;
  }
  const parts = [head];
  if (entry.reasoning) parts.push(ok(`reasoning=${truncate(entry.reasoning, 200)}`));
  if (entry.validationErrors?.length) parts.push(errBit(`validationErrors=[${entry.validationErrors.map((e) => truncate(e, 120)).join("; ")}]`));
  if (entry.error) parts.push(errBit(`error=${truncate(entry.error, 300)}`));
  if (entry.rawResponse) parts.push(ok(`raw=${truncate(entry.rawResponse, 300)}`));
  if (entry.prompt) parts.push(ok(`prompt=${truncate(entry.prompt, 200)}…`));
  if (entry.durationMs !== undefined) parts.push(ok(`${entry.durationMs}ms`));
  return parts.join(ok(" | "));
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
