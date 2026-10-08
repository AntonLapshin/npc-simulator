import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  EngineConfig,
  ProposalResult,
  World,
} from "../types.js";
import type { Intent } from "../decision/decisionTypes.js";
import type { ChatComplete } from "../decision/questionPlanner.js";
import { defaultConfig, isLayaIntentFirst } from "../config.js";
import {
  applyLayaPostHooks,
  layaWiringFromEnv,
  plausibilityAdvisoryForRetry,
  runIntentCascade,
  runRenderabilityScore,
  type LayaTurnWiring,
} from "./layaTurn.js";
import { checkLocomotionVeto } from "../decision/layaLocomotion.js";
import {
  deterministicSalvageOrder,
  rankSalvageCandidates,
} from "../decision/layaSalvageSelect.js";
import type {
  ConsequenceEngine,
  ProposalEngine,
  SelectionEngine,
  SemanticJudge,
} from "../intelligence/types.js";
import { applyConsequence } from "./patchApplier.js";
import { validateConsequence } from "./physicalValidator.js";
import { resolveActionSemantics } from "./actionSemantics.js";
import {
  clampMoveToCap,
  isClampableMovementFailure,
  isMovementOnlyFailure,
  isRealProgressFailure,
  stepTowardPoint,
  suggestMoveTarget,
} from "./movementAssist.js";
import {
  effectiveRepairTarget,
  narrativeApproachTarget,
  vetoAwayFromTarget,
  type NamedDestination,
} from "./textHints.js";
import { parseActionQuotes } from "./deterministicSemantics.js";
import { suggestionClusterNouns, suggestionCore, validateSelectionForActor } from "./contextBuilder.js";
import { collapseDoubledPrefix } from "./validate/narrative.js";
import { propStubForGroundingErrors } from "./validate/objects.js";
import { buildObjectAffordanceNudge } from "./contextBuilder.js";
import { FALLBACK_SELECTION } from "../llm/llmSelectionEngine.js";
import { buildRosterRetryLine, type TurnEngines } from "../llm/index.js";
import { MockSemanticJudge } from "../mocks/mockSemanticJudge.js";
import { getCurrentActor } from "./worldStore.js";
import { defaultSavePath, saveWorld } from "./persistence.js";
import {
  buildRetryDirective,
  countHardErrors,
  getHonestHistoryNote,
  isFallbackConsequence,
  isSpeechOnlyFailure,
  pickBestAttempt,
  recheckAcceptedProse,
  salvageFormatCollapse,
  shouldAbortRetries,
  trySalvageConsequence,
  type AttemptRecord,
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
  /**
   * Decision-AI judge for free-form action meaning. Consumed only when a
   * consequence omits its self-declared `effects`; defaults to the
   * offline MockSemanticJudge (zero network calls). Real runs may inject
   * LLMSemanticJudge. Judge failure fails open to physics-only validation.
   */
  semanticJudge?: SemanticJudge;
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
  isSpeechOnlyFailure,
  isTier2Salvageable,
  salvageFormatCollapse,
  trySalvageConsequence,
} from "./turnSalvage.js";
export type { SalvageEvaluation } from "./turnSalvage.js";
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
 * F2: error codes that mean "a missing object/prop/pose patch" — gates the
 * object-affordance retry hint (previously a prose regex over messages).
 */
const OBJECT_PATCH_ERROR_CODES = new Set([
  "object_grounding.sit_no_pose",
  "object_grounding.brew_no_patch",
  "object_grounding.pickup_no_patch",
  "object_grounding.open_no_patch",
  "object_grounding.sip_no_prop",
  "object_grounding.hold_no_prop",
  "action.pour_no_patch",
  "action.pickup_no_patch",
  "action.sit_no_pose",
  "action.stand_no_pose",
]);

/**
 * LLMs sometimes echo the candidate list numbering ("3. Call out ...",
 * "2) Nod ...") into the chosen action. That prefix is presentation, not
 * part of the action — strip it so it never reaches consequences,
 * validation, or history.
 */
export function stripSelectionPrefix(text: string): string {
  return text.replace(/^\s*\d+\s*[.)]\s*/, "").trimStart();
}

/** Offline default: keyword-based mock judge (zero network calls). */
const defaultSemanticJudge: SemanticJudge = new MockSemanticJudge();





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


/** Resolve with validation retries; applies fallback when retries are exhausted. */
/**
 * Exp-5 item 6 (S2): honest stationary narrative for a vetoed movement
 * repair with no legal toward-step. Never claims the movement that didn't
 * happen; preserves quoted speech (it did happen); names the
 * already-reached target when adjacent so the history reads honestly
 * ("Tanya remains by Anton" — not "tried to walk and failed").
 * Pure.
 */
export function synthesizeStationaryNarrative(
  action: Action,
  name: string,
  actor: { x: number; y: number },
  target: { x: number; y: number; kind: "actor" | "object"; id: string } | null,
  targetLabel: string | undefined,
): string {
  const quotes = parseActionQuotes(action.text);
  // "remains" (not "holds position"): the object-grounding gate reads
  // "holds" as an object verb and would demand a prop patch.
  let base = `${name} remains in position`;
  if (target !== null && targetLabel !== undefined) {
    const d = Math.hypot(actor.x - target.x, actor.y - target.y);
    if (d <= 2.5) base += ` by ${targetLabel}`;
  }
  base += ".";
  if (quotes.length > 0) {
    base += ` ${name} says ${quotes.map((q) => `"${q}"`).join(" ")}.`;
  }
  return base;
}

