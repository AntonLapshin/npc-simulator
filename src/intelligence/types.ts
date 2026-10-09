import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  ProposalResult,
  SelectionResult,
  World,
} from "../types.js";
import type { MovementOutcome } from "../engine/movementExecutor.js";
import type { ManipulationOutcome } from "../engine/manipulationExecutor.js";
import type { Intent } from "../decision/decisionTypes.js";

export interface ProposalEngine {
  propose(world: World, actorId: string): Promise<ProposalResult>;
}

export interface SelectionEngine {
  select(world: World, actorId: string, suggestions: string[]): Promise<SelectionResult>;
}

/**
 * Phase 5: selection engines that accept the turn's already-decided
 * intent skip their own intent cascade (the orchestrator's intent-first
 * step or the Laya proposal engine decided it). The parameter is
 * optional — plain SelectionEngine implementations ignore the extra
 * argument at runtime.
 */
export type SelectionEngineWithIntent = SelectionEngine & {
  select(
    world: World,
    actorId: string,
    suggestions: string[],
    intent?: Intent,
  ): Promise<SelectionResult>;
};

export type ConsequenceResolveOpts = {
  signal?: AbortSignal;
  isUserTurn?: boolean;
  /**
   * Phase 1: engine-executed movement for this turn (computed by the turn
   * orchestrator before the render call). Engines surface it to the model
   * as facts to narrate; the model never emits coordinates.
   */
  engineMovement?: MovementOutcome | null;
  /**
   * Phase 2: engine-dictated exact quote for this turn (computed by the
   * turn orchestrator before the render call). Engines surface it to the
   * model as the verbatim contract; the model never invents dialogue.
   * Null = the action carries no quoted speech; undefined = unknown
   * (older callers).
   */
  exactQuote?: string | null;
  /**
   * Phase 3: engine-executed manipulation for this turn (computed by the
   * turn orchestrator before the render call). Engines surface it to the
   * model as facts to narrate; the model never emits objectPatches or
   * prop patches. Null = no manipulation executed; undefined = unknown
   * (older callers).
   */
  engineManipulation?: ManipulationOutcome | null;
};

export interface ConsequenceEngine {
  /**
   * F28: `opts.signal` carries the turn-deadline AbortSignal. Engines
   * forward it to the provider call so a hung LLM request is actually
   * cancelled on timeout instead of burning tokens in the background.
   * Optional — engines that ignore it still satisfy the interface.
   *
   * Exp-6 item 2: `opts.isUserTurn` marks the action text as typed by the
   * human player (ground truth, not a suggestion). Engines that honor it
   * lead with a directive to preserve the user's words verbatim; engines
   * that ignore it still satisfy the interface.
   *
   * Phase 1: `opts.engineMovement` carries the already-executed movement
   * for the render call to narrate.
   *
   * Phase 3: `opts.engineManipulation` carries the already-executed
   * manipulation for the render call to narrate.
   */
  resolve(
    world: World,
    action: Action,
    feedback?: string,
    opts?: ConsequenceResolveOpts,
  ): Promise<ConsequenceResult>;
}

/**
 * Decision-AI judge for free-form action meaning (refactor plan §A).
 * Answers "what did this English sentence *mean*?" — movement intent,
 * addressee resolution, speech intent — so the validator only enforces
 * physics (geometry, schema, turn structure) against the answer.
 */
export interface SemanticJudge {
  classify(world: World, action: Action): Promise<ActionSemantics>;
}
