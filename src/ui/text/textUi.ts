// Playable terminal interface (Milestone 3, §17).
//
// Run:  npm run start:text -- [scenario] [--provider <backend>] [--model <id>] [--base-url <url>] [--mock] [--debug] [--help]
//   scenario defaults to scenarios/office.json.
//   --provider selects the LLM backend: joingonka (default), laya-local, ollama.
//     Aliases: --backend. Overrides LLM_BACKEND (and .env) for this run.
//   --model overrides the model id for the selected provider
//     (JOINGONKA_MODEL / LAYA_MODEL / OLLAMA_MODEL). Examples:
//       --provider ollama --model fluffy/l3-8b-stheno-v3.2
//       --provider ollama --model huihui_ai/llama3.2-abliterate:3b
//   --base-url overrides the provider endpoint
//     (JOINGONKA_BASE_URL / LAYA_BASE_URL / OLLAMA_BASE_URL).
//   --mock forces deterministic mock engines (no network, no API key).
//   --auto runs autonomous mode: every character is an NPC (no user,
//     no prompts) for --limit-turns turns, then prints a summary, saves
//     and exits. Shorter: npm run start:auto -- [--limit-turns <n>].
//   --limit-turns <n> (requires --auto) caps the autonomous run at n
//     actor-turns; defaults to 30.
//   Without --mock the real LLM engines are used; if provider setup fails
//   (e.g. missing JOINGONKA_API_KEY) the UI falls back to mocks with a
//   warning so the simulation stays playable.
//
// The UI never mutates world state directly: every turn goes through
// runTurn() and user input is forwarded as free-form action text.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action, Actor, World } from "../../types.js";
import { loadScenario } from "../../engine/scenarioLoader.js";
import { getCurrentActor } from "../../engine/worldStore.js";
import { loadWorld, saveWorld, defaultSavePath } from "../../engine/persistence.js";
import { getActorById, getAudibleActors, getVisibleActors } from "../../engine/perceptionHelpers.js";
import { runTurn, type EngineDependencies } from "../../engine/turnOrchestrator.js";
import { resolveConfig } from "../../config.js";
import { Logger } from "../../logging/logger.js";
import { MockProposalEngine } from "../../mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../../mocks/mockSelectionEngine.js";
import { MockConsequenceEngine } from "../../mocks/mockConsequenceEngine.js";
import { createLlmEngines, resolveLlmEnv } from "../../llm/index.js";
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
import { historyEntryText, loggedTicks, renderStoryRange, renderTurnStory } from "../../logging/storyTrace.js";
import { loadEnvFile } from "../../util/loadEnv.js";
import {
  TURN_TABLE_HEADER,
  TURN_TIME_GATE_MS,
  budgetWarningMessage,
  formatDuration,
  formatTurnRow,
  type TurnTelemetry,
} from "../../core/telemetry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const DEFAULT_SCENARIO = join(ROOT, "scenarios/office.json");

/**
 * Exp-7 item A12: filename stem of a scenario path ("office-anton" for
 * scenarios/office-anton.json) — used for save filenames so same-id
 * scenarios don't collide.
 */
export function scenarioStemOf(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return (ext.length > 0 ? base.slice(0, -ext.length) : base) || "scenario";
}

export type TextUiOptions = {
  scenarioPath?: string;
  useMock?: boolean;
  debug?: boolean;
  autosave?: boolean;
  /** LLM backend override (joingonka | laya-local | ollama). */
  provider?: string;
  /** Model id override for the selected provider. */
  model?: string;
  /** Endpoint override for the selected provider. */
  baseUrl?: string;
  /** Autonomous mode: no user, every actor runs as an NPC. */
  auto?: boolean;
  /** Turn cap for autonomous mode (default 30). Requires --auto. */
  limitTurns?: number;
};

/** Default turn cap for autonomous runs (matches the experiment reports). */
export const DEFAULT_AUTO_TURNS = 30;