/**
 * Exp-5 item 6 (S2): honest stationary downgrade for a vetoed movement
 * repair with no legal toward-step. The veto means no legal step toward
 * the effective target exists from the actor's cell (already adjacent, or
 * boxed in) — a world fact retries cannot change — so commit a stationary
 * turn instead of veto → retry → fallback. Keeps the attempt's
 * non-movement patches (thoughts/emotion), drops x/y, declares
 * moved=false, and synthesizes an honest stationary narrative. Returns
 * null when there is no acting-actor patch to downgrade. The caller
 * validates the result (with moves=false semantics) and runs the accept
 * gate before committing. Pure (no logging).
 */
export function buildStationaryDowngrade(
  world: World,
  action: Action,
  result: ConsequenceResult,
  effTarget: { x: number; y: number; kind: "actor" | "object"; id: string } | null,
): ConsequenceResult | null {
  const actor = world.actors.find((a) => a.id === action.actorId);
  if (!actor) return null;
  const patch = result.actorPatches.find((p) => p.actorId === action.actorId);
  if (!patch) return null;
  const downgraded: ConsequenceResult = structuredClone(result);
  const dPatch = downgraded.actorPatches.find((p) => p.actorId === action.actorId)!;
  delete dPatch.x;
  delete dPatch.y;
  let targetLabel: string | undefined;
  if (effTarget !== null) {
    if (effTarget.kind === "actor") {
      targetLabel = world.actors.find((a) => a.id === effTarget.id)?.name;
    } else {
      targetLabel = world.scene.objects.find((o) => o.id === effTarget.id)?.name;
    }
  }
  downgraded.narrative = synthesizeStationaryNarrative(
    action,
    actor.name ?? action.actorId,
    actor,
    effTarget,
    targetLabel,
  );
  if (downgraded.effects) {
    downgraded.effects.moved = false;
    delete downgraded.effects.destinationActorId;
    delete downgraded.effects.destinationObjectId;
    const quotes = parseActionQuotes(action.text);
    if (quotes.length > 0) {
      downgraded.effects.spoke = true;
      downgraded.effects.quotedSpeech = quotes;
    } else {
      downgraded.effects.spoke = false;
      downgraded.effects.quotedSpeech = [];
    }
  }
  return downgraded;
}

