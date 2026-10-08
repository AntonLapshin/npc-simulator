// Real Consequence Engine backed by an LLM (Milestone 2, §16.2).
//
// Interprets free-form action text against the FULL objective world and
// returns narrative + actor/object patches. The optional `feedback`
// carries validation errors from a previous attempt (§16.5 / turn
// orchestrator retry loop) and is embedded in the context, so the model
// can correct unknown ids or impossible movement. Parse failures retry
// internally; physically invalid output is retried by the orchestrator;
// total failure yields the §16.5 "Nothing changes." fallback.

import type { ConsequenceEngine } from "../intelligence/types.js";
import type { Action, ConsequenceResult, World } from "../types.js";
import { consequenceResultSchema } from "../schemas.js";
import { buildConsequenceContext } from "../engine/contextBuilder.js";
import { buildPropHint } from "../engine/textHints.js";
import type { Logger } from "../logging/logger.js";
import type { LLMProvider } from "./provider.js";
import { LLM_SYSTEM_PROMPT, CONSEQUENCE_OUTPUT_SCHEMA, consequenceSuffix } from "./prompts.js";
import { completeJson } from "./complete.js";

export const FALLBACK_CONSEQUENCE: ConsequenceResult = {
  narrative: "Nothing changes.",
  actorPatches: [],
  objectPatches: [],
  reasoning: "Fallback due to engine failure.",
};

export type LlmConsequenceEngineOptions = {
  /** Parse-retry budget (§16.3). Defaults to 3 (matches default EngineConfig). */
  maxRetries?: number;
};

export class LLMConsequenceEngine implements ConsequenceEngine {
  constructor(
    private readonly logger: Logger,
    private readonly provider: LLMProvider,
    private readonly options: LlmConsequenceEngineOptions = {},
  ) {}

  /**
   * Exp-6 item 4: diagnostics for the "valid-JSON-at-all-costs" salvage
   * tier. The turn orchestrator reads these after resolve() to tell a
   * format collapse (nothing ever parsed) apart from a parsed-but-invalid
   * result. Empty when the last call parsed cleanly.
   */
  private lastRawAttempts: string[] = [];
  private lastParsed = false;

  public getLastRawAttempts(): string[] {
    return [...this.lastRawAttempts];
  }

  public lastResolveParsed(): boolean {
    return this.lastParsed;
  }

  /**
   * Exp-6 item 2 (S3): user-turn directive. User turns bypass the
   * proposal/selection pipeline entirely — the action text IS the human
   * player's own words, not a suggestion to improve. Say so up front so
   * the writer preserves quoted/uttered speech verbatim instead of
   * substituting a generic beat (exp-6: 0/10 user turns kept their typed
   * speech; the stub attractor filled the gap).
   */
  static readonly USER_TURN_DIRECTIVE =
    "USER TURN: the action text below was typed by the human player — it is the ground truth " +
    "for this turn, not a suggestion. Preserve their uttered/quoted words VERBATIM in the " +
    "narrative (never substitute a generic greeting or different dialogue); narrate their " +
    "movement honestly from their text. Their speech outranks any example phrasing in these instructions.";

  async resolve(
    world: World,
    action: Action,
    feedback?: string,
    opts?: { signal?: AbortSignal; isUserTurn?: boolean },
  ): Promise<ConsequenceResult> {
    const startedAt = Date.now();
    const maxRetries = this.options.maxRetries ?? 3;
    // Exp-3 item 12: first attempts get the short core prompt (identity +
    // roster + movement + speech + turn discipline + minimal field rules);
    // retries get the full rule text plus validation feedback, where the
    // rarely-firing rules (arrival radius, mask lists) actually help.
    // Item C1: pass the real roster ids so the suffix carries the
    // roster-discipline line (retrieval beats recall for small models).
    const suffix = consequenceSuffix(
      feedback ? "full" : "short",
      world.actors.map((a) => a.id),
    );
    // Exp-2 item 4: prop auto-hint — when the action text carries
    // prop-bearing activity (typing→laptop, sipping→cup), name the exact
    // roster object ids up front so the model emits the patch convention
    // instead of inventing holder ids. Inserted before the protected
    // instruction tail (suffix), which stays last for F33 truncation
    // safety. Deterministic per action, so retries repeat it harmlessly.
    const propHint = buildPropHint(action.text, world, action.actorId);
    const context = buildConsequenceContext(world, action, feedback);
    // Exp-6 item 2: user-turn directive leads the prompt (before the
    // world dump) so the writer treats the player's words as sacred.
    const userTurnPrefix =
      opts?.isUserTurn === true ? `${LLMConsequenceEngine.USER_TURN_DIRECTIVE}\n\n` : "";
    const userPrompt =
      propHint !== undefined
        ? `${userTurnPrefix}${context}\n\n${propHint}\n\n${suffix}`
        : `${userTurnPrefix}${context}\n\n${suffix}`;

    const result = await completeJson({
      logger: this.logger,
      provider: this.provider,
      module: "consequence",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      systemPrompt: LLM_SYSTEM_PROMPT,
      userPrompt,
      input: { action, feedback },
      maxRetries,
      schema: consequenceResultSchema,
      schemaText: CONSEQUENCE_OUTPUT_SCHEMA,
      // F33: protected instruction tail — kept intact if the input cap
      // truncates the world-dump portion of the prompt.
      suffix,
      // F28: turn-deadline signal — aborts the hung provider call on timeout.
      signal: opts?.signal,
      repairHint:
        "Field rules: actorPatches must be an array of {\"actorId\": ...} (never \"id\", never a quoted string); " +
        "objectPatches must be an array of {\"objectId\": ...} (never \"id\", never a quoted string); " +
        "\"reasoning\" is required; do not nest objectPatches inside actorPatches.",
    });
    this.lastParsed = result.ok;
    this.lastRawAttempts = result.ok ? [] : [...result.rawAttempts];

    if (!result.ok) {
      this.logger.log({
        module: "consequence",
        event: "consequence_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action, feedback },
        prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
        rawResponse: result.lastRaw,
        // F31: usage from the last attempt, when the backend reported it.
        usage: result.usage,
        error: `fallback: ${result.error}`,
        durationMs: Date.now() - startedAt,
      });
      return structuredClone(FALLBACK_CONSEQUENCE);
    }

    this.logger.log({
      module: "consequence",
      event: "consequence_completed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
      promptChars: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`.length,
      promptTokensEstimate: Math.ceil(`${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`.length / 4),
      rawResponse: result.raw,
      parsedResponse: result.value,
      reasoning: result.value.reasoning,
      // F31: per-call usage captured from the chat-completions response.
      usage: result.usage,
      output: result.value,
      durationMs: Date.now() - startedAt,
    });
    return result.value;
  }
}
