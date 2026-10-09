import type {
  Action,
  ConsequenceResult,
  EngineConfig,
  ProposalResult,
  World,
} from "../types.js";
import type { Intent } from "../decision/decisionTypes.js";
import type { ChatComplete } from "../decision/questionPlanner.js";
import { defaultConfig, isLayaIntentFirst } from "../config.js";
import {
  layaWiringFromEnv,
  runIntentCascade,
  runRenderabilityScore,
  type LayaTurnWiring,
} from "./layaTurn.js";
import { checkLocomotionVeto } from "../decision/layaLocomotion.js";
import type {
  ConsequenceEngine,
  ProposalEngine,
  SelectionEngine,
  SelectionEngineWithIntent,
} from "../intelligence/types.js";
import { applyRenderResult, type ExecutedTurn } from "./patchApplier.js";
import { renderRetryFeedback, validateRenderProse, type RenderFacts } from "./validate/render.js";
import {
  executeMovement,
  planMovementSemantics,
  type MovementOutcome,
} from "./movementExecutor.js";
import { planSpeech } from "./speechExecutor.js";
import {
  executeManipulation,
  type ManipulationOutcome,
} from "./manipulationExecutor.js";
import { planPose } from "../core/text.js";
import { quoteContained, reinsertQuote } from "../core/speech.js";
import {
  budgetWarningMessage,
  DEFAULT_TURN_CALL_BUDGET,
  evaluateBudget,
  type TurnOutcome,
  type TurnTelemetry,
} from "../core/telemetry.js";
import { ProviderCallCounter } from "./turnTelemetry.js";
import { suggestionClusterNouns, suggestionCore, validateSelectionForActor } from "./contextBuilder.js";
import { collapseDoubledPrefix } from "./validate/narrative.js";
import { FALLBACK_SELECTION } from "../llm/llmSelectionEngine.js";
import { type TurnEngines } from "../llm/index.js";
import { getCurrentActor } from "./worldStore.js";
import { defaultSavePath, saveWorld } from "./persistence.js";
import {
  getHonestHistoryNote,
  isFallbackConsequence,
} from "./turnSalvage.js";
import { buildLivenessConsequence, consecutiveClusterFailures, consecutiveFallbacks, consecutiveIntentFailures } from "./turnLiveness.js";
import type { Logger } from "../logging/logger.js";
import type { LlmUsage } from "../logging/logTypes.js";
import { errorMessage } from "../util/errors.js";

export type TurnProgressStage =
  | "turn_started"
  | "proposal_started"
  | "proposal_done"
  | "waiting_user_input"
  | "selection_started"
  | "selection_done"
  | "consequence_started"
  | "consequence_retry"
  | "validation_started"
  | "validation_done"
  | "patch_applied"
  | "turn_completed";

export type TurnProgressEvent = {
  stage: TurnProgressStage;
  actorId: string;
  /** Human-readable one-liner for loading indicators (e.g. "consequence engine…"). */
  message: string;
};

export type EngineDependencies = {
  proposalEngine: ProposalEngine;
  selectionEngine: SelectionEngine;
  consequenceEngine: ConsequenceEngine;
  logger: Logger;
  config?: EngineConfig;
  /** Resolve free-form user action text (UI layer). Required for user turns. */
  getUserAction?: (actorId: string, suggestions: string[]) => Promise<string>;
  /**
   * Autonomous mode: treat every actor as an NPC — including the actor
   * named by world.userActorId. When true, runTurn never takes the user
   * path (no proposal/selection skip, no getUserAction call) and every
   * turn gets the NPC engine routing and the liveness floor. Lets a UI
   * run a fully autonomous, user-free experiment (see text UI --auto).
   */
  forceAllNpc?: boolean;
  /** Optional save hook (defaults to file persistence when autosave is on). */
  onAutosave?: (world: World) => Promise<void> | void;
  /** Optional progress hook for UIs to show a loading indicator during slow LLM calls. */
  onProgress?: (event: TurnProgressEvent) => void;
  /**
   * Item C2: per-turn engine routing from createLlmEngines — user turns
   * get the capable tier (hard-tier proposal+consequence). Carried
   * through the `{...engines}` spread in the UIs; mock/test deps omit it.
   */
  getEnginesForTurn?: (isUserTurn: boolean) => TurnEngines;
  /**
   * Phase 3–4 (LAYA_PLAN.md): Laya decision-layer wiring for this turn.
   * runTurn resolves it from env when absent (off by default); tests inject
   * a stub client here. Carries the LayaClient plus the flag snapshot.
   */
  laya?: LayaTurnWiring;
  /**
   * Phase 4: chat completion hook for the dynamic question planner, wired
   * by createLlmEngines when the Laya layer is on (undefined otherwise).
   */
  plannerChatComplete?: ChatComplete;
  /**
   * Phase 6: per-turn economics telemetry hook. Called once per turn with
   * the timing/call breakdown (the --auto UI uses it for the running
   * table). Optional — unset in tests and non-UI callers.
   */
  onTurnTelemetry?: (telemetry: TurnTelemetry) => void;
};

