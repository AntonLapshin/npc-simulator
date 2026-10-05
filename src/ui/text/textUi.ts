// Playable terminal interface (Milestone 3, §17).
//
// Run:  npm run start:text -- [scenario] [--mock] [--debug] [--help]
//   scenario defaults to scenarios/office.json.
//   --mock forces deterministic mock engines (no network, no API key).
//   Without --mock the real LLM engines are used; if provider setup fails
//   (e.g. missing JOINGONKA_API_KEY) the UI falls back to mocks with a
//   warning so the simulation stays playable.
//
// The UI never mutates world state directly: every turn goes through
// runTurn() and user input is forwarded as free-form action text.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action, Actor, World } from "../../types.js";
import { loadScenario } from "../../engine/scenarioLoader.js";
import { getCurrentActor } from "../../engine/worldStore.js";
import { loadWorld, saveWorld, defaultSavePath } from "../../engine/persistence.js";
import { getActorById } from "../../engine/perceptionHelpers.js";
import { runTurn, type EngineDependencies } from "../../engine/turnOrchestrator.js";
import { resolveConfig } from "../../config.js";
import { Logger } from "../../logging/logger.js";
import { MockProposalEngine } from "../../mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../../mocks/mockSelectionEngine.js";
import { MockConsequenceEngine } from "../../mocks/mockConsequenceEngine.js";
import { createLlmEngines } from "../../llm/index.js";
import {
  parseCommand,
  HELP_TEXT,
  renderScenePanel,
  renderActorPanel,
  renderObjectPanel,
  renderSuggestions,
  renderHistory,
  formatLogEntry,
} from "./commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const DEFAULT_SCENARIO = join(ROOT, "scenarios/office.json");

export type TextUiOptions = {
  scenarioPath?: string;
  useMock?: boolean;
  debug?: boolean;
  autosave?: boolean;
};

export class TextSession {
  world: World | null = null;
  readonly logger: Logger;
  deps: EngineDependencies;
  debug: boolean;
  usingMock: boolean;
  lastSuggestions: string[] = [];
  lastNarrative = "";
  lastAction: Action | null = null;

  constructor(logger: Logger, deps: EngineDependencies, debug = false, usingMock = false) {
    this.logger = logger;
    this.deps = deps;
    this.debug = debug;
    this.usingMock = usingMock;
  }

  currentActor(): Actor {
    if (!this.world) throw new Error("No scenario loaded. Use: start [path]");
    return getCurrentActor(this.world);
  }

  viewerId(): string {
    return this.world?.userActorId ?? "";
  }

  showScene(): string {
    if (!this.world) return "No scenario loaded. Use: start [path]";
    return renderScenePanel(this.world, { viewerId: this.viewerId(), debug: this.debug });
  }

  showActor(idOrEmpty: string | undefined): string {
    if (!this.world) return "No scenario loaded. Use: start [path]";
    const id = idOrEmpty ?? this.world.userActorId;
    const actor = getActorById(this.world, id);
    return actor ? renderActorPanel(actor) : `Unknown actor: ${id} (actors: ${this.world.actors.map((a) => a.id).join(", ")})`;
  }

  showObject(id: string): string {
    if (!this.world) return "No scenario loaded. Use: start [path]";
    const obj = this.world.scene.objects.find((o) => o.id === id);
    return obj ? renderObjectPanel(obj) : `Unknown object: ${id}`;
  }
}

function buildDeps(logger: Logger, useMock: boolean, autosave: boolean): { deps: EngineDependencies; usingMock: boolean } {
  const config = resolveConfig({ autosaveEnabled: autosave });
  if (useMock) {
    return {
      usingMock: true,
      deps: {
        proposalEngine: new MockProposalEngine(logger),
        selectionEngine: new MockSelectionEngine(logger),
        consequenceEngine: new MockConsequenceEngine(logger),
        logger,
        config,
      },
    };
  }
  try {
    const engines = createLlmEngines(logger, { env: process.env });
    return { usingMock: false, deps: { ...engines, logger, config } };
  } catch (err) {
    console.log(
      `LLM setup failed (${err instanceof Error ? err.message : String(err)}). Falling back to mock engines. Use --mock to silence this.`,
    );
    return {
      usingMock: true,
      deps: {
        proposalEngine: new MockProposalEngine(logger),
        selectionEngine: new MockSelectionEngine(logger),
        consequenceEngine: new MockConsequenceEngine(logger),
        logger,
        config,
      },
    };
  }
}