export async function resolveWithValidation(
  world: World,
  action: Action,
  deps: EngineDependencies,
  opts: { allowLiveness?: boolean } = {},
): Promise<ConsequenceResult> {
  const config = depsConfig(deps);
  const logger = deps.logger;
  let feedback: string | undefined;
  let lastResult: ConsequenceResult | undefined;
  let lastSemantics: ActionSemantics | undefined;
  // Item C10 (S7) / Exp-2 item 7: every attempt's {result, semantics,
  // hardErrorCount, attempt} — salvage runs from the attempt with the
  // FEWEST hard errors (pickBestAttempt), not the last, and the loop
  // aborts early when hard errors grow twice in a row.
  const attempts: AttemptRecord[] = [];

  // Exp-6 item 3: total turn wall-time budget for the consequence phase. A
  // turn burned 47 minutes in Exp-6 with no circuit breaker — when the
  // deadline hits, the turn stops burning LLM calls and falls through to
  // salvage → liveness → fallback.
  const turnTimeoutMs = config.turnTimeoutMs ?? 600_000;
  const deadlineAt = Date.now() + turnTimeoutMs;
  const timeLeft = (): number => deadlineAt - Date.now();
  let deadlineExceeded = false;

  // Exp-6 item 6 / Q2: the semantic judge classifies the ACTION text —
  // independent of the consequence result — but only when a consequence
  // provides no `effects` (lazy judge: classification is only needed for
  // grounding then). Started once, on the first attempt that needs it, and
  // reused across retry attempts instead of re-running a judge LLM call
  // per attempt.
  const judge: SemanticJudge = deps.semanticJudge ?? defaultSemanticJudge;
  let judgePromise: Promise<ActionSemantics> | undefined;
  const judgeForAttempt = (): SemanticJudge => ({
    classify: () => {
      if (!judgePromise) {
        judgePromise = Promise.resolve().then(() => judge.classify(world, action));
      }
      return judgePromise;
    },
  });

  // Exp-6 item 4: track whether the engine EVER produced parseable output
  // this turn, keeping the raw attempts for the format-collapse tier.
  let haveParseableResult = false;
  let turnRawAttempts: string[] = [];
  let consecutiveParseFailures = 0;

  // Exp-6 item 8: demand the object/prop patch up front in retry feedback
  // when the action manipulates an object (also present in the initial
  // consequence context via buildConsequenceContext).
  const affordanceNudge = buildObjectAffordanceNudge(world, action);

  // Exp-2-E item (b): per-turn cache for the Laya locomotion veto. The
  // action text is constant across attempts, so the noul is asked at most
  // once per turn. undefined = not asked yet; true = veto moves.
  let locomotionVeto: boolean | undefined;

  // Exp-7: the outer attempt cap is consequenceMaxAttempts (default 2),
  // not maxRetries+1. Retries don't steer the model (exp-7 B2) — the
  // in-loop deterministic repairs below run on every attempt, and salvage
  // handles what they can't.
  const maxAttempts = Math.max(1, config.consequenceMaxAttempts ?? config.maxRetries + 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (timeLeft() <= 0) {
      deadlineExceeded = true;
      break;
    }
    let result: ConsequenceResult;
    try {
      // F28: the deadline signal is forwarded to the consequence engine
      // (which passes it to the provider call) so a hung LLM request is
      // cancelled on timeout.
      // Exp-6 item 2: flag user turns so the engine leads with the
      // user-turn directive (the player's words are ground truth).
      result = await withTurnDeadline(
        (signal) =>
          deps.consequenceEngine.resolve(world, action, feedback, {
            signal,
            isUserTurn: !deps.forceAllNpc && action.actorId === world.userActorId,
          }),
        timeLeft(),
      );
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
      if (attempt >= maxAttempts) break;
      logger.log({
        module: "turn",
        event: "retry_started",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, attempt: attempt + 1 },
        output: { feedback },
      });
      continue;
    }

    // Exp-6 item 4: the engine reports whether its output parsed. Two
    // consecutive unparseable engine calls mean the model is collapsing at
    // the JSON layer, not the content layer — more full retries won't
    // help, so stop and let the format-collapse tier salvage below.
    const diag = readEngineDiagnostics(deps.consequenceEngine);
    if (diag !== undefined) {
      turnRawAttempts = diag.rawAttempts;
      if (diag.parsed) {
        haveParseableResult = true;
        consecutiveParseFailures = 0;
      } else {
        consecutiveParseFailures += 1;
        if (consecutiveParseFailures >= 2) {
          logger.log({
            module: "turn",
            event: "consequence_parse_collapse",
            tick: world.tick,
            turnIndex: world.turnIndex,
            actorId: action.actorId,
            input: { action, attempt },
            output: { consecutiveParseFailures },
            error:
              "consequence output failed to parse twice in a row — stopping retries, format-collapse salvage next",
          });
          lastResult = result;
          break;
        }
      }
    }

    logger.log({
      module: "validator",
      event: "validation_started",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, result, attempt },
    });

    report(deps, {
      stage: "validation_started",
      actorId: action.actorId,
      message: `validating consequence (attempt ${attempt})…`,
    });
    // Merged semantics: the consequence's self-declared `effects` are
    // checked against an independent classification of the action text
    // (OR for requirement flags), so a consequence cannot dodge
    // movement/speech/addressee gates by declaring moved=false/spoke=false.
    // Q2 (lazy semantic judge): the judge only runs when the consequence
    // provides no `effects` — classification exists to ground the gates,
    // and `effects` alone already grounds them. Judge output is logged per
    // turn (semantic_resolved/semantic_completed) for observability, like
    // selection_completed.
    const resolved = await resolveActionSemantics(
      world,
      action,
      result,
      result.effects === undefined ? judgeForAttempt() : undefined,
      logger,
    );
    lastResult = result;
    // Exp-2-E item (b): Laya locomotion supplement (LAYA_LOCOMOTION=1,
    // off by default). Deterministic/merged semantics decide moves first;
    // Laya only ever VETOES a moves=true — when it is confident the action
    // needs no relocation ("turn to face Dan", "where should I sit?").
    // Laya failure or low confidence keeps the deterministic verdict.
    let semantics = resolved.semantics;
    let semanticsSource = resolved.source;
    if (
      semantics?.moves === true &&
      deps.laya?.config.toggles.locomotion === true
    ) {
      if (locomotionVeto === undefined) {
        locomotionVeto =
          (await checkLocomotionVeto(deps.laya.client, action.text)) === true;
        logger.log({
          module: "laya",
          event: locomotionVeto ? "locomotion_veto" : "locomotion_confirmed",
          tick: world.tick,
          turnIndex: world.turnIndex,
          actorId: action.actorId,
          input: { actionText: action.text, deterministicMoves: true },
          output: { veto: locomotionVeto },
        });
      }
      if (locomotionVeto) {
        semantics = { ...semantics, moves: false };
        semanticsSource = "merged";
      }
    }
    lastSemantics = semantics;
    // Exp-4 item 6 (S4): deterministic doubled-prefix repair — "Dana:
    // Dana: …" collapses to "Dana: …" instead of tripping the voice gate
    // every attempt. First-person prose is NOT auto-rewritten (too risky);
    // it fails the voice gate with a targeted retry hint.
    {
      const actor = world.actors.find((a) => a.id === action.actorId);
      const collapsed = collapseDoubledPrefix(result.narrative, actor?.name);
      if (collapsed !== result.narrative) {
        logger.log({
          module: "validator",
          event: "narrative_prefix_collapsed",
          tick: world.tick,
          turnIndex: world.turnIndex,
          actorId: action.actorId,
          input: { narrative: result.narrative },
          output: { narrative: collapsed },
        });
        result.narrative = collapsed;
      }
    }
    const validation = validateConsequence(world, result, action, semantics);
    // Exp-2 item 5 (S2): final accept gate. The tick-10/11 corrupt
    // narratives passed validateConsequence outright (wrong-subject prose;
    // stay-action teleport via self-declared effects.moved), so the
    // accepted narrative gets one more prose re-check before it may become
    // canonical history. A rejection is handled exactly like a validation
    // failure: the attempt is recorded for best-attempt salvage and the
    // loop retries. Unconditional (ARCHITECTURE P1 correctness fix).
    const acceptGateErrors = validation.valid
      ? recheckAcceptedProse(world, action, result)
      : [];
    if (validation.valid && acceptGateErrors.length === 0) {
      logger.log({
        module: "validator",
        event: "validation_passed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, result, attempt, semanticsSource, semantics },
        output: validation,
      });
      return result;
    }
    // The errors driving the retry below: the validator's, or the final
    // accept gate's when validation itself passed.
    const errors = validation.valid ? acceptGateErrors : validation.errors;
    if (validation.valid) {
      logger.log({
        module: "turn",
        event: "accept_gate_rejected",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, result, attempt },
        output: { errors: errors.map((e) => `[${e.code}] ${e.message}`) },
      });
    }

    logger.log({
      module: "validator",
      event: "validation_failed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, result, attempt, semanticsSource, semantics },
      // LogInput.validationErrors is string[] — log the messages; the
      // codes stay on the ValidationError objects in the trace output.
      validationErrors: errors.map((e) => `[${e.code}] ${e.message}`),
    });

    // Item C10 (S7) / Exp-2 item 7: record the failed attempt for
    // best-attempt salvage (fewest hard errors, ties → earliest).
    attempts.push({
      result,
      semantics,
      hardErrors: countHardErrors(errors),
      attempt,
    });

    // Deterministic movement repair: small LLMs often narrate movement
    // correctly but omit the required x/y patch on every retry. When the
    // failure is movement-only and we can compute a valid closer position,
    // patch it in directly instead of burning retries on a "Nothing
    // changes." fallback. The narrative already describes the movement, so
    // filling in coordinates preserves intent.
    let movementHint: string | undefined;
    if (semantics?.moves) {
      // Item C7 (S1): the action text steers the suggestion — "walk east"
      // must not repair westward when no destination was declared.
      let suggestion = suggestMoveTarget(
        world,
        action.actorId,
        semantics.destinationActorId,
        semantics.destinationObjectId,
        action.text,
      );
      // Exp-3 item 7 (S5, A3 — tick-28 repro): veto a repair that steps
      // AWAY from the narrative's named approach target. Veto-only: the
      // turn retries/salvages instead of applying corrupt movement.
      //
      // Exp-4 item 5 (S2): a veto without a constructive alternative froze
      // the avatar for 27 of 30 exp-4 ticks (veto → retry → retry →
      // fallback, zero displacement). When the veto fires, re-steer: take
      // a capped step TOWARD the effective target instead of retrying into
      // the same wall. Only when no legal toward-step exists does the
      // turn commit an honest stationary downgrade (below).
      //
      // Exp-5 item 6 (S2): the veto and re-steer now use the EFFECTIVE
      // target — the judge's resolved destination when present, else the
      // narrative's (see effectiveRepairTarget). Tick-15 repro: the judge
      // correctly resolved anton_desk while the corrupt narrative said
      // "Tanya's desk", so the narrative-target veto killed a good repair.
      // A judge/narrative disagreement is logged; the movement gates
      // enforce the judge's semantics, so the repair must satisfy them.
      let resteeredTarget: NamedDestination | null = null;
      if (suggestion) {
        const effTarget = effectiveRepairTarget(
          world,
          action.actorId,
          result.narrative,
          semantics,
        );
        const narrativeTarget = narrativeApproachTarget(
          world,
          action.actorId,
          result.narrative,
        );
        if (
          effTarget !== null &&
          narrativeTarget !== null &&
          effTarget.id !== narrativeTarget.id
        ) {
          logger.log({
            module: "validator",
            event: "repair_target_disagreement",
            tick: world.tick,
            turnIndex: world.turnIndex,
            actorId: action.actorId,
            output: `judge destination "${effTarget.id}" disagrees with narrative target "${narrativeTarget.id}" — trusting the judge (the movement gates enforce its semantics)`,
          });
        }
        const vetted =
          effTarget !== null
            ? vetoAwayFromTarget(world, action.actorId, suggestion, effTarget)
            : suggestion;
        if (!vetted) {
          const resteered =
            effTarget !== null
              ? stepTowardPoint(world, action.actorId, effTarget.x, effTarget.y)
              : null;
          if (resteered && effTarget !== null) {
            resteeredTarget = { kind: effTarget.kind, id: effTarget.id };
            logger.log({
              module: "validator",
              event: "movement_repair_resteered",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              output: `repair (${suggestion.x}, ${suggestion.y}) stepped away from the effective approach target ("${effTarget.id}") — re-steered to a capped step toward it (${resteered.x}, ${resteered.y}) instead of retrying`,
            });
            suggestion = resteered;
          } else {
            logger.log({
              module: "validator",
              event: "movement_repair_vetoed",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              output: `repair (${suggestion.x}, ${suggestion.y}) stepped away from the effective approach target${effTarget ? ` ("${effTarget.id}")` : ""} and no legal toward-step exists — vetoed`,
            });
            suggestion = null;
            // Exp-5 item 6 (S2): veto with no legal toward-step is a world
            // fact (already adjacent, or boxed in) — retries cannot change
            // it. Commit an honest stationary downgrade now instead of
            // veto → retry → fallback. Falls through to retry only when
            // the downgrade itself fails validation.
            const downgrade = buildStationaryDowngrade(
              world,
              action,
              result,
              effTarget,
            );
            if (downgrade !== null) {
              const dv = validateConsequence(
                world,
                downgrade,
                action,
                semantics ? { ...semantics, moves: false } : undefined,
              );
              const dg = recheckAcceptedProse(world, action, downgrade);
              if (dv.valid && dg.length === 0) {
                logger.log({
                  module: "validator",
                  event: "movement_downgraded_stationary",
                  tick: world.tick,
                  turnIndex: world.turnIndex,
                  actorId: action.actorId,
                  input: { action, result, attempt },
                  output: { downgraded: downgrade },
                });
                return downgrade;
              }
              logger.log({
                module: "validator",
                event: "stationary_downgrade_rejected",
                tick: world.tick,
                turnIndex: world.turnIndex,
                actorId: action.actorId,
                output: {
                  errors: [...dv.errors, ...dg].map((e) => `[${e.code}]`),
                },
                error:
                  "stationary downgrade failed validation — falling through to retry",
              });
            }
          }
        } else {
          suggestion = vetted;
        }
      }
      if (suggestion) {
        // Exp-4 item 5 (S2): the hint names the effective destination —
        // the narrative's target after a re-steer, the judged one
        // otherwise — so retry feedback steers toward the same point the
        // repair would take.
        const hintDestActorId =
          resteeredTarget?.kind === "actor"
            ? resteeredTarget.id
            : semantics.destinationActorId;
        const hintDestObjectId =
          resteeredTarget?.kind === "object"
            ? resteeredTarget.id
            : semantics.destinationObjectId;
        const dest = hintDestActorId
          ? ` strictly closer to ${hintDestActorId}`
          : hintDestObjectId
            ? ` strictly closer to ${hintDestObjectId}`
            : "";
        movementHint =
          `Movement hint: emit actorPatch {"actorId": "${action.actorId}", "x": ${suggestion.x}, "y": ${suggestion.y}, ...}` +
          ` — position (${suggestion.x}, ${suggestion.y}) is reachable and${dest ? dest : " a valid step"} from the current position. ` +
          `Set effects.moved=true${hintDestActorId ? ` and effects.destinationActorId="${hintDestActorId}"` : ""}${hintDestObjectId ? ` and effects.destinationObjectId="${hintDestObjectId}"` : ""}.`;
        // F24: the in-loop repair also covers "make real progress" /
        // token-shuffle failures — try suggestMoveTarget first, then
        // clampMoveToCap below.
        if (isMovementOnlyFailure(errors) || isRealProgressFailure(errors)) {
          const repaired: ConsequenceResult = structuredClone(result);
          const existing = repaired.actorPatches.find((p) => p.actorId === action.actorId);
          if (existing) {
            existing.x = suggestion.x;
            existing.y = suggestion.y;
          } else {
            repaired.actorPatches.push({
              actorId: action.actorId,
              x: suggestion.x,
              y: suggestion.y,
            });
          }
          if (repaired.effects) {
            repaired.effects.moved = true;
            // Exp-4 item 5 (S2): a re-steered repair steps toward the
            // narrative's target, not the judged one — declare that
            // destination so the revalidation checks coherence against
            // what the narrative actually claims.
            const effDestActorId =
              resteeredTarget?.kind === "actor"
                ? resteeredTarget.id
                : semantics.destinationActorId;
            const effDestObjectId =
              resteeredTarget?.kind === "object"
                ? resteeredTarget.id
                : semantics.destinationObjectId;
            if (effDestActorId !== undefined) {
              repaired.effects.destinationActorId = effDestActorId;
            }
            if (effDestObjectId !== undefined) {
              repaired.effects.destinationObjectId = effDestObjectId;
            }
          }
          // Re-validate against the same judged semantics (effects may now
          // agree with the judge — either way the movement gate must pass).
          const revalidation = validateConsequence(
            world,
            repaired,
            action,
            semantics,
          );
          // Exp-2 item 5 (S2): the repaired payload gets the final accept
          // gate too — a repaired movement must not launder corrupt prose.
          if (
            revalidation.valid &&
            recheckAcceptedProse(world, action, repaired).length === 0
          ) {
            logger.log({
              module: "validator",
              event: "validation_passed",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              input: { action, result: repaired, attempt, semanticsSource, semantics },
              output: { ...revalidation, repaired: true, suggestion },
            });
            logger.log({
              module: "turn",
              event: "movement_repaired",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              input: { action, result, attempt },
              output: { suggestion, repaired },
            });
            return repaired;
          }
        }
      }
      // Exp-4 item 1: the speed limit reads as a pace, not a wall. When the
      // model claims an over-cap jump in the right direction (tick 15: the
      // full 14-cell entrance→desk walk; tick 18: 8–12-cell strides),
      // project ITS claimed target onto the ≤6-cell reachable set and
      // continue next turn — instead of failing the whole turn. Accepts
      // only when the clamped position passes the full gate on
      // revalidation; otherwise the turn retries/salvages normally.
      // F2: cap detection is code-based. F24: also fires for real-progress
      // failures (suggestMoveTarget above is tried first).
      const capHit = errors.some((e) => e.code === "movement.over_step_cap");
      const progressHit = isRealProgressFailure(errors);
      if ((capHit || progressHit) && isClampableMovementFailure(errors)) {
        const claimed = result.actorPatches.find((p) => p.actorId === action.actorId);
        const clamped =
          claimed?.x !== undefined && claimed?.y !== undefined
            ? clampMoveToCap(world, action.actorId, claimed.x, claimed.y)
            : undefined;
        if (clamped) {
          const clampedResult: ConsequenceResult = structuredClone(result);
          const existing = clampedResult.actorPatches.find((p) => p.actorId === action.actorId);
          if (existing) {
            existing.x = clamped.x;
            existing.y = clamped.y;
          } else {
            clampedResult.actorPatches.push({
              actorId: action.actorId,
              x: clamped.x,
              y: clamped.y,
            });
          }
          if (clampedResult.effects) {
            clampedResult.effects.moved = true;
          }
          const revalidation = validateConsequence(
            world,
            clampedResult,
            action,
            semantics,
          );
          // Exp-2 item 5 (S2): final accept gate on the clamped payload too.
          if (
            revalidation.valid &&
            recheckAcceptedProse(world, action, clampedResult).length === 0
          ) {
            logger.log({
              module: "validator",
              event: "validation_passed",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              input: { action, result: clampedResult, attempt, semanticsSource, semantics },
              output: { ...revalidation, repaired: true, clamped: true, suggestion: clamped },
            });
            logger.log({
              module: "turn",
              event: "movement_repaired",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              input: { action, result, attempt },
              output: { suggestion: clamped, repaired: clampedResult, clamped: true },
            });
            return clampedResult;
          }
        }
      }
    }

    // Exp-4 item 10 (S6): deterministic prop-stub repair. When the ONLY
    // failures are prop-mappable grounding misses (the model narrated sip/
    // type/open/pick-up/pour but forgot the prop patch), set the prop
    // deterministically instead of burning retries teaching the
    // convention. Accepts only when the stubbed payload passes the full
    // gate; otherwise the turn retries/salvages normally.
    const stubProp = propStubForGroundingErrors(
      world,
      action,
      result.narrative,
      errors,
    );
    if (stubProp !== null) {
      const stubbed: ConsequenceResult = structuredClone(result);
      const existing = stubbed.actorPatches.find(
        (p) => p.actorId === action.actorId,
      );
      if (existing) {
        existing.prop = stubProp;
      } else {
        stubbed.actorPatches.push({ actorId: action.actorId, prop: stubProp });
      }
      const revalidation = validateConsequence(world, stubbed, action, semantics);
      // Exp-2 item 5 (S2): final accept gate on the stubbed payload too.
      if (
        revalidation.valid &&
        recheckAcceptedProse(world, action, stubbed).length === 0
      ) {
        logger.log({
          module: "validator",
          event: "validation_passed",
          tick: world.tick,
          turnIndex: world.turnIndex,
          actorId: action.actorId,
          input: { action, result: stubbed, attempt, semanticsSource, semantics },
          output: { ...revalidation, repaired: true, propStub: stubProp },
        });
        logger.log({
          module: "turn",
          event: "object_prop_stub_applied",
          tick: world.tick,
          turnIndex: world.turnIndex,
          actorId: action.actorId,
          input: { action, result, attempt },
          output: { prop: stubProp, repaired: stubbed },
        });
        return stubbed;
      }
    }

    // Phase 4 "retry only prose": when the patches are valid and only the
    // narrative prose fails (speech nit, possibly plus droppable
    // hallucinated patches), say so explicitly — otherwise the retry
    // regenerates everything and often loses the good movement it just had
    // (ticks 3/9). This hint costs nothing when the model already retries
    // cleanly; after retries are exhausted the salvage path below applies
    // the same split (keep patches, warn on speech).
    let proseHint: string | undefined;
    if (isSpeechOnlyFailure(errors)) {
      proseHint =
        "The patches are valid — keep every actorPatch/objectPatch exactly as-is and fix ONLY the narrative prose (preserve the action's exact wording).";
    } else if (errors.some((e) => e.code === "actor.unknown_id" || e.code === "object.unknown_id")) {
      proseHint =
        "Drop patches that reference unknown ids, keep the remaining valid patches exactly as-is, and fix the narrative prose.";
    }

    // Exp-6 item 8: when the failure is a missing object/prop/pose patch
    // for a manipulated object, demand that patch explicitly (naming the
    // object) instead of only punishing its absence after the fact.
    // F2: gated on error codes, not message prose.
    const objectAffordanceHint =
      affordanceNudge !== undefined &&
      errors.some((e) => OBJECT_PATCH_ERROR_CODES.has(e.code))
        ? affordanceNudge
        : undefined;

    // Item C1: repeat the actual roster ids in the retry feedback when the
    // failure names unknown actors — retrieval beats recall for small models.
    const rosterRepeat = errors.some(
      (e) => e.code === "narrative.unknown_actor" || e.code === "actor.unknown_id",
    )
      ? `\n${buildRosterRetryLine(world.actors.map((a) => a.id))}`
      : "";
    // Phase 4: advisory patch-plausibility — each object/position patch gets
    // a Laya 1–5 score in one batched call; scores ≤2 append a NON-BLOCKING
    // advisory note to the retry feedback. Never invalidates on its own.
    let plausibilityNote: string | undefined;
    if (deps.laya?.plausibility === true) {
      // Exp-2 S6: thread observability through so the phase reports
      // (scored / no-op reason) into the layaEvents histogram.
      plausibilityNote = await plausibilityAdvisoryForRetry(
        deps.laya.client,
        action,
        result,
        { logger, tick: world.tick, turnIndex: world.turnIndex, attempt },
      );
    }
    // Coordinator follow-up (Exp-2 M4): the retry feedback leads with a
    // deterministic "most severe error first, one line" directive instead
    // of the raw multi-gate dump (which pushed small models
    // off-distribution); the targeted hints below stay as-is.
    feedback = `Previous consequence output was invalid: ${buildRetryDirective(errors)}${proseHint ? `\n${proseHint}` : ""}${movementHint ? `\n${movementHint}` : ""}${objectAffordanceHint ? `\n${objectAffordanceHint}` : ""}${rosterRepeat}${plausibilityNote ? `\n${plausibilityNote}` : ""}\nReturn corrected JSON only.`;
    if (attempt >= maxAttempts) break;
    // Exp-3 item 9 (S7, RULE-C): abort the retry loop early when the last
    // two attempts both failed to STRICTLY improve on the best-so-far
    // hard-error count. Data-grounded on Exp-3 (25 eligible turns): the old
    // "strictly growing twice" rule fired 6/25 and could save at most 1
    // call (it sits after the maxRetries break); RULE-C fires 17/25,
    // saves ~17 LLM calls, loses 0 best-attempts by construction (it only
    // fires when the best-so-far predates the last two attempts, and
    // pickBestAttempt breaks ties toward the earliest), at the cost of 1
    // success (m5 tick=12: [2,4,3] would abort at 3 instead of passing at
    // 4 — the turn still advances via salvage, as partial_applied).
    // Attempt 1 is the pickBestAttempt winner in 72% of Exp-3 turns, so
    // aborting a non-improving tail is safe.
    // Exp-6 item 11 (S8): the decision is a pure function
    // (shouldAbortRetries) so the exp-6 divergence shapes are
    // regression-tested without running turns.
    if (shouldAbortRetries(attempts.map((a) => a.hardErrors), config.maxRetries)) {
      const hardErrors = attempts.map((a) => a.hardErrors);
      const bestSoFar = Math.min(...hardErrors.slice(0, hardErrors.length - 2));
      logger.log({
        module: "turn",
        event: "retry_aborted",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, attempt },
        output: { hardErrors, bestSoFar },
        error: `last two attempts failed to improve on best-so-far hard errors (${bestSoFar}) — stopping retries, salvaging the best attempt`,
      });
      break;
    }
    report(deps, {
      stage: "consequence_retry",
      actorId: action.actorId,
      message: `consequence invalid — retrying (attempt ${attempt + 1})…`,
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
      error: `consequence phase exceeded its ${turnTimeoutMs}ms wall-time budget — falling through to salvage`,
    });
  }

  // Exp-6 item 4: "valid-JSON-at-all-costs" tier — nothing ever parsed, so
  // the generic salvage below would operate on a "Nothing changes." husk.
  // A degraded narrative/thoughts payload built from the model's own
  // (unparseable) emissions beats a total loss. Runs before the
  // content-salvage ladder; when it finds nothing usable, the ladder below
  // still gets its chance.
  if (!haveParseableResult && turnRawAttempts.length > 0) {
    const degraded = salvageFormatCollapse(world, action, turnRawAttempts, config);
    if (degraded) {
      // Exp-3 item 5 (S3): defense in depth — the final accept gate runs
      // on the format-salvage path too. The narrative is action-derived
      // (low risk) but the donor thoughts are unvalidated model output;
      // a gate failure falls through to the content-salvage ladder below
      // instead of returning corrupt prose.
      const formatGateErrors = recheckAcceptedProse(world, action, degraded);
      if (formatGateErrors.length > 0) {
        logger.log({
          module: "turn",
          event: "format_salvage_gate_rejected",
          tick: world.tick,
          turnIndex: world.turnIndex,
          actorId: action.actorId,
          input: { action, rawAttemptCount: turnRawAttempts.length },
          output: { errors: formatGateErrors.map((e) => e.code) },
          error: "format-salvage payload failed the final accept gate — falling through to content salvage",
        });
      } else {
        logger.log({
          module: "turn",
          event: "format_salvage_applied",
          tick: world.tick,
          turnIndex: world.turnIndex,
          actorId: action.actorId,
          input: { action, rawAttemptCount: turnRawAttempts.length },
          output: { salvaged: degraded },
        });
        return degraded;
      }
    }
  }

  // Exp-3 item 6: before giving up to "Nothing changes.", try to salvage
  // an attempt — keep valid movement/patches, warn on speech nits.
  // Exp-4 item 8: the evaluation (eligible/ineligible + reason) is logged
  // inside trySalvageConsequence as `salvage_evaluated`.
  // Item C10 (S7) / Exp-2 item 7: salvage from the attempt with the FEWEST
  // hard (non-speech-nit) errors, not the last — attempt 1 is
  // systematically the best. pickBestAttempt is the pure, unit-tested
  // selection (ties → earliest attempt); deterministicSalvageOrder is the
  // same ordering over all candidates for the ladder.
  // Exp-2-E item (a): salvage candidate order. LAYA_SALVAGE_SELECT=1 (off
  // by default) asks Laya which candidate narrative best matches the action
  // and tries the ranked order, applying the first salvageable candidate.
  // Any Laya failure degrades to the deterministic order. When the flag is
  // off the path is unchanged: only the single fewest-hard-errors attempt
  // is tried.
  const salvageCandidates = attempts.map((a) => ({
    result: a.result,
    hardErrors: a.hardErrors,
  }));
  const salvageLaya =
    deps.laya?.config.toggles.salvageSelect === true ? deps.laya : undefined;
  const deterministicOrder = deterministicSalvageOrder(salvageCandidates);
  let salvageOrder: number[] | undefined;
  if (salvageLaya && salvageCandidates.length > 1) {
    salvageOrder = await rankSalvageCandidates(
      salvageLaya.client,
      action,
      salvageCandidates,
    );
    logger.log({
      module: "laya",
      event: "salvage_ranked",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { hardErrors: salvageCandidates.map((c) => c.hardErrors) },
      output: {
        order: salvageOrder,
        usedLaya: salvageOrder !== undefined,
        agreedWithDeterministic:
          salvageOrder !== undefined &&
          JSON.stringify(salvageOrder) === JSON.stringify(deterministicOrder),
      },
    });
  }
  const salvageTryOrder =
    salvageLaya !== undefined
      ? (salvageOrder ?? deterministicOrder)
      : deterministicOrder.slice(0, 1);
  const bestAttempt = pickBestAttempt(attempts);
  if (bestAttempt) {
    logger.log({
      module: "turn",
      event: "salvage_best_attempt",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action },
      output: {
        pickedAttempt: bestAttempt.attempt,
        hardErrors: attempts.map((a) => a.hardErrors),
      },
    });
  }
  for (const i of salvageTryOrder) {
    const candidate = attempts[i];
    if (!candidate?.result || !candidate.semantics) continue;
    const salvage = trySalvageConsequence(
      world,
      action,
      candidate.result,
      candidate.semantics,
      logger,
      config,
    );
    if (salvage) {
      logger.log({
        module: "turn",
        event: "partial_applied",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, result: candidate.result },
        output: { salvaged: salvage.salvaged, warnings: salvage.warnings },
        ...(salvage.warnings.length > 0
          ? { error: `speech warnings (applied anyway): ${salvage.warnings.map((w) => `[${w.code}] ${w.message}`).join(" | ")}` }
          : {}),
      });
      return salvage.salvaged;
    }
  }

  // Exp-5 item 6: NPC liveness floor. Before giving up to "Nothing
  // changes.", check whether this actor has already fallen back N
  // consecutive own turns — if so, apply a minimal in-place reaction
  // (thoughts-only, plus a stub for anyone directly addressed) so the
  // scene keeps moving by dialogue even when bodies cannot. User turns
  // are excluded by the caller: silently rewriting the user's own action
  // would hide the failure from them.
  if (opts.allowLiveness !== false && lastSemantics) {
    const threshold = depsConfig(deps).livenessFallbackThreshold ?? 3;
    const priorFallbacks = consecutiveFallbacks(world, action.actorId);
    if (priorFallbacks >= threshold) {
      const liveness = buildLivenessConsequence(world, action, lastSemantics, priorFallbacks);
      // Exp-3 item 5 (S3): defense in depth — the final accept gate runs
      // on the liveness path too. The templates are fixed (safe by
      // construction), but bypassing validation by design is how the S2
      // hole happened; a gate failure falls through to the plain
      // fallback instead of applying.
      const livenessGateErrors = recheckAcceptedProse(world, action, liveness);
      if (livenessGateErrors.length === 0) {
        logger.log({
          module: "turn",
          event: "liveness_applied",
          tick: world.tick,
          turnIndex: world.turnIndex,
          actorId: action.actorId,
          input: { action, result: lastResult, priorFallbacks },
          output: { liveness },
        });
        return liveness;
      }
      logger.log({
        module: "turn",
        event: "liveness_gate_rejected",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, priorFallbacks },
        output: { errors: livenessGateErrors.map((e) => e.code) },
        error: "liveness payload failed the final accept gate — falling through to fallback",
      });
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
    error: "max retries exceeded",
  });
  // F23: mark the engine-produced fallback so isFallbackConsequence checks
  // the flag first (narrative equality stays as backward compat).
  const fallbackResult = structuredClone(FALLBACK_CONSEQUENCE);
  fallbackResult.fallback = true;
  return fallbackResult;
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
          semanticJudge: turnEngines.judge,
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
  // base passed to applyConsequence below (which no longer clones when it
  // receives one). Aliasing note: the in-memory log-store entry for
  // turn_started references the same object that applyConsequence then
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
    const proposal = await (turnDeps.proposalEngine as ProposalEngineWithIntent).propose(world, actor.id, intent);
    report(turnDeps, { stage: "proposal_done", actorId: actor.id, message: `proposal engine done (${proposal.suggestions.length} suggestions)` });
    report(turnDeps, { stage: "selection_started", actorId: actor.id, message: `selection engine — ${actor.id} is deciding…` });
    const selection = await turnDeps.selectionEngine.select(world, actor.id, proposal.suggestions);
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
          const repick = await turnDeps.selectionEngine.select(world, actor.id, filtered);
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

  logger.log({
    module: "turn",
    event: "action_chosen",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    output: action,
  });

  report(turnDeps, { stage: "consequence_started", actorId: action.actorId, message: `consequence engine — resolving "${action.text.slice(0, 60)}${action.text.length > 60 ? "…" : ""}"…` });
  let consequence = await resolveWithValidation(world, action, turnDeps, {
    // Exp-5 item 6: the liveness floor rewrites failed turns — never the
    // user's own action text. In autonomous mode every actor is an NPC, so
    // the floor applies to all of them.
    allowLiveness: turnDeps.forceAllNpc === true || action.actorId !== world.userActorId,
  });
  report(turnDeps, { stage: "validation_done", actorId: action.actorId, message: "consequence validated" });

  // Phase 3 post-hooks (behind flags, default OFF): observer triage drops
  // thought/emotion patches for triaged-out observers, and the salience
  // gate drops low-salience model memory/belief appends. Skipped for
  // fallback consequences ("Nothing changes." carries nothing to gate).
  if (turnDeps.laya !== undefined && !isFallbackConsequence(consequence)) {
    consequence = await applyLayaPostHooks(turnDeps.laya, world, action, consequence, config, logger);
  }

  // Exp-4 item 6: mark fallback history as un-applied so proposals ground
  // on the world, not the wish. Exp-5 item 2: salvaged/liveness turns
  // record the narrative (what happened) plus the honest note — never the
  // raw action text — so later turns don't assume a dropped desk question
  // was asked or a laptop setup happened.
  // F18: applyConsequence mutates the turn-start snapshot in place —
  // no second clone.
  const patched = applyConsequence(world, consequence, action, config, {
    fallback: isFallbackConsequence(consequence),
    honestHistoryNote: getHonestHistoryNote(consequence),
  }, turnSnapshot);
  report(turnDeps, { stage: "patch_applied", actorId: action.actorId, message: "world updated" });
  logger.log({
    module: "turn",
    event: "patch_applied",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    input: { consequence, action },
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