/**
 * Phase 3 (intent-first): proposal engines that accept a decided intent.
 * LLMProposalEngine.propose takes an optional third parameter; the base
 * ProposalEngine interface declares two, so narrow at the call site.
 */
type ProposalEngineWithIntent = ProposalEngine & {
  propose(world: World, actorId: string, intent?: Intent): Promise<ProposalResult>;
};

function report(deps: EngineDependencies, event: TurnProgressEvent): void {
  try {
    deps.onProgress?.(event);
  } catch {
    // Progress reporting must never break the turn.
  }
}

/**
 * Canonical "Nothing changes." fallback. Single source of truth lives in
 * the LLM consequence engine; re-exported here so turn-level code and
 * tests keep one import path.
 */
import { FALLBACK_CONSEQUENCE } from "../llm/llmConsequenceEngine.js";
export { FALLBACK_CONSEQUENCE };

// Compatibility re-exports: these live in focused modules now.
export {
  getHonestHistoryNote,
  isFallbackConsequence,
} from "./turnSalvage.js";
export { consecutiveFallbacks } from "./turnLiveness.js";
export { summarizeTurnOutcomes } from "./turnOutcomes.js";
export type { TurnOutcomeSummary } from "./turnOutcomes.js";


function depsConfig(deps: EngineDependencies): EngineConfig {
  return deps.config ?? defaultConfig;
}

/**
 * F31: per-turn LLM usage totals — `LlmUsage` from src/logging/logTypes.ts
 * (Worker-B contract: { promptTokens, completionTokens, totalTokens }).
 */

/**
 * F31: accumulate per-turn LLM usage totals from the log store. The
 * engines log per-call `usage` on their log entries; this sums every
 * entry recorded for this (tick, turnIndex).
 */
export function accumulateTurnUsage(
  logger: Logger,
  tick: number,
  turnIndex: number,
): LlmUsage {
  const total: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const entry of logger.store.all()) {
    if (entry.tick !== tick || entry.turnIndex !== turnIndex) continue;
    const usage = entry.usage;
    if (!usage) continue;
    total.promptTokens += usage.promptTokens ?? 0;
    total.completionTokens += usage.completionTokens ?? 0;
    total.totalTokens +=
      usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  }
  return total;
}

/**
 * LLMs sometimes echo the candidate list numbering ("3. Call out ...",
 * "2) Nod ...") into the chosen action. That prefix is presentation, not
 * part of the action — strip it so it never reaches consequences,
 * validation, or history.
 */
export function stripSelectionPrefix(text: string): string {
  return text.replace(/^\s*\d+\s*[.)]\s*/, "").trimStart();
}






/**
 * Exp-6 item 3 / F28: race work against the turn's remaining time budget.
 * The work receives an AbortController signal; on timeout the controller
 * aborts (so a hung LLM provider call is actually cancelled instead of
 * burning tokens in the background) and the turn falls through to salvage
 * instead of burning more wall time. The late result, if any, is ignored.
 */
function withTurnDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  if (!(ms > 0)) return work(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("turn deadline exceeded"));
      reject(new Error("turn deadline exceeded"));
    }, ms);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Exp-6 item 4: optional diagnostics a ConsequenceEngine may expose so the
 * turn can tell a format collapse (nothing ever parsed) apart from a
 * parsed-but-invalid result. LLMConsequenceEngine implements these;
 * mock/other engines simply don't, and the tier stays dormant.
 */
export type ConsequenceEngineDiagnostics = {
  getLastRawAttempts(): string[];
  lastResolveParsed(): boolean;
};

function readEngineDiagnostics(
  engine: ConsequenceEngine,
): { rawAttempts: string[]; parsed: boolean } | undefined {
  const e = engine as Partial<ConsequenceEngineDiagnostics>;
  if (
    typeof e.getLastRawAttempts === "function" &&
    typeof e.lastResolveParsed === "function"
  ) {
    try {
      return { rawAttempts: e.getLastRawAttempts(), parsed: e.lastResolveParsed() };
    } catch {
      return undefined;
    }
  }
  return undefined;
}


/** Phase 4: max render attempts per turn (1 clean + 1 prose retry). */
export const RENDER_MAX_ATTEMPTS = 2;

/**
 * Phase 4: resolve one turn as execute → render.
 *
 * The engine executes the turn's movement, exact quote, manipulation, and
 * pose deterministically (Phases 1–3 + the pose plan) BEFORE the render
 * call; the render engine narrates the executed facts as prose. The render
 * result gets prose-only validation (max 2 attempts); deterministic
 * repairs (quote backstop, doubled-prefix collapse) run before validation
 * and burn no LLM call. When rendering fails: the NPC liveness floor
 * (after N consecutive own fallbacks), else the "Nothing changes."
 * fallback.
 */
