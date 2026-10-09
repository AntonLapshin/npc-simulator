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
import type { IntentResult } from "../core/intent.js";
import type { TurnClamp } from "../core/clamp.js";
import type { PlannedPose } from "../core/text.js";

export interface ProposalEngine {
  propose(world: World, actorId: string): Promise<ProposalResult>;
  /**
   * Phase 6: true when propose() performs provider (LLM) calls. Local
   * engines — the Laya cascade, deterministic stubs, mocks — leave it
   * unset: the turn budget counter only counts provider-backed
   * invocations, so local decision paths cost nothing.
   */
  readonly providerBacked?: boolean;
}

export interface SelectionEngine {
  select(world: World, actorId: string, suggestions: string[]): Promise<SelectionResult>;
  /**
   * Phase 6: true when select() performs provider (LLM) calls.
   * See ProposalEngine.providerBacked.
   */
  readonly providerBacked?: boolean;
}

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
   * in the turn budget's proposal slot. See ProposalEngine.providerBacked.
   */
  readonly providerBacked?: boolean;
}

/**
 * Stage 3 C2/C3: one fallback delegation performed by a wrapping engine.
 */
export type EngineDelegation = {
  /** Why the wrapper delegated (the fail() cause). */
  cause: string;
  /** True when the fallback engine performs provider (LLM) calls. */
  providerBacked: boolean;
};

/**
 * Stage 3 C2/C3: an engine that wraps a fallback engine and may delegate
 * to it mid-call (the Laya cascade engines delegating to their LLM
 * fallback when the cascade fails or is under-confident).
 *
 * The wrapper records each delegation so the orchestrator can (a) count
 * the delegated provider call in the turn budget — the wrapper itself is
 * local, so the plain providerBacked note() skips it — and (b) log the
 * delegation cause for post-hoc attribution. Undefined when the last
 * invocation did not delegate; reset at the start of every invocation.
 */
export interface DelegatingEngine {
  readonly lastDelegation: EngineDelegation | undefined;
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
  /**
   * PLAN_V2 Phase 4: true on the v2 path — the narrate prompt is built
   * from the executed facts (not the intended action), and the
   * orchestrator accepts the render after one retry instead of falling
   * back. Unset/false = the legacy consequence prompt and the
   * retry→liveness→fallback behavior (v1, unchanged).
   */
  narrateExecutedFacts?: boolean;
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
   * (LLM) calls. See ProposalEngine.providerBacked.
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