async function loadScenarioFile(path: string, session: TextSession): Promise<string> {
  const raw = JSON.parse(await readFile(path, "utf-8"));
  const world = loadScenario(raw, session.logger);
  session.world = world;
  session.lastSuggestions = [];
  session.lastNarrative = world.narrative;
  session.lastAction = null;
  return [`Loaded scenario: ${world.title} (you play ${world.userActorId}).`, session.showScene()].join("\n");
}

async function runSingleTurn(
  session: TextSession,
  ask: (query: string) => Promise<string>,
  forcedActionText?: string,
): Promise<string> {
  if (!session.world) return "No scenario loaded. Use: start [path]";
  const actor = getCurrentActor(session.world);
  const isUser = actor.id === session.world.userActorId;
  const out: string[] = [];

  // Agentic-style loading indicator: runTurn awaits several sequential
  // LLM calls (proposal → selection → consequence, each up to 60s), so the
  // terminal would otherwise freeze with no feedback. The orchestrator
  // reports each stage via onProgress; we echo the stage immediately and
  // keep a "Thinking… (Ns)" heartbeat so the user sees what is happening.
  // The heartbeat pauses while the user is typing, so the input line is
  // never garbled.
  const previousProgress = session.deps.onProgress;
  let currentStage = "starting…";
  const startedAt = Date.now();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const startHeartbeat = () => {
    if (heartbeat !== undefined) return;
    heartbeat = setInterval(() => {
      frame++;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      output.write(`\r${frames[frame % frames.length]} Thinking… ${currentStage} (${elapsed}s)   `);
    }, 500);
  };
  const pauseHeartbeat = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    output.write("\n");
  };
  const stopIndicator = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    session.deps.onProgress = previousProgress;
  };
  session.deps.onProgress = (event) => {
    currentStage = event.message;
    console.log(`  ${frames[frame % frames.length]} ${event.message}`);
    try {
      previousProgress?.(event);
    } catch {
      // Ignore progress-hook errors.
    }
  };

  session.deps.getUserAction = async (_actorId, suggestions) => {
    session.lastSuggestions = [...suggestions];
    if (forcedActionText !== undefined) return forcedActionText;
    // Pause the spinner while the user types; resume for the slow
    // consequence call that follows the submitted action.
    pauseHeartbeat();
    // Print directly so suggestions appear before the input prompt.
    console.log(renderSuggestions(suggestions));
    for (;;) {
      const answer = (await ask("action (number, 'action: <text>', or free text): ")).trim();
      if (!answer) {
        console.log("Empty action — please enter what you do or say.");
        continue;
      }
      const asNumber = Number(answer);
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= suggestions.length) {
        startHeartbeat();
        return suggestions[asNumber - 1]!;
      }
      const parsed = parseCommand(answer);
      if (parsed.kind === "action") {
        startHeartbeat();
        return parsed.text;
      }
      // Any other text is accepted verbatim as the free-form action.
      startHeartbeat();
      return answer.startsWith("action:") ? answer.slice("action:".length).trim() || answer : answer;
    }
  };

  const beforeTick = session.world.tick;
  console.log(`Thinking… (${actor.name} · tick ${beforeTick})`);
  startHeartbeat();

  try {
    session.world = await runTurn(session.world, session.deps);
  } catch (err) {
    stopIndicator();
    output.write("\n");
    return `Turn failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  stopIndicator();
  output.write("\n");
  const entries = session.logger.store.all();
  const lastPatch = entries.filter((e) => e.tick === beforeTick && e.event === "patch_applied").at(-1);
  const historyTail = session.world.history.slice(-2);
  session.lastNarrative = historyTail.at(-1) ?? "";
  session.lastAction = { actorId: actor.id, text: historyTail.at(-2) ?? "" };

  out.push(
    isUser
      ? `--- Tick ${beforeTick} — you (${actor.name}) acted ---`
      : `--- Tick ${beforeTick} — ${actor.name} (${actor.id}) acted ---`,
    ...historyTail.map((h) => `  ${h}`),
  );
  void lastPatch;
  const validationFailures = entries.filter((e) => e.tick === beforeTick && e.event === "validation_failed");
  if (session.debug && validationFailures.length > 0) {
    out.push("Validation failures (debug):");
    for (const v of validationFailures) out.push(`  ${formatLogEntry(v, true)}`);
  }
  out.push(session.showScene());
  return out.join("\n");
}

function showLogs(session: TextSession, filter: { module?: string; tick?: number }, limit = 10): string {
  let entries = session.logger.store.all();
  if (filter.module) entries = entries.filter((e) => e.module === filter.module);
  if (filter.tick !== undefined) entries = entries.filter((e) => e.tick === filter.tick);
  const tail = entries.slice(-limit);
  if (tail.length === 0) return "(no log entries)";
  return tail.map((e) => formatLogEntry(e, session.debug)).join("\n");
}

export async function handleLine(
  line: string,
  session: TextSession,
  ask: (query: string) => Promise<string>,
): Promise<{ output: string; quit: boolean }> {
  const parsed = parseCommand(line);
  if (parsed.kind === "error") return { output: parsed.message, quit: false };

  switch (parsed.kind) {
    case "help":
      return { output: HELP_TEXT, quit: false };
    case "quit":
      return { output: "Goodbye.", quit: true };
    case "debug":
      session.debug = parsed.on;
      return { output: `Debug mode ${parsed.on ? "ON (objective world + LLM traces)" : "OFF (subjective view)"}.`, quit: false };
    case "start": {
      const path = parsed.path ?? DEFAULT_SCENARIO;
      try {
        return { output: await loadScenarioFile(path, session), quit: false };
      } catch (err) {
        return { output: `Failed to load scenario '${path}': ${err instanceof Error ? err.message : String(err)}`, quit: false };
      }
    }
    case "next":
      return { output: await runSingleTurn(session, ask), quit: false };
    case "action": {
      if (!session.world) return { output: "No scenario loaded. Use: start [path]", quit: false };
      if (getCurrentActor(session.world).id !== session.world.userActorId) {
        return { output: `Not your turn — current actor is ${getCurrentActor(session.world).id}. Use 'next' to advance NPC turns.`, quit: false };
      }
      return { output: await runSingleTurn(session, ask, parsed.text), quit: false };
    }
    case "look":
      return { output: session.showScene(), quit: false };
    case "lookActor":
      return { output: session.showActor(parsed.actorId), quit: false };
    case "lookObject":
      return { output: session.showObject(parsed.objectId), quit: false };
    case "thoughts": {
      if (!session.world) return { output: "No scenario loaded. Use: start [path]", quit: false };
      const actor = getActorById(session.world, parsed.actorId ?? session.world.userActorId);
      if (!actor) return { output: `Unknown actor: ${parsed.actorId}`, quit: false };
      return { output: `${actor.name} (${actor.id}) thoughts:\n  ${actor.thoughts || "(none)"}`, quit: false };
    }
    case "memories":
    case "beliefs":
    case "relationships": {
      if (!session.world) return { output: "No scenario loaded. Use: start [path]", quit: false };
      const actor = getActorById(session.world, parsed.actorId ?? session.world.userActorId);
      if (!actor) return { output: `Unknown actor: ${parsed.actorId}`, quit: false };
      const list = parsed.kind === "memories" ? actor.memories : parsed.kind === "beliefs" ? actor.beliefs : actor.relationships;
      return {
        output: `${actor.name} (${actor.id}) ${parsed.kind}:\n${list.length > 0 ? list.map((m) => `  - ${m}`).join("\n") : "  (none)"}`,
        quit: false,
      };
    }
    case "history": {
      if (!session.world) return { output: "No scenario loaded. Use: start [path]", quit: false };
      return { output: renderHistory(session.world, parsed.limit ?? 10), quit: false };
    }
    case "save": {
      if (!session.world) return { output: "No scenario loaded. Use: start [path]", quit: false };
      const path = parsed.path ?? defaultSavePath(resolveConfig().saveDir, session.world.id, session.world.tick);
      try {
        await saveWorld(path, session.world, session.logger);
        return { output: `Saved to ${path}.`, quit: false };
      } catch (err) {
        return { output: `Save failed: ${err instanceof Error ? err.message : String(err)}`, quit: false };
      }
    }
    case "load": {
      try {
        session.world = await loadWorld(parsed.path, session.logger);
        return { output: [`Loaded save: ${parsed.path}.`, session.showScene()].join("\n"), quit: false };
      } catch (err) {
        return { output: `Load failed: ${err instanceof Error ? err.message : String(err)}`, quit: false };
      }
    }
    case "logTail":
      return { output: showLogs(session, {}, parsed.limit ?? 10), quit: false };
    case "logModule":
      return { output: showLogs(session, { module: parsed.module }, parsed.limit ?? 10), quit: false };
    case "logTick":
      return { output: showLogs(session, { tick: parsed.tick }, parsed.limit ?? 20), quit: false };
  }
}

function parseArgv(argv: string[]): TextUiOptions & { help: boolean } {
  const opts: TextUiOptions & { help: boolean } = { help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mock") opts.useMock = true;
    else if (a === "--debug") opts.debug = true;
    else if (a === "--no-autosave") opts.autosave = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("--")) positional.push(a);
  }
  if (positional[0]) opts.scenarioPath = positional[0];
  return opts;
}

async function main(): Promise<void> {
  // Load .env (if present) without overriding real env vars (mirrors diagnose-ai).
  // Skipped under Vitest so tests stay hermetic.
  if (process.env["VITEST"] === undefined) {
    const { readFileSync } = await import("node:fs");
    const file = join(ROOT, ".env");
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
        if (!key || process.env[key] !== undefined) continue;
        let value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
    }
  }

  const opts = parseArgv(process.argv.slice(2));
  if (opts.help) {
    console.log(["Usage: npm run start:text -- [scenario] [--mock] [--debug] [--no-autosave]", "", HELP_TEXT].join("\n"));
    return;
  }

  const logger = new Logger({
    sessionId: `text_${Date.now().toString(36)}`,
    logDir: resolveConfig().logDir,
    writeToFile: true,
  });
  const { deps, usingMock } = buildDeps(logger, opts.useMock ?? false, opts.autosave ?? true);
  const session = new TextSession(logger, deps, opts.debug ?? false, usingMock);

  console.log("NPC Simulator — text interface (Milestone 3). Type 'help' for commands.");
  console.log(usingMock ? "Engines: MOCK (deterministic, offline)." : "Engines: REAL LLM (see .env for backend).");

  const scenarioPath = opts.scenarioPath ?? DEFAULT_SCENARIO;
  try {
    console.log(await loadScenarioFile(scenarioPath, session));
  } catch (err) {
    console.log(`Could not load '${scenarioPath}': ${err instanceof Error ? err.message : String(err)}`);
    console.log("Use: start <path> to load a scenario.");
  }

  // Event-based line reader (no rl.question / async-iterator mixing):
  // top-level commands and in-turn action prompts share one sequential
  // reader, so interactive terminals and piped stdin both work.
  const rl = createInterface({ input });
  const queued: string[] = [];
  const pending: Array<(v: string | null) => void> = [];
  let closed = false;
  rl.on("line", (line: string) => {
    const resolve = pending.shift();
    if (resolve) resolve(line);
    else queued.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const resolve of pending.splice(0)) resolve(null);
  });
  const readLine = async (promptText: string): Promise<string | null> => {
    output.write(promptText);
    if (queued.length > 0) return queued.shift()!;
    if (closed) return null;
    return new Promise<string | null>((resolve) => pending.push(resolve));
  };
  const ask = async (query: string): Promise<string> => {
    const line = await readLine(query);
    if (line === null) throw new Error("input closed");
    return line;
  };
  try {
    for (;;) {
      const line = await readLine("> ");
      if (line === null) break; // EOF (piped stdin exhausted, Ctrl-D).
      const { output: text, quit } = await handleLine(line, session, ask);
      console.log(text);
      if (quit) break;
    }
  } catch (err) {
    if (!(err instanceof Error && err.message === "input closed")) throw err;
  }
  rl.close();
  await logger.flush();
}

const isMain = process.argv[1] !== undefined && /textUi(\.ts|\.js)$/.test(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(`text UI crashed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