export class TextSession {
  world: World | null = null;
  readonly logger: Logger;
  deps: EngineDependencies;
  debug: boolean;
  usingMock: boolean;
  lastSuggestions: string[] = [];
  lastNarrative = "";
  lastAction: Action | null = null;
  /** Exp-7 item A12: scenario file stem for save filenames (set on load). */
  scenarioStem: string | null = null;

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

  showScene(includeNarrative = false): string {
    if (!this.world) return "No scenario loaded. Use: start [path]";
    return renderScenePanel(this.world, {
      viewerId: this.viewerId(),
      debug: this.debug,
      includeNarrative,
    });
  }

  showActor(idOrEmpty: string | undefined): string {
    if (!this.world) return "No scenario loaded. Use: start [path]";
    const id = idOrEmpty ?? this.world.userActorId;
    const actor = getActorById(this.world, id);
    if (!actor) return `Unknown actor: ${id} (actors: ${this.world.actors.map((a) => a.id).join(", ")})`;
    // Thoughts are private: only the viewer's own thoughts are shown unless
    // GM debug view is on. Proposal/selection prompts likewise only ever
    // carry the acting actor's own thoughts.
    const includeThoughts = this.debug || id === this.world.userActorId;
    return renderActorPanel(actor, { includeThoughts });
  }

  showObject(id: string): string {
    if (!this.world) return "No scenario loaded. Use: start [path]";
    const obj = this.world.scene.objects.find((o) => o.id === id);
    return obj ? renderObjectPanel(obj) : `Unknown object: ${id}`;
  }
}

/** Apply --provider/--model/--base-url overrides on top of process.env. */
export function resolveRuntimeEnv(opts: Pick<TextUiOptions, "provider" | "model" | "baseUrl">): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const provider = opts.provider?.trim();
  if (provider) env["LLM_BACKEND"] = provider;
  const backend = (env["LLM_BACKEND"] ?? "joingonka").trim();
  if (opts.model?.trim()) {
    if (backend === "ollama") env["OLLAMA_MODEL"] = opts.model.trim();
    else if (backend === "laya-local") env["LAYA_MODEL"] = opts.model.trim();
    else env["JOINGONKA_MODEL"] = opts.model.trim();
  }
  if (opts.baseUrl?.trim()) {
    if (backend === "ollama") env["OLLAMA_BASE_URL"] = opts.baseUrl.trim();
    else if (backend === "laya-local") env["LAYA_BASE_URL"] = opts.baseUrl.trim();
    else env["JOINGONKA_BASE_URL"] = opts.baseUrl.trim();
  }
  return env;
}

function buildDeps(
  logger: Logger,
  useMock: boolean,
  autosave: boolean,
  llmOpts: Pick<TextUiOptions, "provider" | "model" | "baseUrl" | "auto"> = {},
  saveNamePrefix?: string,
): { deps: EngineDependencies; usingMock: boolean; llmLabel?: string } {
  // Exp-7 item A12: the scenario file stem seeds save filenames.
  const config = resolveConfig({ autosaveEnabled: autosave, saveNamePrefix });
  // Autonomous mode: no user turns — every actor runs the NPC pipeline.
  const forceAllNpc = llmOpts.auto === true;
  if (useMock) {
    return {
      usingMock: true,
      deps: {
        proposalEngine: new MockProposalEngine(logger),
        selectionEngine: new MockSelectionEngine(logger),
        consequenceEngine: new MockConsequenceEngine(logger),
        logger,
        config,
        forceAllNpc,
      },
    };
  }
  try {
    const env = resolveRuntimeEnv(llmOpts);
    const engines = createLlmEngines(logger, { env });
    const cfg = resolveLlmEnv(env);
    const hardModel =
      cfg.backend === "ollama" ? cfg.ollama.model : cfg.backend === "laya-local" ? cfg.laya.model : cfg.joingonka.model;
    const simpleModel = cfg.simpleModel ??
      (cfg.simpleBackend === "ollama" ? cfg.ollama.model : cfg.simpleBackend === "laya-local" ? cfg.laya.model : cfg.joingonka.model);
    const hardTasks = (["proposal", "consequence"] as const)
      .map((t) => cfg.taskBackends[t] ?? cfg.backend)
      .every((b) => b === cfg.backend);
    const simpleTasks = (["selection", "semantic"] as const)
      .map((t) => cfg.taskBackends[t] ?? cfg.simpleBackend)
      .every((b) => b === cfg.simpleBackend);
    const llmLabel = hardTasks && simpleTasks
      ? `hard=${cfg.backend}/${hardModel} simple=${cfg.simpleBackend}/${simpleModel}`
      : `proposal=${cfg.taskBackends.proposal ?? cfg.backend} selection=${cfg.taskBackends.selection ?? cfg.simpleBackend} consequence=${cfg.taskBackends.consequence ?? cfg.backend} semantic=${cfg.taskBackends.semantic ?? cfg.simpleBackend}`;
    return { usingMock: false, deps: { ...engines, logger, config, forceAllNpc }, llmLabel };
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
        forceAllNpc,
      },
    };
  }
}

