// Laya-backed ProposalEngine (Phase 5 of the renderer architecture).
//
// Generates action suggestions with ZERO LLM calls: the static intent
// cascade decides the kind of thing the actor does next, a dynamically
// built target question (options from the live roster/scene — never
// hardcoded) resolves the concrete target, deterministic templates render
// candidate actions, and one final Laya choice picks the exact intent.
// The winning typed intent ({kind, targetId, quote}) is returned on the
// result so the orchestrator can thread it to selection and the engine
// executors with no translation layer.
//
// Any Laya failure — or a below-threshold exact-intent confidence —
// delegates to the injected fallback (LLM proposal when
// LLM_DECISION_FALLBACK=1, the deterministic stub otherwise).

import type { ProposalEngine } from "../intelligence/types.js";
import type { ProposalResult, World } from "../types.js";
import type { Intent } from "./decisionTypes.js";
import { buildIntentState } from "./decisionState.js";
import { runStaticIntentCascade } from "./intentCascade.js";
import { LayaClient } from "./layaClient.js";
import {
  attachTarget,
  buildTargetQuestion,
  describeIntent,
  rankOptionsByProbability,
  renderIntentCandidates,
  resolveTargetId,
  type TargetQuestionKind,
} from "../core/decision.js";
import { answerConfidence, argmaxOption } from "./utils/runnerUtils.js";
import { errorMessage } from "../util/errors.js";

/** Stable question ids (scripted clients in tests answer by id). */
export const TARGET_QUESTION_ID = "intent_target";
export const EXACT_INTENT_QUESTION_ID = "exact_intent";

export type LayaProposalEngineDeps = {
  client: LayaClient;
  /** Confidence floor for the exact-intent pick; below it we delegate. */
  confidenceThreshold?: number;
  /** Slim-state builder (overridable for tests). */
  buildState?: (world: World, actorId: string) => string;
  /** Max suggestions returned (ranked by choice probability). */
  maxSuggestions?: number;
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.55;
const DEFAULT_MAX_SUGGESTIONS = 3;

const TARGET_QUESTION_KINDS: TargetQuestionKind[] = ["speak", "move", "interact"];

export class LayaProposalEngine implements ProposalEngine {
  private readonly client: LayaClient;
  private readonly fallback: ProposalEngine;
  private readonly confidenceThreshold: number;
  private readonly buildState: (world: World, actorId: string) => string;
  private readonly maxSuggestions: number;

  constructor(deps: LayaProposalEngineDeps, fallback: ProposalEngine) {
    this.client = deps.client;
    this.fallback = fallback;
    this.confidenceThreshold = deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.buildState = deps.buildState ?? buildIntentState;
    this.maxSuggestions = Math.max(1, deps.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS);
  }

  /**
   * Phase 3 (intent-first) compatible: when the orchestrator already ran
   * the intent cascade, pass its intent here to skip the redundant
   * cascade — target resolution, candidate rendering, and the exact-intent
   * choice still run. Omitted/undefined runs the static cascade inline.
   */
  async propose(
    world: World,
    actorId: string,
    intent?: Intent,
  ): Promise<ProposalResult> {
    const state = this.buildState(world, actorId);
    const fail = (reason: string): Promise<ProposalResult> =>
      this.fallback.propose(world, actorId).then((fb) => ({
        ...fb,
        reasoning: `laya proposal: ${reason}; fallback: ${fb.reasoning}`,
      }));

    // Step 1: intent cascade (kind -> targetKind -> manner). Static only —
    // the dynamic planner burns an LLM call, incompatible with the
    // zero-LLM decision path.
    let cascadeIntent: Intent;
    try {
      cascadeIntent = intent ?? (await runStaticIntentCascade(this.client, state));
    } catch (err) {
      return fail(`intent cascade failed (${errorMessage(err)})`);
    }

    // Step 2: dynamic target resolution — the cascade's question sets are
    // built from the live roster/scene, not hardcoded.
    let typed: Intent = cascadeIntent;
    if (
      cascadeIntent.targetId === undefined &&
      TARGET_QUESTION_KINDS.includes(cascadeIntent.kind as TargetQuestionKind) &&
      cascadeIntent.targetKind !== undefined &&
      cascadeIntent.targetKind !== "none"
    ) {
      const question = buildTargetQuestion(
        cascadeIntent.kind as TargetQuestionKind,
        cascadeIntent.targetKind,
        world,
        actorId,
      );
      if (question !== null) {
        try {
          const answers = await this.client.decide(state, {
            [TARGET_QUESTION_ID]: question,
          });
          const answer = answers[TARGET_QUESTION_ID];
          if (!answer || answer.type !== "choice") {
            throw new Error("missing intent_target answer");
          }
          const target = resolveTargetId(
            world,
            actorId,
            cascadeIntent.targetKind,
            answer.winner,
          );
          if (target === undefined) {
            return fail(
              `target "${answer.winner}" resolved to no roster/scene id`,
            );
          }
          typed = attachTarget(cascadeIntent, target, cascadeIntent.targetKind);
        } catch (err) {
          return fail(`target resolution failed (${errorMessage(err)})`);
        }
      }
    }

    // Step 3: deterministic candidate rendering (parser-inverse templates).
    const candidates = renderIntentCandidates(world, actorId, typed);
    if (candidates.length === 0) {
      return fail("no candidates rendered for the decided intent");
    }

    // Step 4: exact-intent choice over the candidates (one Laya call).
    let winner: string;
    let probabilities: Record<string, number>;
    let confidence: number;
    try {
      const answers = await this.client.decide(state, {
        [EXACT_INTENT_QUESTION_ID]: {
          type: "choice",
          instructions:
            `Which action best fits what ${world.actors.find((a) => a.id === actorId)?.name ?? actorId} ` +
            `should do next? Pick the single most fitting option.`,
          options: candidates,
        },
      });
      const answer = answers[EXACT_INTENT_QUESTION_ID];
      if (!answer || answer.type !== "choice") {
        throw new Error("missing exact_intent answer");
      }
      winner = argmaxOption(answer.probabilities, candidates);
      probabilities = answer.probabilities;
      confidence = answerConfidence(answer, candidates.length);
    } catch (err) {
      return fail(`exact-intent choice failed (${errorMessage(err)})`);
    }

    if (confidence < this.confidenceThreshold) {
      return fail(
        `exact-intent "${winner}" @${confidence.toFixed(2)} < threshold ${this.confidenceThreshold}`,
      );
    }

    const ranked = rankOptionsByProbability(probabilities, candidates);
    return {
      suggestions: ranked.slice(0, this.maxSuggestions),
      reasoning:
        `laya: ${describeIntent(typed, world, actorId)} ` +
        `confidence=${confidence.toFixed(2)}`,
      intent: typed,
    };
  }
}