export async function resolveRender(
  world: World,
  action: Action,
  deps: EngineDependencies,
  opts: { allowLiveness?: boolean; intent?: Intent; callCounter?: ProviderCallCounter } = {},
): Promise<{
  render: ConsequenceResult;
  executed: ExecutedTurn;
  liveness: boolean;
  /** Phase 6: deterministic engine-execution ms vs pure render-call ms. */
  timings: { executeMs: number; renderMs: number };
}> {
  const config = depsConfig(deps);
  const logger = deps.logger;
  const actor = world.actors.find((a) => a.id === action.actorId);
  const actorName = actor?.name ?? action.actorId;
  let feedback: string | undefined;

  // Exp-6 item 3: total wall-time budget for the render phase. When the
  // deadline hits, the turn stops burning LLM calls and falls through to
  // liveness → fallback.
  const turnTimeoutMs = config.turnTimeoutMs ?? 600_000;
  const deadlineAt = Date.now() + turnTimeoutMs;
  const timeLeft = (): number => deadlineAt - Date.now();
  let deadlineExceeded = false;

  // ---- Execute (engine, Phases 1–3 + pose). Deterministic pre-pass from
  // the action text alone: the engine — never the model — decides
  // movement, the exact quote, manipulation, and pose. Computed once per
  // turn, before the first render call, so the render input carries the
  // executed facts to narrate.
  //
  // Phase 5: a fully-typed cascade intent (kind + resolved targetId from
  // the Laya proposal engine) is authoritative — it generated the action
  // text, so the executors use its fields instead of re-parsing the text
  // (no translation layer). On the LLM/chat path the intent is undefined
  // and the text parsers run as before.
  // Phase 6: the deterministic pre-pass is timed separately from the
  // render calls — engine execution is microseconds, provider calls are
  // the cost.
  const executeStart = Date.now();
  let plannedMovement = planMovementSemantics(world, action, opts.intent);
  // Exp-2-E item (b): Laya locomotion supplement (LAYA_LOCOMOTION=1, off
  // by default). Laya only ever VETOES a planned move — when it is
  // confident the action needs no relocation. Laya failure or low
  // confidence keeps the deterministic verdict.
  if (plannedMovement.moves && deps.laya?.config.toggles.locomotion === true) {
    const veto = (await checkLocomotionVeto(deps.laya.client, action.text)) === true;
    logger.log({
      module: "laya",
      event: veto ? "locomotion_veto" : "locomotion_confirmed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { actionText: action.text, deterministicMoves: true },
      output: { veto },
    });
    if (veto) plannedMovement = { moves: false };
  }
  const engineMovement = plannedMovement.moves
    ? executeMovement(world, action, plannedMovement)
    : null;
  if (plannedMovement.moves) {
    logger.log({
      module: "movement",
      event: "movement_planned",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, plannedMovement },
      output: { engineMovement },
    });
  }
  const exactQuote = planSpeech(action, opts.intent);
  if (exactQuote !== null) {
    logger.log({
      module: "speech",
      event: "speech_planned",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action },
      output: { exactQuote },
    });
  }
  // Phase 5: manipulation stays text-parsed — the Laya proposal engine's
  // candidate templates are written as inverses of planManipulation's
  // verb ontology, so the template → parse round-trip recovers the
  // intent's target deterministically (covered by round-trip tests).
  const engineManipulation = executeManipulation(world, action);
  if (engineManipulation !== null) {
    logger.log({
      module: "objects",
      event: "manipulation_planned",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action },
      output: { engineManipulation },
    });
  }
  const enginePose = planPose(action.text);
  const executeMs = Date.now() - executeStart;

  const executed: ExecutedTurn = {
    movement: engineMovement,
    pose: enginePose,
    manipulation: engineManipulation,
  };
  const emptyExecuted: ExecutedTurn = { movement: null, pose: null, manipulation: null };

  // Facts the render prose is validated against.
  const renderFacts = (): RenderFacts => {
    const fromX = actor?.x ?? 0;
    const fromY = actor?.y ?? 0;
    const toX = engineMovement?.x ?? fromX;
    const toY = engineMovement?.y ?? fromY;
    return {
      exactQuote,
      moved: toX !== fromX || toY !== fromY,
      pose: enginePose,
      effectivePose: enginePose ?? actor?.pose ?? "stand",
      x: toX,
      y: toY,
      engineManipulation,
    };
  };

  // ---- Render (LLM): prose in, prose out. Max 2 attempts — the second
  // only for prose issues (the deterministic repairs below burn none).
  // Phase 6: pure render-call ms accumulate here (attempts included —
  // every resolve() is a provider call on a provider-backed engine).
  let renderCallMs = 0;
  for (let attempt = 1; attempt <= RENDER_MAX_ATTEMPTS; attempt++) {
    if (timeLeft() <= 0) {
      deadlineExceeded = true;
      break;
    }
    let render: ConsequenceResult;
    try {
      // F28: the deadline signal is forwarded to the render engine (which
      // passes it to the provider call) so a hung LLM request is
      // cancelled on timeout.
      // Exp-6 item 2: flag user turns so the engine leads with the
      // user-turn directive (the player's words are ground truth).
      // Phase 6: count the invocation when the engine is provider-backed.
      opts.callCounter?.note("render", deps.consequenceEngine);
      const callStart = Date.now();
      try {
        render = await withTurnDeadline(
          (signal) =>
            deps.consequenceEngine.resolve(world, action, feedback, {
              signal,
              isUserTurn: !deps.forceAllNpc && action.actorId === world.userActorId,
              engineMovement,
              exactQuote,
              engineManipulation,
            }),
          timeLeft(),
        );
      } finally {
        // A throwing call still burned provider time — count it.
        renderCallMs += Date.now() - callStart;
      }
    } catch (err) {
      if (timeLeft() <= 0 || errorMessage(err) === "turn deadline exceeded") {
        deadlineExceeded = true;
        break;
      }
      logger.log({
        module: "consequence",
        event: "consequence_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, attempt },
        error: errorMessage(err),
      });
      feedback = `Previous attempt raised an error: ${errorMessage(err)}`;
      if (attempt >= RENDER_MAX_ATTEMPTS) break;
      report(deps, {
        stage: "consequence_retry",
        actorId: action.actorId,
        message: `render failed — retrying (attempt ${attempt + 1})…`,
      });
      continue;
    }

    report(deps, {
      stage: "validation_started",
      actorId: action.actorId,
      message: `validating render (attempt ${attempt})…`,
    });
    // Phase 2: deterministic quote backstop — the render output must
    // carry the exact quote verbatim; any deviation is repaired via the
    // pure core transform before validation, burning no LLM retry.
    if (exactQuote !== null && !quoteContained(exactQuote, render.narrative)) {
      const before = render.narrative;
      render = { ...render, narrative: reinsertQuote(render.narrative, actorName, exactQuote) };
      logger.log({
        module: "speech",
        event: "render_quote_reinserted",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, before },
        output: { after: render.narrative },
        error:
          "render narrative failed to carry the engine-dictated exact quote verbatim — reinserted deterministically",
      });
    }
    // Exp-4 item 6 (S4): deterministic doubled-prefix repair — "Dana:
    // Dana: …" collapses to "Dana: …" instead of tripping the voice gate.
    {
      const collapsed = collapseDoubledPrefix(render.narrative, actorName);
      if (collapsed !== render.narrative) {
        logger.log({
          module: "validator",
          event: "narrative_prefix_collapsed",
          tick: world.tick,
          turnIndex: world.turnIndex,
          actorId: action.actorId,
          input: { narrative: render.narrative },
          output: { narrative: collapsed },
        });
        render = { ...render, narrative: collapsed };
      }
    }

    const errors = validateRenderProse(world, action, render, renderFacts());
    if (errors.length === 0) {
      logger.log({
        module: "validator",
        event: "render_accepted",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, render, attempt },
      });
      return { render, executed, liveness: false, timings: { executeMs, renderMs: renderCallMs } };
    }

    logger.log({
      module: "validator",
      event: "render_failed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, render, attempt },
      validationErrors: errors.map((e) => `[${e.code}] ${e.message}`),
    });
    if (attempt >= RENDER_MAX_ATTEMPTS) break;
    feedback = renderRetryFeedback(errors, world.actors.map((a) => a.id));
    report(deps, {
      stage: "consequence_retry",
      actorId: action.actorId,
      message: `render prose rejected — retrying (attempt ${attempt + 1})…`,
    });
    logger.log({
      module: "turn",
      event: "retry_started",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, attempt: attempt + 1 },
      output: { feedback },
      validationErrors: errors.map((e) => `[${e.code}] ${e.message}`),
    });
  }

  if (deadlineExceeded) {
    logger.log({
      module: "turn",
      event: "turn_deadline_exceeded",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action },
      output: { turnTimeoutMs },
      error: `render phase exceeded its ${turnTimeoutMs}ms wall-time budget — falling through to liveness/fallback`,
    });
  }

  // Exp-5 item 6: NPC liveness floor. Before giving up to "Nothing
  // changes.", check whether this actor has already fallen back N
  // consecutive own turns — if so, apply a minimal in-place reaction so
  // the scene keeps moving by dialogue even when the render cannot. User
  // turns are excluded by the caller: silently rewriting the user's own
  // action would hide the failure from them.
  if (opts.allowLiveness !== false) {
    const threshold = depsConfig(deps).livenessFallbackThreshold ?? 3;
    const priorFallbacks = consecutiveFallbacks(world, action.actorId);
    if (priorFallbacks >= threshold) {
      const liveness = buildLivenessConsequence(world, action, priorFallbacks);
      logger.log({
        module: "turn",
        event: "liveness_applied",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, priorFallbacks },
        output: { liveness },
      });
      return { render: liveness, executed: emptyExecuted, liveness: true, timings: { executeMs, renderMs: renderCallMs } };
    }
  }

  logger.log({
    module: "turn",
    event: "fallback_used",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    input: { action, feedback },
    output: FALLBACK_CONSEQUENCE,
    error: "render attempts exhausted",
  });
  // F23: mark the engine-produced fallback so isFallbackConsequence checks
  // the flag first (narrative equality stays as backward compat).
  const fallbackResult = structuredClone(FALLBACK_CONSEQUENCE);
  fallbackResult.fallback = true;
  return { render: fallbackResult, executed: emptyExecuted, liveness: false, timings: { executeMs, renderMs: renderCallMs } };
}