async function loadScenarioFile(path: string, session: TextSession, auto = false): Promise<string> {
  const raw = JSON.parse(await readFile(path, "utf-8"));
  const world = loadScenario(raw, session.logger);
  session.world = world;
  // Exp-7 item A12: the scenario file stem drives save filenames from
  // here on (also refreshes the engine config for autosaves mid-session
  // after `start <other-scenario>`).
  session.scenarioStem = scenarioStemOf(path);
  if (session.deps.config !== undefined) {
    session.deps = {
      ...session.deps,
      config: { ...session.deps.config, saveNamePrefix: session.scenarioStem },
    };
  }
  session.lastSuggestions = [];
  session.lastNarrative = world.narrative;
  session.lastAction = null;
  // Opening narrative is shown exactly once here — subsequent scene panels
  // omit it (see TextSession.showScene).
  const mode = auto ? "autonomous mode: all characters are NPCs, no user" : `you play ${world.userActorId}`;
  return [`Loaded scenario: ${world.title} (${mode}).`, session.showScene(true)].join("\n");
}

/**
 * Exp-7 item A12: save path for manual saves — scenario file stem when
 * known, world.id otherwise.
 */
export function sessionSavePath(session: TextSession, tick: number): string {
  const stem = session.scenarioStem ?? session.world?.id ?? "world";
  return defaultSavePath(resolveConfig().saveDir, stem, tick);
}

/**
 * True when the observer can currently see or hear the target actor.
 * Used to decide whether an NPC turn is shown to the user: imperceptible
 * turns (e.g. someone quietly working across the room) produce no output.
 */
function isPerceivable(world: World, observerId: string, targetId: string): boolean {
  if (observerId === targetId) return true;
  if (getVisibleActors(world, observerId).some((a) => a.id === targetId)) return true;
  if (getAudibleActors(world, observerId).some((a) => a.id === targetId)) return true;
  return false;
}

