import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  EngineConfig,
  World,
} from "../types.js";
import { defaultConfig } from "../config.js";
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
  suggestMoveTarget,
} from "./movementAssist.js";
import { validateSelectionForActor } from "./contextBuilder.js";
import { buildObjectAffordanceNudge } from "./contextBuilder.js";
import { FALLBACK_SELECTION } from "../llm/llmSelectionEngine.js";
import { MockSemanticJudge } from "../mocks/mockSemanticJudge.js";
import { advanceTurn, getCurrentActor, incrementTick } from "./worldStore.js";
import { defaultSavePath, saveWorld } from "./persistence.js";
import {
  getHonestHistoryNote,
  isFallbackConsequence,
  isSpeechOnlyFailure,
  salvageFormatCollapse,
  trySalvageConsequence,
} from "./turnSalvage.js";
import { buildLivenessConsequence, consecutiveFallbacks } from "./turnLiveness.js";
import type { Logger } from "../logging/logger.js";
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
  /** Optional save hook (defaults to file persistence when autosave is on). */
  onAutosave?: (world: World) => Promise<void> | void;
  /** Optional progress hook for UIs to show a loading indicator during slow LLM calls. */
  onProgress?: (event: TurnProgressEvent) => void;
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
 * Exp-6 item 3: race a promise against the turn's remaining time budget.
 * The underlying work keeps running in the background (a promise cannot
 * be cancelled) — its late result is simply ignored and the turn moves on
 * to salvage instead of burning more wall time.
 */
function withTurnDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("turn deadline exceeded")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
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

  // Exp-6 item 3: total turn wall-time budget for the consequence phase. A
  // turn burned 47 minutes in Exp-6 with no circuit breaker — when the
  // deadline hits, the turn stops burning LLM calls and falls through to
  // salvage → liveness → fallback.
  const turnTimeoutMs = config.turnTimeoutMs ?? 600_000;
  const deadlineAt = Date.now() + turnTimeoutMs;
  const timeLeft = (): number => deadlineAt - Date.now();
  let deadlineExceeded = false;

  // Exp-6 item 6: the semantic judge classifies the ACTION text —
  // independent of the consequence result — so start it once, concurrently
  // with the first consequence call, and reuse it across retry attempts
  // instead of re-running a judge LLM call per attempt.
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

  for (let attempt = 1; attempt <= Math.max(1, config.maxRetries + 1); attempt++) {
    if (timeLeft() <= 0) {
      deadlineExceeded = true;
      break;
    }
    let result: ConsequenceResult;
    try {
      result = await withTurnDeadline(
        deps.consequenceEngine.resolve(world, action, feedback),
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
      if (attempt > config.maxRetries) break;
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
    // Judge output is logged per turn
    // (semantic_resolved/semantic_completed) for observability, like
    // selection_completed.
    const resolved = await resolveActionSemantics(
      world,
      action,
      result,
      judgeForAttempt(),
      logger,
    );
    lastResult = result;
    lastSemantics = resolved.semantics;
    const validation = validateConsequence(world, result, action, resolved.semantics);
    if (validation.valid) {
      logger.log({
        module: "validator",
        event: "validation_passed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, result, attempt, semanticsSource: resolved.source, semantics: resolved.semantics },
        output: validation,
      });
      return result;
    }

    logger.log({
      module: "validator",
      event: "validation_failed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { action, result, attempt, semanticsSource: resolved.source, semantics: resolved.semantics },
      validationErrors: validation.errors,
    });

    // Deterministic movement repair: small LLMs often narrate movement
    // correctly but omit the required x/y patch on every retry. When the
    // failure is movement-only and we can compute a valid closer position,
    // patch it in directly instead of burning retries on a "Nothing
    // changes." fallback. The narrative already describes the movement, so
    // filling in coordinates preserves intent.
    let movementHint: string | undefined;
    if (resolved.semantics?.moves) {
      const suggestion = suggestMoveTarget(
        world,
        action.actorId,
        resolved.semantics.destinationActorId,
        resolved.semantics.destinationObjectId,
      );
      if (suggestion) {
        const dest = resolved.semantics.destinationActorId
          ? ` strictly closer to ${resolved.semantics.destinationActorId}`
          : resolved.semantics.destinationObjectId
            ? ` strictly closer to ${resolved.semantics.destinationObjectId}`
            : "";
        movementHint =
          `Movement hint: emit actorPatch {"actorId": "${action.actorId}", "x": ${suggestion.x}, "y": ${suggestion.y}, ...}` +
          ` — position (${suggestion.x}, ${suggestion.y}) is reachable and${dest ? dest : " a valid step"} from the current position. ` +
          `Set effects.moved=true${resolved.semantics.destinationActorId ? ` and effects.destinationActorId="${resolved.semantics.destinationActorId}"` : ""}${resolved.semantics.destinationObjectId ? ` and effects.destinationObjectId="${resolved.semantics.destinationObjectId}"` : ""}.`;
        if (isMovementOnlyFailure(validation.errors)) {
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
            if (resolved.semantics.destinationActorId !== undefined) {
              repaired.effects.destinationActorId = resolved.semantics.destinationActorId;
            }
            if (resolved.semantics.destinationObjectId !== undefined) {
              repaired.effects.destinationObjectId = resolved.semantics.destinationObjectId;
            }
          }
          // Re-validate against the same judged semantics (effects may now
          // agree with the judge — either way the movement gate must pass).
          const revalidation = validateConsequence(
            world,
            repaired,
            action,
            resolved.semantics,
          );
          if (revalidation.valid) {
            logger.log({
              module: "validator",
              event: "validation_passed",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              input: { action, result: repaired, attempt, semanticsSource: resolved.source, semantics: resolved.semantics },
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
      const capHit = validation.errors.some((e) => /at most 6 cells/i.test(e));
      if (capHit && isClampableMovementFailure(validation.errors)) {
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
            resolved.semantics,
          );
          if (revalidation.valid) {
            logger.log({
              module: "validator",
              event: "validation_passed",
              tick: world.tick,
              turnIndex: world.turnIndex,
              actorId: action.actorId,
              input: { action, result: clampedResult, attempt, semanticsSource: resolved.source, semantics: resolved.semantics },
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

    // Phase 4 "retry only prose": when the patches are valid and only the
    // narrative prose fails (speech nit, possibly plus droppable
    // hallucinated patches), say so explicitly — otherwise the retry
    // regenerates everything and often loses the good movement it just had
    // (ticks 3/9). This hint costs nothing when the model already retries
    // cleanly; after retries are exhausted the salvage path below applies
    // the same split (keep patches, warn on speech).
    let proseHint: string | undefined;
    if (isSpeechOnlyFailure(validation.errors)) {
      proseHint =
        "The patches are valid — keep every actorPatch/objectPatch exactly as-is and fix ONLY the narrative prose (preserve the action's exact wording).";
    } else if (validation.errors.some((e) => /unknown (actor|object) id/.test(e))) {
      proseHint =
        "Drop patches that reference unknown ids, keep the remaining valid patches exactly as-is, and fix the narrative prose.";
    }

    // Exp-6 item 8: when the failure is a missing object/prop/pose patch
    // for a manipulated object, demand that patch explicitly (naming the
    // object) instead of only punishing its absence after the fact.
    const objectAffordanceHint =
      affordanceNudge !== undefined &&
      validation.errors.some((e) => /object ?patch|\bprop\b|\bpose\b/i.test(e))
        ? affordanceNudge
        : undefined;

    feedback = `Previous consequence output was invalid:\n${validation.errors.map((e) => `- ${e}`).join("\n")}${proseHint ? `\n${proseHint}` : ""}${movementHint ? `\n${movementHint}` : ""}${objectAffordanceHint ? `\n${objectAffordanceHint}` : ""}\nReturn corrected JSON only.`;
    if (attempt > config.maxRetries) break;
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
      validationErrors: validation.errors,
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
    const degraded = salvageFormatCollapse(world, action, turnRawAttempts);
    if (degraded) {
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

  // Exp-3 item 6: before giving up to "Nothing changes.", try to salvage
  // the last attempt — keep valid movement/patches, warn on speech nits.
  // Exp-4 item 8: the evaluation (eligible/ineligible + reason) is logged
  // inside trySalvageConsequence as `salvage_evaluated`.
  if (lastResult && lastSemantics) {
    const salvage = trySalvageConsequence(world, action, lastResult, lastSemantics, logger);
    if (salvage) {
      logger.log({
        module: "turn",
        event: "partial_applied",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, result: lastResult },
        output: { salvaged: salvage.salvaged, warnings: salvage.warnings },
        ...(salvage.warnings.length > 0
          ? { error: `speech warnings (applied anyway): ${salvage.warnings.join(" | ")}` }
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
  return structuredClone(FALLBACK_CONSEQUENCE);
}

async function autosave(world: World, deps: EngineDependencies): Promise<void> {
  const config = depsConfig(deps);
  if (!config.autosaveEnabled) return;
  try {
    if (deps.onAutosave) {
      await deps.onAutosave(world);
    } else {
      await saveWorld(defaultSavePath(config.saveDir, world.id, world.tick), world, deps.logger);
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

  logger.log({
    module: "turn",
    event: "turn_started",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: actor.id,
    input: { world: structuredClone(world) },
  });

  report(deps, { stage: "turn_started", actorId: actor.id, message: `turn started — ${actor.id} (tick ${world.tick})` });
  report(deps, { stage: "proposal_started", actorId: actor.id, message: `proposal engine — generating suggestions for ${actor.id}…` });

  let action: Action;
  if (actor.id === world.userActorId) {
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
    report(deps, { stage: "proposal_done", actorId: actor.id, message: `proposal skipped (user turn)` });
    report(deps, { stage: "waiting_user_input", actorId: actor.id, message: "waiting for your action…" });
    if (!deps.getUserAction) {
      throw new Error("getUserAction is required for user-controlled turns");
    }
    const userText = await deps.getUserAction(actor.id, []);
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
    const proposal = await deps.proposalEngine.propose(world, actor.id);
    report(deps, { stage: "proposal_done", actorId: actor.id, message: `proposal engine done (${proposal.suggestions.length} suggestions)` });
    report(deps, { stage: "selection_started", actorId: actor.id, message: `selection engine — ${actor.id} is deciding…` });
    const selection = await deps.selectionEngine.select(world, actor.id, proposal.suggestions);
    report(deps, { stage: "selection_done", actorId: actor.id, message: `selection engine done — action chosen` });
    let actionText = stripSelectionPrefix(selection.action);
    // Exp-5 items 5+7: screen the pick BEFORE burning consequence attempts
    // on it. A POV-swapped pick ("Anton walks…" on Dana's turn) or a
    // verb+noun repeat of a recent own action (handshake attractor) is
    // rejected here and replaced with the first clean candidate — the
    // proposal engine already dedups its own output, but the selector may
    // invent a repeat (or a mock may replay one).
    const rejection = validateSelectionForActor(world, actor.id, actionText);
    if (rejection !== undefined) {
      logger.log({
        module: "selection",
        event: "selection_rejected",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: actor.id,
        input: { action: actionText, suggestions: proposal.suggestions },
        output: { rejection },
        error: rejection,
      });
      const clean = proposal.suggestions
        .map((s) => stripSelectionPrefix(s))
        .find((s) => s.length > 0 && validateSelectionForActor(world, actor.id, s) === undefined);
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
  }

  logger.log({
    module: "turn",
    event: "action_chosen",
    tick: world.tick,
    turnIndex: world.turnIndex,
    actorId: action.actorId,
    output: action,
  });

  report(deps, { stage: "consequence_started", actorId: action.actorId, message: `consequence engine — resolving "${action.text.slice(0, 60)}${action.text.length > 60 ? "…" : ""}"…` });
  const consequence = await resolveWithValidation(world, action, deps, {
    // Exp-5 item 6: the liveness floor rewrites failed turns — never the
    // user's own action text.
    allowLiveness: action.actorId !== world.userActorId,
  });
  report(deps, { stage: "validation_done", actorId: action.actorId, message: "consequence validated" });

  // Exp-4 item 6: mark fallback history as un-applied so proposals ground
  // on the world, not the wish. Exp-5 item 2: salvaged/liveness turns
  // record the narrative (what happened) plus the honest note — never the
  // raw action text — so later turns don't assume a dropped desk question
  // was asked or a laptop setup happened.
  const patched = applyConsequence(world, consequence, action, config, {
    fallback: isFallbackConsequence(consequence),
    honestHistoryNote: getHonestHistoryNote(consequence),
  });
  report(deps, { stage: "patch_applied", actorId: action.actorId, message: "world updated" });
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

  const ticked = incrementTick(patched);
  const nextWorld = advanceTurn(ticked);

  logger.log({
    module: "turn",
    event: "turn_completed",
    tick: nextWorld.tick,
    turnIndex: nextWorld.turnIndex,
    actorId: action.actorId,
    output: structuredClone(nextWorld),
  });

  await autosave(nextWorld, deps);
  report(deps, { stage: "turn_completed", actorId: action.actorId, message: "turn completed" });
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
