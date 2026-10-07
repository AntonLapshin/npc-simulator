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
import { isMovementOnlyFailure, suggestMoveTarget } from "./movementAssist.js";
import { MockSemanticJudge } from "../mocks/mockSemanticJudge.js";
import { advanceTurn, getCurrentActor, incrementTick } from "./worldStore.js";
import { defaultSavePath, saveWorld } from "./persistence.js";
import type { Logger } from "../logging/logger.js";

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

export const FALLBACK_CONSEQUENCE: ConsequenceResult = {
  narrative: "Nothing changes.",
  actorPatches: [],
  objectPatches: [],
  reasoning: "Fallback due to Consequence Engine failure.",
};

function depsConfig(deps: EngineDependencies): EngineConfig {
  return deps.config ?? defaultConfig;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** True when every validation error is a speech-rendering nit (dropped/invented wording). */
export function isSpeechOnlyFailure(errors: string[]): boolean {
  if (errors.length === 0) return false;
  return errors.every((e) => /exact words|invents dialogue/.test(e));
}

/**
 * Exp-3 item 6: partial-apply / salvage instead of all-or-nothing fallback.
 * Ticks 3/9 showed whole good turns (valid movement + adjacency) discarded
 * for a speech nit plus a stray hallucinated patch — and 57% "Nothing
 * changes." is what actually stalls a scenario. Salvage strips patches that
 * reference nonexistent actors/objects (clear hallucinations like a `jeff`
 * patch), revalidates, and:
 * - returns the salvaged result when fully valid, or
 * - returns it with the remaining speech misses downgraded to warnings
 *   (movement + thoughts apply; the speech miss is logged, not fatal).
 * Anything else (physics, movement, contact, addressee, verb-coverage
 * failures) still falls back — salvage never invents positions or speech.
 */
export function trySalvageConsequence(
  world: World,
  action: Action,
  result: ConsequenceResult,
  semantics: ActionSemantics | undefined,
): { salvaged: ConsequenceResult; warnings: string[] } | null {
  if (!semantics) return null;
  const actorIds = new Set(world.actors.map((a) => a.id));
  const objectIds = new Set(world.scene.objects.map((o) => o.id));
  const strippedActor = result.actorPatches.filter((p) => !actorIds.has(p.actorId));
  const strippedObject = result.objectPatches.filter((p) => !objectIds.has(p.objectId));
  if (strippedActor.length === 0 && strippedObject.length === 0) {
    // Nothing salvageable to strip — but a pure speech nit on an otherwise
    // valid turn is still worth applying with a warning.
    const revalidation = validateConsequence(world, result, action, semantics);
    if (revalidation.valid) return { salvaged: result, warnings: [] };
    if (isSpeechOnlyFailure(revalidation.errors)) {
      return { salvaged: result, warnings: revalidation.errors };
    }
    return null;
  }
  const salvaged: ConsequenceResult = {
    ...structuredClone(result),
    actorPatches: result.actorPatches.filter((p) => actorIds.has(p.actorId)),
    objectPatches: result.objectPatches.filter((p) => objectIds.has(p.objectId)),
  };
  // Salvage preserves real effects: the acting actor must remain patched —
  // otherwise the turn's only content was hallucinated (e.g. a lone `ghost`
  // patch) and an emptied husk is no better than the fallback.
  if (!salvaged.actorPatches.some((p) => p.actorId === action.actorId)) {
    return null;
  }
  const revalidation = validateConsequence(world, salvaged, action, semantics);
  if (revalidation.valid) {
    return { salvaged, warnings: [] };
  }
  if (isSpeechOnlyFailure(revalidation.errors)) {
    return { salvaged, warnings: revalidation.errors };
  }
  return null;
}

/** Resolve with validation retries; applies fallback when retries are exhausted. */
export async function resolveWithValidation(
  world: World,
  action: Action,
  deps: EngineDependencies,
): Promise<ConsequenceResult> {
  const config = depsConfig(deps);
  const logger = deps.logger;
  let feedback: string | undefined;
  let lastResult: ConsequenceResult | undefined;
  let lastSemantics: ActionSemantics | undefined;

  for (let attempt = 1; attempt <= Math.max(1, config.maxRetries + 1); attempt++) {
    let result: ConsequenceResult;
    try {
      result = await deps.consequenceEngine.resolve(world, action, feedback);
    } catch (err) {
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
      deps.semanticJudge ?? defaultSemanticJudge,
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
    }

    feedback = `Previous consequence output was invalid:\n${validation.errors.map((e) => `- ${e}`).join("\n")}${movementHint ? `\n${movementHint}` : ""}\nReturn corrected JSON only.`;
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

  // Exp-3 item 6: before giving up to "Nothing changes.", try to salvage
  // the last attempt — keep valid movement/patches, warn on speech nits.
  if (lastResult && lastSemantics) {
    const salvage = trySalvageConsequence(world, action, lastResult, lastSemantics);
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
    action = { actorId: actor.id, text: stripSelectionPrefix(selection.action) };
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
  const consequence = await resolveWithValidation(world, action, deps);
  report(deps, { stage: "validation_done", actorId: action.actorId, message: "consequence validated" });

  const patched = applyConsequence(world, consequence, action, config);
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