async function autosave(world: World, deps: EngineDependencies): Promise<void> {
  const config = depsConfig(deps);
  if (!config.autosaveEnabled) return;
  try {
    if (deps.onAutosave) {
      await deps.onAutosave(world);
    } else {
      // Exp-7 item A12: prefer the scenario file stem over world.id so
      // same-id scenarios (office.json vs office-anton.json) don't collide.
      await saveWorld(defaultSavePath(config.saveDir, config.saveNamePrefix ?? world.id, world.tick), world, deps.logger);
    }
  } catch (err) {
    deps.logger.log({
      module: "turn",
      event: "error_occurred",
      tick: world.tick,
      turnIndex: world.turnIndex,
      error: `autosave failed: ${errorMessage(err)}`,
    });
  }
}

/**
 * Run a single immediate turn for the current actor and return the next world.
 * User actors: no proposal/selection — the user decides freely via
 * getUserAction (called with no suggestions). NPC actors: propose + select.
 * Every stage is logged.
 */
export async function runTurn(world: World, deps: EngineDependencies): Promise<World> {
  const config = depsConfig(deps);
  const logger = deps.logger;
  const actor = getCurrentActor(world);

  // Phase 6: per-turn provider-call counter + stage timings. Telemetry
  // only — the counter never aborts or alters the turn.
  const callCounter = new ProviderCallCounter();
  let proposalMs = 0;
  let selectionStart = 0;
  let selectionBlockMs = 0;

  // Item C2: per-turn engine routing — user turns run proposal+consequence
  // on the capable (hard) tier when the engines provide it; NPC turns keep
  // the standard engines. Falls back to `deps` when no routing is wired
  // (mock/test deps).
  // Phase 3–4: the Laya turn wiring resolves here — injected by tests via
  // deps.laya, otherwise from env (off by default, so plain chat runs are
  // untouched). plannerChatComplete comes from createLlmEngines when the
  // Laya layer is on.
  const turnEngines = deps.getEnginesForTurn?.(!deps.forceAllNpc && actor.id === world.userActorId);
  const plannerChatComplete = turnEngines?.plannerChatComplete ?? deps.plannerChatComplete;
  const layaWiring = layaWiringFromEnv({ injected: deps.laya, plannerChatComplete });
  const engineOverrides =
    turnEngines !== undefined
      ? {
          proposalEngine: turnEngines.proposal,
          selectionEngine: turnEngines.selection,
          consequenceEngine: turnEngines.consequence,
        }
      : {};
  const turnDeps: EngineDependencies = {
    ...deps,
    ...engineOverrides,
    plannerChatComplete,
    laya: layaWiring,
  };

  // F18: exactly one deep clone per turn, taken here at turn start. The
  // snapshot doubles as the turn_started log input AND as the mutation
  // base passed to applyRenderResult below (which no longer clones when it
  // receives one). Aliasing note: the in-memory log-store entry for
  // turn_started references the same object that applyRenderResult then
  // mutates — the JSONL file write is unaffected (the logger stringifies
  // synchronously at log time), but in-memory readers see the applied
  // state. This is the accepted trade-off of the single-clone budget.
  const turnSnapshot = structuredClone(world);
  logger.log({
    module: "turn",
    event: "turn_started",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: actor.id,
    input: { world: turnSnapshot },
  });

  report(turnDeps, { stage: "turn_started", actorId: actor.id, message: `turn started — ${actor.id} (tick ${world.tick})` });
  report(turnDeps, { stage: "proposal_started", actorId: actor.id, message: `proposal engine — generating suggestions for ${actor.id}…` });

  let action: Action;
  // Phase 5: the turn's decided intent (intent-first cascade and/or the
  // Laya proposal engine's fully-typed intent). Threads to selection and
  // the executors; undefined on user turns and the pure chat path.
  let decidedIntent: Intent | undefined;
  // Autonomous mode (forceAllNpc): the "user" actor is simulated like any
  // other NPC — proposal + selection + consequence, never getUserAction.
  const isUserTurn = !turnDeps.forceAllNpc && actor.id === world.userActorId;
  if (isUserTurn) {
    // User turns: no proposal, no selection. The user decides how to act
    // without suggestions — skip both engines entirely so no
    // proposal/selection LLM calls (or logs) happen for the user.
    logger.log({
      module: "proposal",
      event: "proposal_skipped",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: actor.id,
      input: { actorId: actor.id, reason: "user turn: user acts freely, no suggestions generated" },
    });
    report(turnDeps, { stage: "proposal_done", actorId: actor.id, message: `proposal skipped (user turn)` });
    report(turnDeps, { stage: "waiting_user_input", actorId: actor.id, message: "waiting for your action…" });
    if (!turnDeps.getUserAction) {
      throw new Error("getUserAction is required for user-controlled turns");
    }
    const userText = await turnDeps.getUserAction(actor.id, []);
    if (!userText || userText.trim().length === 0) {
      logger.log({
        module: "turn",
        event: "error_occurred",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: actor.id,
        input: { suggestions: [] },
        error: "empty user action text",
      });
      throw new Error("empty user action text: request action again");
    }
    action = { actorId: actor.id, text: userText };
    logger.log({
      module: "turn",
      event: "useractionsubmitted",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: actor.id,
      input: { suggestions: [] },
      output: action,
    });
  } else {
    // Phase 3 (intent-first, behind flags, default OFF): when the Laya
    // layer is on with selection routing, run the intent cascade first and
    // narrow the proposal prompt to the decided intent. Any cascade failure
    // yields undefined and the proposal runs un-narrowed (fail open).
    let intent: Intent | undefined;
    if (turnDeps.laya !== undefined && isLayaIntentFirst(turnDeps.laya.config)) {
      intent = await runIntentCascade(turnDeps.laya.client, world, actor.id, {
        mode: turnDeps.laya.config.mode,
        plannerEnabled: turnDeps.laya.config.toggles.planner,
        goal: `decide ${actor.name}'s next intent`,
        chatComplete: turnDeps.laya.plannerChatComplete,
      }, logger);
    }
    // Phase 6: count + time the proposal invocation when provider-backed.
    const proposalStart = Date.now();
    callCounter.note("proposal", turnDeps.proposalEngine);
    const proposal = await (turnDeps.proposalEngine as ProposalEngineWithIntent).propose(world, actor.id, intent);
    proposalMs = Date.now() - proposalStart;
    report(turnDeps, { stage: "proposal_done", actorId: actor.id, message: `proposal engine done (${proposal.suggestions.length} suggestions)` });
    report(turnDeps, { stage: "selection_started", actorId: actor.id, message: `selection engine — ${actor.id} is deciding…` });
    // Phase 5: the Laya proposal engine returns its fully-typed intent
    // (kind + resolved targetId); it threads to selection (skips the
    // redundant intent cascade) and to the executors (authoritative —
    // it generated the action text). On the LLM path proposal.intent is
    // undefined and the intent-first intent (if any) is advisory only.
    decidedIntent = proposal.intent ?? intent;
    // Phase 6: count + time the selection invocation(s) when
    // provider-backed. The selectionExecuteMs bucket covers selection,
    // screening, and the renderability re-pick below.
    selectionStart = Date.now();
    callCounter.note("selection", turnDeps.selectionEngine);
    const selection = await (turnDeps.selectionEngine as SelectionEngineWithIntent).select(
      world,
      actor.id,
      proposal.suggestions,
      decidedIntent,
    );
    report(turnDeps, { stage: "selection_done", actorId: actor.id, message: `selection engine done — action chosen` });
    let actionText = stripSelectionPrefix(selection.action);
    // Exp-5 items 5+7: screen the pick BEFORE burning consequence attempts
    // on it. A POV-swapped pick ("Anton walks…" on Dana's turn) or a
    // verb+noun repeat of a recent own action (handshake attractor) is
    // rejected here and replaced with the first clean candidate — the
    // proposal engine already dedups its own output, but the selector may
    // invent a repeat (or a mock may replay one).
    //
    // Exp-3 item 6 (S2): per-intent failure memory — an intent whose
    // verb|noun key failed `intentFailureBanThreshold` consecutive own
    // turns is banned the same way. Small models demonstrably ignore
    // prompt lines ("do NOT repeat yourself"); the deterministic ban is
    // the load-bearing half. The ban is per-actor and resets on the first
    // applied own turn (consecutiveIntentFailures breaks the streak).
    const banThreshold = config.intentFailureBanThreshold ?? 2;
    const isIntentBanned = (text: string): boolean => {
      const key = suggestionCore(world, text, actor.id);
      return consecutiveIntentFailures(world, actor.id, key) >= banThreshold;
    };
    // Exp-5 item 9 (S8): intent-cluster bans — a near-variant of a
    // repeatedly failed intent (same concrete object-kind nouns, different
    // verb|noun key) is banned the same way, so the substitute can't dodge
    // on a rewording (exp-5 ticks 13/19/22: laptop-setup offer banned, then
    // the glance-at-test-plan variant failed too).
    const isClusterBanned = (text: string): boolean => {
      const nouns = suggestionClusterNouns(text);
      return consecutiveClusterFailures(world, actor.id, nouns) >= banThreshold;
    };
    const rejection = validateSelectionForActor(world, actor.id, actionText);
    const bannedKey = isIntentBanned(actionText)
      ? suggestionCore(world, actionText, actor.id)
      : undefined;
    const bannedCluster =
      bannedKey === undefined && isClusterBanned(actionText)
        ? suggestionClusterNouns(actionText)
        : undefined;
    if (rejection !== undefined || bannedKey !== undefined || bannedCluster !== undefined) {
      logger.log({
        module: "selection",
        event:
          bannedKey !== undefined
            ? "intent_banned"
            : bannedCluster !== undefined
              ? "intent_cluster_banned"
              : "selection_rejected",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: actor.id,
        input: { action: actionText, suggestions: proposal.suggestions },
        output: {
          rejection:
            rejection ??
            (bannedKey !== undefined
              ? `intent "${bannedKey}" failed ${banThreshold} consecutive own turns — banned from selection`
              : `intent cluster {${bannedCluster!.join(", ")}} failed ${banThreshold} consecutive own turns — banned from selection`),
        },
        error: rejection,
      });
      const clean = proposal.suggestions
        .map((s) => stripSelectionPrefix(s))
        .find(
          (s) =>
            s.length > 0 &&
            validateSelectionForActor(world, actor.id, s) === undefined &&
            !isIntentBanned(s) &&
            !isClusterBanned(s),
        );
      actionText = clean ?? FALLBACK_SELECTION.action;
      logger.log({
        module: "selection",
        event: "selection_substituted",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: actor.id,
        input: { rejected: selection.action },
        output: { action: actionText },
      });
    }
    action = { actorId: actor.id, text: actionText };

    // Exp-3 item 6 (S2): Laya renderability screen — one 1–5 score on the
    // FINAL action text (after screen/substitution), before burning
    // consequence attempts on it. Score ≤2 drops the action from the
    // candidate list and re-runs selection ONCE with the filtered list;
    // the second pick stands regardless of its score (one re-pick, no
    // loops). Fail-open throughout: Laya failure/undefined proceeds.
    // OFF by default (LAYA_RENDERABILITY=1 to enable).
    if (turnDeps.laya !== undefined && turnDeps.laya.config.toggles.renderability === true) {
      const score = await runRenderabilityScore(
        turnDeps.laya.client,
        world,
        actor.id,
        actionText,
      );
      const rescored = score !== undefined && score <= 2;
      logger.log({
        module: "laya",
        event: "renderability_scored",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: actor.id,
        input: { action: actionText },
        output: { score: score ?? null, rescored },
      });
      if (rescored) {
        const filtered = proposal.suggestions.filter(
          (s) => stripSelectionPrefix(s) !== actionText,
        );
        if (filtered.length > 0) {
          // Phase 6: the re-pick is a second selection provider call.
          callCounter.note("selection", turnDeps.selectionEngine);
          const repick = await (turnDeps.selectionEngine as SelectionEngineWithIntent).select(
            world,
            actor.id,
            filtered,
            decidedIntent,
          );
          const repickText = stripSelectionPrefix(repick.action);
          const repickRejection = validateSelectionForActor(world, actor.id, repickText);
          actionText =
            repickRejection === undefined && !isIntentBanned(repickText) && !isClusterBanned(repickText)
              ? repickText
              : FALLBACK_SELECTION.action;
          action = { actorId: actor.id, text: actionText };
          logger.log({
            module: "selection",
            event: "selection_substituted",
            tick: world.tick,
            turnIndex: world.turnIndex,
            actorId: actor.id,
            input: { rejected: selection.action, renderabilityScore: score },
            output: { action: actionText },
          });
        } else {
          actionText = FALLBACK_SELECTION.action;
          action = { actorId: actor.id, text: actionText };
        }
      }
    }
  }
  // Phase 6: close the selection bucket (selection + screening +
  // renderability re-pick, if any).
  selectionBlockMs = Date.now() - selectionStart;

  logger.log({
    module: "turn",
    event: "action_chosen",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    output: action,
  });

  report(turnDeps, { stage: "consequence_started", actorId: action.actorId, message: `render engine — resolving "${action.text.slice(0, 60)}${action.text.length > 60 ? "…" : ""}"…` });
  // Phase 4: turn = proposal → selection → execute (engine) → render
  // (LLM). The engine already executed movement/quote/manipulation/pose;
  // the render call narrates the executed facts as prose.
  const { render, executed, liveness, timings } = await resolveRender(world, action, turnDeps, {
    // Exp-5 item 6: the liveness floor rewrites failed turns — never the
    // user's own action text. In autonomous mode every actor is an NPC, so
    // the floor applies to all of them.
    allowLiveness: turnDeps.forceAllNpc === true || action.actorId !== world.userActorId,
    // Phase 5: the cascade's fully-typed intent threads to the executors.
    intent: decidedIntent,
    // Phase 6: the turn's provider-call counter (render invocations).
    callCounter,
  });
  // Phase 6: the "selection+execute" bucket — selection block plus the
  // deterministic engine execution inside resolveRender.
  const selectionExecuteMs = selectionBlockMs + timings.executeMs;
  const renderMs = timings.renderMs;
  report(turnDeps, { stage: "validation_done", actorId: action.actorId, message: "render validated" });

  // Exp-4 item 6: mark fallback history as un-applied so proposals ground
  // on the world, not the wish. Exp-5 item 2: liveness turns record the
  // narrative (what happened) plus the honest note — never the raw action
  // text — so later turns don't assume a dropped desk question was asked
  // or a laptop setup happened.
  // F18: applyRenderResult mutates the turn-start snapshot in place —
  // no second clone.
  const patched = applyRenderResult(world, action, render, executed, config, {
    fallback: isFallbackConsequence(render),
    honestHistoryNote: getHonestHistoryNote(render),
    liveness,
  }, turnSnapshot);
  report(turnDeps, { stage: "patch_applied", actorId: action.actorId, message: "world updated" });
  logger.log({
    module: "turn",
    event: "patch_applied",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    input: { render, executed, action },
    output: { historyTail: patched.history.slice(-1) },
  });
  logger.log({
    module: "turn",
    event: "history_appended",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    output: { history: patched.history.slice(-1) },
  });

  // F18: tick/turn advance in place on the working snapshot — no extra
  // clones (worldStore's pure incrementTick/advanceTurn stay for other
  // callers; runTurn owns its private clone here).
  patched.tick += 1;
  patched.turnIndex = (patched.turnIndex + 1) % patched.order.length;
  const nextWorld = patched;

  // F31: accumulate this turn's LLM usage totals (per-call usage is logged
  // by the engines) and include them on the turn-completed record.
  const turnUsage = accumulateTurnUsage(logger, world.tick, world.turnIndex);
  logger.log({
    module: "turn",
    event: "turn_completed",
    // Exp-7 item T4: the record describes the turn that just completed —
    // log its own tick/turnIndex, not the next tick's (the off-by-one
    // silently broke per-turn log analysis).
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    // F18: reuse the final world object without re-cloning. Nothing
    // mutates it afterwards: autosave only serializes, and the caller
    // receives it as an immutable snapshot (the next turn clones again).
    output: nextWorld,
    // Worker-B contract: `turnUsage?: LlmUsage` lands on the log record
    // type in src/logging/logTypes.ts; spread avoids an excess-property
    // error until it does.
    ...(turnUsage.totalTokens > 0 ? { turnUsage } : {}),
  });

  // Phase 6: turn economics. The budget check is a loud warning, never a
  // hard abort — a turn that needs 5 calls to avoid a fallback is better
  // than a fallback. The turn_telemetry event carries the per-stage
  // breakdown; `npm run report:turns` regenerates the findings table from
  // any run's log.
  const providerCalls = callCounter.total();
  const budget = config.turnCallBudget ?? DEFAULT_TURN_CALL_BUDGET;
  const { exceeded: budgetExceeded } = evaluateBudget(providerCalls, budget);
  const calls = callCounter.breakdown();
  if (budgetExceeded) {
    logger.log({
      module: "turn",
      event: "budget_exceeded",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action },
      output: { providerCalls, budget, calls, proposalMs, selectionExecuteMs, renderMs },
      error: budgetWarningMessage(action.actorId, providerCalls, budget, calls),
    });
  }
  const outcome: TurnOutcome = liveness
    ? "liveness"
    : isFallbackConsequence(render)
      ? "fallback"
      : "clean";
  const telemetry: TurnTelemetry = {
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    proposalMs,
    selectionExecuteMs,
    renderMs,
    totalMs: proposalMs + selectionExecuteMs + renderMs,
    calls,
    providerCalls,
    budget,
    budgetExceeded,
    outcome,
  };
  logger.log({
    module: "turn",
    event: "turn_telemetry",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    output: telemetry,
  });
  try {
    turnDeps.onTurnTelemetry?.(telemetry);
  } catch {
    // Telemetry hooks must never break the turn.
  }

  await autosave(nextWorld, turnDeps);
  report(turnDeps, { stage: "turn_completed", actorId: action.actorId, message: "turn completed" });
  return nextWorld;
}

/** Run n consecutive turns (helper for tests and scripts). */
export async function runTurns(world: World, deps: EngineDependencies, n: number): Promise<World> {
  let current = world;
  for (let i = 0; i < n; i++) {
    current = await runTurn(current, deps);
  }
  return current;
}
