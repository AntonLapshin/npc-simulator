import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  World,
} from "../types.js";
import type { MovementOutcome } from "../engine/movementExecutor.js";
import type { ManipulationOutcome } from "../engine/manipulationExecutor.js";
import type { IntentResult } from "../core/intent.js";
import type { TurnClamp } from "../core/clamp.js";
import type { PlannedPose } from "../core/text.js";

/**
 * PLAN_V2 Phase 1: the intent call — one structured LLM call that decides
 * the actor's next action directly ({ action, quote }), replacing the
 * proposal+selection option set. The engine executes the returned intent;
 * on failure the engine falls back deterministically (FALLBACK_INTENT).
 */
export interface IntentEngine {
  intent(world: World, actorId: string): Promise<IntentResult>;
  /**
   * Phase 6: true when intent() performs provider (LLM) calls — counted
   * in the turn budget's proposal slot. Local engines (mocks) leave it
   * unset: the turn budget counter only counts provider-backed
   * invocations, so local paths cost nothing.
   */
  readonly providerBacked?: boolean;
}

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
  /**
   * PLAN_V2 Phase 3: the turn's attempted-vs-executed clamp record (v2
   * only). Engines surface it to the model as the honest-gap facts to
   * narrate — "she reaches for his hand, but he's across the room" —
   * instead of silent drops or (not done) sentinels. Null = computed, no
   * gap; undefined = unknown (v1 and older callers — no clamp block in
   * the prompt).
   */
  clamp?: TurnClamp | null;
  /**
   * PLAN_V2 Phase 4: engine-executed pose for this turn (computed by the
   * turn orchestrator before the render call). Engines surface it as the
   * executed-pose fact to narrate. Null = no pose change; undefined =
   * unknown (older callers).
   */
  enginePose?: PlannedPose | null;
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
   *
   * Phase 6: `providerBacked` — true when resolve() performs provider
   * (LLM) calls. The turn budget counter only counts provider-backed
   * invocations, so local paths cost nothing.
   */
  readonly providerBacked?: boolean;
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