async function runSingleTurn(
  session: TextSession,
  ask: (query: string) => Promise<string>,
  forcedActionText?: string,
  opts: { includeScene?: boolean; auto?: boolean } = {},
): Promise<string> {
  if (!session.world) return "No scenario loaded. Use: start [path]";
  const actor = getCurrentActor(session.world);
  const isUser = actor.id === session.world.userActorId;
  const includeScene = opts.includeScene ?? true;
  const out: string[] = [];

  // Single-line loading indicator: runTurn awaits sequential LLM calls
  // (NPC: proposal → selection → consequence; user: consequence only,
  // each up to 60s). Exactly one
  // terminal line is used — it always shows the current pending stage and
  // is fully cleared when the turn finishes, so no spinner text hangs
  // around. The indicator pauses while the user is typing.
  const canAnimate = Boolean((output as typeof output & { isTTY?: boolean }).isTTY);
  const previousProgress = session.deps.onProgress;
  let currentStage = "starting…";
  let currentActorLabel = isUser ? `you (${actor.name})` : `${actor.name} (NPC)`;
  const startedAt = Date.now();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const renderLine = () => {
    if (!canAnimate) return;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    output.write(`\r\x1b[K${frames[frame % frames.length]} ${currentActorLabel} — ${currentStage} (${elapsed}s)`);
  };
  const startHeartbeat = () => {
    if (!canAnimate || heartbeat !== undefined) return;
    heartbeat = setInterval(() => {
      frame++;
      renderLine();
    }, 200);
  };
  const clearLine = () => {
    if (canAnimate) output.write("\r\x1b[K");
  };
  const pauseHeartbeat = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    clearLine();
  };
  const stopIndicator = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    // Remove the loading line entirely — nothing hangs after the turn.
    clearLine();
    session.deps.onProgress = previousProgress;
  };
  session.deps.onProgress = (event) => {
    currentStage = event.message;
    renderLine();
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
    // User turns carry no suggestions (proposal is skipped) — prompt for
    // free-form text directly instead of showing a suggestion list.
    const promptText =
      suggestions.length > 0
        ? "action (number, 'action: <text>', or free text): "
        : "action (free text, e.g. action: <what you do or say>): ";
    if (suggestions.length > 0) {
      // Print directly so suggestions appear before the input prompt.
      console.log(renderSuggestions(suggestions));
    }
    for (;;) {
      const answer = (await ask(promptText)).trim();
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
  currentStage = "starting…";
  renderLine();
  startHeartbeat();

  try {
    session.world = await runTurn(session.world, session.deps);
  } catch (err) {
    stopIndicator();
    return `Turn failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  stopIndicator();
  const entries = session.logger.store.all();
  // Single history entry per turn ("Name: narrative", no ticks). The
  // consequence narrative is logged but never echoed — it must describe
  // only the acting actor, and any observer reaction belongs to that
  // observer's own future turn.
  const historyEntry = historyEntryText(session.world.history.at(-1)) ?? "";
  session.lastNarrative = historyEntry;
  session.lastAction = { actorId: actor.id, text: historyEntry };

  // The user's own action needs no echo — they just typed it.
  // NPC turns are shown only when the user can currently perceive that
  // actor (see or hear); imperceptible turns stay silent.
  // In autonomous mode there is no user, so every turn's narrative prints.
  if (opts.auto) {
    out.push(historyEntry);
  } else if (!isUser && session.world) {
    if (isPerceivable(session.world, session.world.userActorId, actor.id)) {
      out.push(historyEntry);
    }
  }
  const validationFailures = entries.filter((e) => e.tick === beforeTick && e.event === "validation_failed");
  if (session.debug && validationFailures.length > 0) {
    out.push("Validation failures (debug):");
    for (const v of validationFailures) out.push(`  ${formatLogEntry(v, true, true)}`);
  }
  if (session.debug && session.world) {
    const roster = session.world.actors.map((a) => ({ id: a.id, name: a.name }));
    out.push(
      renderTurnStory(entries.filter((e) => e.tick === beforeTick), beforeTick, roster, {
        userActorId: session.world.userActorId,
        color: true,
      }),
    );
  }
  if (includeScene) out.push(session.showScene());
  return out.filter((p) => p.trim().length > 0).join("\n");
}

/**
 * Run the user's turn, then automatically run following NPC turns until it
 * is the user's turn again. This removes the need to type `next` for every
 * NPC. Only perceivable NPC actions produce output; the user's own action
 * is not echoed. Only the final scene panel is shown, ending with an
 * explicit "Your turn" prompt.
 */
async function runUserTurnAndNpcs(
  session: TextSession,
  ask: (query: string) => Promise<string>,
  forcedActionText?: string,
): Promise<string> {
  if (!session.world) return "No scenario loaded. Use: start [path]";
  const parts: string[] = [];
  // User turn (scene suppressed — the final scene is rendered once at end).
  parts.push(await runSingleTurn(session, ask, forcedActionText, { includeScene: false }));
  // Auto-advance NPCs (guarded so a misconfigured order can't loop forever).
  const maxNpcTurns = Math.max(0, session.world.order.length - 1);
  for (let i = 0; i < maxNpcTurns; i++) {
    if (!session.world) break;
    const current = getCurrentActor(session.world);
    if (current.id === session.world.userActorId) break;
    parts.push(await runSingleTurn(session, ask, undefined, { includeScene: false }));
  }
  if (session.world) {
    parts.push(session.showScene());
    const me = getActorById(session.world, session.world.userActorId);
    if (getCurrentActor(session.world).id === session.world.userActorId) {
      parts.push(`Your turn (${me?.name ?? session.world.userActorId}) — type your action (e.g. action: <what you do or say>).`);
    }
  }
  return parts.filter((p) => p.trim().length > 0).join("\n");
}

/**
 * Autonomous experiment loop (--auto): run `limit` actor-turns with every
 * character simulated as an NPC (forceAllNpc is set on the deps, so
 * runTurn never prompts for input). Each turn prints its narrative; at the
 * end the final scene is shown and the world is saved. Returns the process
 * exit code.
 */
async function runAutoSession(session: TextSession, limit: number): Promise<number> {
  if (!session.world) {
    console.log("No scenario loaded.");
    return 2;
  }
  console.log(`Autonomous mode: ${session.world.actors.length} characters, all NPCs (no user). Running ${limit} turn(s).`);
  // Safety net: nothing in auto mode should ever prompt — a prompt means
  // a code path forgot about forceAllNpc, and hanging on stdin would be
  // worse than failing loudly.
  const neverAsk = async (_query: string): Promise<string> => {
    throw new Error("auto mode: unexpected input prompt");
  };
  let ran = 0;
  // Exp-7 item A13: per-turn timing + ETA. Autonomous runs cost minutes
  // per turn on local models — print the running average and a remaining
  // estimate so the operator can judge whether to keep waiting.
  let totalTurnMs = 0;
  const fmtDur = (ms: number): string => {
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };
  // Phase 6: per-turn economics table + turn-time gate. The orchestrator
  // fires onTurnTelemetry once per turn; stash the record and print its
  // row with the turn summary below so each turn's output stays grouped.
  console.log(TURN_TABLE_HEADER);
  let pendingTelemetry: TurnTelemetry | undefined;
  const prevTelemetry = session.deps.onTurnTelemetry;
  session.deps.onTurnTelemetry = (t) => {
    pendingTelemetry = t;
    prevTelemetry?.(t);
  };
  for (let i = 0; i < limit; i++) {
    if (!session.world) break;
    const actor = getCurrentActor(session.world);
    const tick = session.world.tick;
    let text: string;
    const turnStart = Date.now();
    try {
      text = await runSingleTurn(session, neverAsk, undefined, { includeScene: false, auto: true });
    } catch (err) {
      console.log(`Turn ${i + 1} crashed (${err instanceof Error ? err.message : String(err)}) — stopping early.`);
      break;
    }
    const turnMs = Date.now() - turnStart;
    totalTurnMs += turnMs;
    ran++;
    const avgMs = totalTurnMs / ran;
    const remaining = limit - ran;
    const eta = remaining > 0 ? ` · ETA ${fmtDur(avgMs * remaining)} for ${remaining} remaining` : "";
    console.log(`── turn ${i + 1}/${limit} · tick ${tick} · ${actor.name} (${actor.id}) · took ${fmtDur(turnMs)} (avg ${fmtDur(avgMs)}/turn${eta}) ──`);
    console.log(text);
    console.log("");
    // Phase 6: economics row + budget warning for this turn.
    if (pendingTelemetry !== undefined) {
      console.log(formatTurnRow(i + 1, pendingTelemetry));
      if (pendingTelemetry.budgetExceeded) {
        console.log(
          `⚠ ${budgetWarningMessage(pendingTelemetry.actorId, pendingTelemetry.providerCalls, pendingTelemetry.budget, pendingTelemetry.calls)}`,
        );
      }
      pendingTelemetry = undefined;
    }
    // Phase 6: turn-time gate — warn at 90 s, never abort.
    if (turnMs > TURN_TIME_GATE_MS) {
      console.log(
        `⚠ turn ${i + 1} took ${formatDuration(turnMs)} — over the ${formatDuration(TURN_TIME_GATE_MS)} turn-time gate`,
      );
    }
    if (text.startsWith("Turn failed:")) {
      console.log("Stopping early: the engine reported a failed turn.");
      break;
    }
  }
  // Phase 6: restore the session's telemetry hook (auto mode only).
  session.deps.onTurnTelemetry = prevTelemetry;
  if (!session.world) {
    console.log("World lost — nothing to save.");
    return 1;
  }
  console.log(session.showScene());
  const savePath = sessionSavePath(session, session.world.tick);
  try {
    await saveWorld(savePath, session.world, session.logger);
    console.log(`\nDone: ran ${ran}/${limit} turn(s), final tick ${session.world.tick}. Saved to ${savePath}.`);
    return ran === limit ? 0 : 1;
  } catch (err) {
    console.log(`\nDone: ran ${ran}/${limit} turn(s), final tick ${session.world.tick}. Save failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function showLogs(session: TextSession, filter: { module?: string; tick?: number }, limit = 10): string {
  let entries = session.logger.store.all();
  if (filter.module) entries = entries.filter((e) => e.module === filter.module);
  if (filter.tick !== undefined) entries = entries.filter((e) => e.tick === filter.tick);
  const tail = entries.slice(-limit);
  if (tail.length === 0) return "(no log entries)";
  return tail.map((e) => formatLogEntry(e, session.debug, session.debug)).join("\n");
}

function showStory(session: TextSession, tick?: number, limit?: number): string {
  if (!session.world) return "No scenario loaded. Use: start [path]";
  const all = session.logger.store.all();
  if (all.length === 0) return "(no turns logged yet)";
  const roster = session.world.actors.map((a) => ({ id: a.id, name: a.name }));
  const opts = { userActorId: session.world.userActorId, color: true };
  if (tick !== undefined && limit === undefined) {
    return renderTurnStory(all.filter((e) => e.tick === tick), tick, roster, opts);
  }
  // Group by action tick: turn_completed is logged with the *next* tick,
  // so plain max-tick would land on a sparse bookkeeping entry. Prefer
  // ticks that actually ran proposal/selection/consequence.
  const meaningful = new Set(
    all
      .filter((e) =>
        (e.module === "proposal" && e.event.startsWith("proposal_")) ||
        (e.module === "selection" && e.event.startsWith("selection_")) ||
        (e.module === "consequence" && e.event.startsWith("consequence_")) ||
        (e.module === "turn" && (e.event === "action_chosen" || e.event === "useractionsubmitted" || e.event === "patch_applied")),
      )
      .map((e) => e.tick),
  );
  const ticks = loggedTicks(all).filter((t) => (meaningful.size === 0 ? true : meaningful.has(t)));
  const selected = tick !== undefined ? ticks.filter((t) => t >= tick).slice(0, limit ?? 1) : ticks.slice(-(limit ?? 1));
  if (selected.length === 0) return `(no log entries for tick ${tick})`;
  return renderStoryRange(all, selected, roster, opts);
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
      return { output: `Debug mode ${parsed.on ? "ON (concise story trace after each turn; use story [tick] to review)" : "OFF"}.`, quit: false };
    case "start": {
      const path = parsed.path ?? DEFAULT_SCENARIO;
      try {
        return { output: await loadScenarioFile(path, session), quit: false };
      } catch (err) {
        return { output: `Failed to load scenario '${path}': ${err instanceof Error ? err.message : String(err)}`, quit: false };
      }
    }
    case "next": {
      if (!session.world) return { output: "No scenario loaded. Use: start [path]", quit: false };
      // On an NPC turn, drain all consecutive NPC turns so one `next`
      // always returns control to the user.
      if (getCurrentActor(session.world).id !== session.world.userActorId) {
        const parts: string[] = [];
        const maxNpcTurns = Math.max(1, session.world.order.length);
        for (let i = 0; i < maxNpcTurns; i++) {
          if (!session.world || getCurrentActor(session.world).id === session.world.userActorId) break;
          parts.push(await runSingleTurn(session, ask, undefined, { includeScene: false }));
        }
        if (session.world) {
          parts.push(session.showScene());
          if (getCurrentActor(session.world).id === session.world.userActorId) {
            const me = getActorById(session.world, session.world.userActorId);
            parts.push(`Your turn (${me?.name ?? session.world.userActorId}) — type your action (e.g. action: <what you do or say>).`);
          }
        }
        return { output: parts.filter((p) => p.trim().length > 0).join("\n"), quit: false };
      }
      return { output: await runSingleTurn(session, ask), quit: false };
    }
    case "action": {
      if (!session.world) return { output: "No scenario loaded. Use: start [path]", quit: false };
      if (getCurrentActor(session.world).id !== session.world.userActorId) {
        return { output: `Not your turn — current actor is ${getCurrentActor(session.world).id}. Use 'next' to auto-advance NPC turns.`, quit: false };
      }
      // User act → NPCs respond automatically, then control returns to you.
      return { output: await runUserTurnAndNpcs(session, ask, parsed.text), quit: false };
    }
    case "look": {
      const panel = session.showScene();
      return {
        output: panel || "(scene view trimmed — use history, look actor <id>, look object <id>, or story)",
        quit: false,
      };
    }
    case "lookActor":
      return { output: session.showActor(parsed.actorId), quit: false };
    case "lookObject":
      return { output: session.showObject(parsed.objectId), quit: false };
    case "thoughts": {
      if (!session.world) return { output: "No scenario loaded. Use: start [path]", quit: false };
      const targetId = parsed.actorId ?? session.world.userActorId;
      const actor = getActorById(session.world, targetId);
      if (!actor) return { output: `Unknown actor: ${parsed.actorId}`, quit: false };
      // Thoughts are private to the acting character (they only enter that
      // character's own proposal/selection prompt). Other actors' thoughts
      // are GM-only: require `debug on`.
      if (targetId !== session.world.userActorId && !session.debug) {
        return { output: `${actor.name} (${actor.id}) thoughts are private (enable \`debug on\` for GM view).`, quit: false };
      }
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
    case "story": {
      return { output: showStory(session, parsed.tick, parsed.limit), quit: false };
    }
    case "save": {
      if (!session.world) return { output: "No scenario loaded. Use: start [path]", quit: false };
      const path = parsed.path ?? sessionSavePath(session, session.world.tick);
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

export function parseArgv(argv: string[]): TextUiOptions & { help: boolean } {
  const opts: TextUiOptions & { help: boolean } = { help: false };
  const positional: string[] = [];
  const takeValue = (i: number, flag: string): string | undefined => {
    const eq = flag.indexOf("=");
    if (eq !== -1) return flag.slice(eq + 1).trim() || undefined;
    return argv[i + 1]?.trim() || undefined;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mock") opts.useMock = true;
    else if (a === "--debug") opts.debug = true;
    else if (a === "--no-autosave") opts.autosave = false;
    else if (a === "--auto") opts.auto = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--limit-turns" || a.startsWith("--limit-turns=")) {
      const v = takeValue(i, a);
      const n = Number(v);
      if (v === undefined || !Number.isInteger(n) || n <= 0) {
        throw new Error("--limit-turns needs a positive integer (number of turns to run)");
      }
      opts.limitTurns = n;
      if (!a.includes("=")) i++;
    } else if (a === "--provider" || a === "--backend" || a.startsWith("--provider=") || a.startsWith("--backend=")) {
      const v = takeValue(i, a);
      if (!v) throw new Error(`${a.split("=")[0]} needs a value: joingonka | laya-local | ollama`);
      opts.provider = v;
      if (!a.includes("=")) i++;
    } else if (a === "--model" || a.startsWith("--model=")) {
      const v = takeValue(i, a);
      if (!v) throw new Error("--model needs a value (model id)");
      opts.model = v;
      if (!a.includes("=")) i++;
    } else if (a === "--base-url" || a === "--baseUrl" || a.startsWith("--base-url=") || a.startsWith("--baseUrl=")) {
      const v = takeValue(i, a);
      if (!v) throw new Error("--base-url needs a value (endpoint URL)");
      opts.baseUrl = v;
      if (!a.includes("=")) i++;
    } else if (!a.startsWith("--")) positional.push(a);
  }
  if (positional[0]) opts.scenarioPath = positional[0];
  if (opts.limitTurns !== undefined && !opts.auto) {
    throw new Error("--limit-turns requires --auto");
  }
  return opts;
}

async function main(): Promise<void> {
  // Load .env (if present) without overriding real env vars.
  // Skipped under Vitest so tests stay hermetic.
  if (process.env["VITEST"] === undefined) {
    loadEnvFile(ROOT);
  }

  let opts: TextUiOptions & { help: boolean };
  try {
    opts = parseArgv(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    console.log(["Usage: npm run start:text -- [scenario] [--provider <backend>] [--model <id>] [--base-url <url>] [--mock] [--debug] [--no-autosave] [--auto] [--limit-turns <n>]", "", HELP_TEXT].join("\n"));
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(["Usage: npm run start:text -- [scenario] [--provider <backend>] [--model <id>] [--base-url <url>] [--mock] [--debug] [--no-autosave] [--auto] [--limit-turns <n>]", "  backends: joingonka | laya-local | ollama", "  --auto runs every character as an NPC for --limit-turns turns (default 30), then saves and exits", "", HELP_TEXT].join("\n"));
    return;
  }

  const logger = new Logger({
    sessionId: `text_${Date.now().toString(36)}`,
    logDir: resolveConfig().logDir,
    writeToFile: true,
  });
  // Exp-7 item A12: seed save filenames with the scenario file stem.
  const { deps, usingMock, llmLabel } = buildDeps(
    logger,
    opts.useMock ?? false,
    opts.autosave ?? true,
    opts,
    scenarioStemOf(opts.scenarioPath ?? DEFAULT_SCENARIO),
  );
  const session = new TextSession(logger, deps, opts.debug ?? false, usingMock);

  console.log(
    opts.auto === true
      ? "NPC Simulator — autonomous mode (no user, all characters are NPCs)."
      : "NPC Simulator — text interface (Milestone 3). Type 'help' for commands.",
  );
  console.log(usingMock ? "Engines: MOCK (deterministic, offline)." : `Engines: REAL LLM (${llmLabel ?? "see .env for backend"}).`);

  const scenarioPath = opts.scenarioPath ?? DEFAULT_SCENARIO;
  try {
    console.log(await loadScenarioFile(scenarioPath, session, opts.auto === true));
  } catch (err) {
    console.log(`Could not load '${scenarioPath}': ${err instanceof Error ? err.message : String(err)}`);
    console.log("Use: start <path> to load a scenario.");
  }

  // Autonomous experiment mode: no prompts, no REPL — run the turn loop to
  // the limit, save, and exit.
  if (opts.auto === true) {
    process.exitCode = await runAutoSession(session, opts.limitTurns ?? DEFAULT_AUTO_TURNS);
    await logger.flush();
    return;
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
