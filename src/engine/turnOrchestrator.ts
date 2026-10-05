import type {
  Action,
  ConsequenceResult,
  EngineConfig,
  World,
} from "../types.js";
import { defaultConfig } from "../config.js";
import type {
  ConsequenceEngine,
  ProposalEngine,
  SelectionEngine,
} from "../intelligence/types.js";
import { applyConsequence } from "./patchApplier.js";
import { validateConsequence } from "./physicalValidator.js";
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

/** Resolve with validation retries; applies fallback when retries are exhausted. */
export async function resolveWithValidation(
  world: World,
  action: Action,
  deps: EngineDependencies,
): Promise<ConsequenceResult> {
  const config = depsConfig(deps);
  const logger = deps.logger;
  let feedback: string | undefined;

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
    const validation = validateConsequence(world, result, action);
    if (validation.valid) {
      logger.log({
        module: "validator",
        event: "validation_passed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, result, attempt },
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
      input: { action, result, attempt },
      validationErrors: validation.errors,
    });

    feedback = `Previous consequence output was invalid:\n${validation.errors.map((e) => `- ${e}`).join("\n")}\nReturn corrected JSON only.`;
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
    action = { actorId: actor.id, text: selection.action };
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
