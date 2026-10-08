// Real Proposal Engine backed by an LLM (Milestone 2, §16.2).
//
// Builds the subjective actor context (only what this actor perceives,
// remembers, believes, and knows), calls the provider, parses/validates
// the JSON, retries on parse failure, and falls back to §16.5
// suggestions so the simulation never deadlocks.

import type { ProposalEngine } from "../intelligence/types.js";
import type { ProposalResult, World } from "../types.js";
import type { Intent } from "../decision/decisionTypes.js";
import { proposalResultSchema } from "../schemas.js";
import {
  buildProposalContext,
  detectIdentityLeak,
  findCoreRepeat,
} from "../engine/contextBuilder.js";
import type { Logger } from "../logging/logger.js";
import type { LLMProvider } from "./provider.js";
import { LLM_SYSTEM_PROMPT, PROPOSAL_OUTPUT_SCHEMA, proposalSuffix } from "./prompts.js";
import { completeJson } from "./complete.js";

export const FALLBACK_PROPOSAL: ProposalResult = {
  suggestions: ["Stay where you are.", "Look around.", "Do nothing."],
  reasoning: "Fallback due to engine failure.",
};

export type LlmProposalEngineOptions = {
  /** Parse-retry budget (§16.3). Defaults to 3 (matches default EngineConfig). */
  maxRetries?: number;
  /** Recent-history entries in the proposal prompt. Defaults to proposalHistoryLimit (20). */
  historyLimit?: number;
  /** Max suggestions requested. Defaults to maxProposalSuggestions (10). */
  maxSuggestions?: number;
  /** Min usable suggestions per turn; fewer triggers a format retry. Defaults to 2. */
  minSuggestions?: number;
};

/** Minimum suggestions that count as a usable option set (tick 17 returned 1). */
export const MIN_PROPOSAL_SUGGESTIONS = 2;

/**
 * Phase 3 (intent-first): one-line directive narrowing the proposal prompt
 * to the Laya-decided intent, e.g. intent kind=speak + targetKind=actor →
 * "suggest things the actor could SAY to one specific person present".
 * Pure.
 */
export function intentDirective(intent: Intent): string {
  const manner =
    intent.manner !== undefined && intent.manner.trim().length > 0
      ? ` (${intent.manner})`
      : "";
  switch (intent.kind) {
    case "speak": {
      const target =
        intent.targetKind === "actor"
          ? " to one specific person present"
          : intent.targetKind === "none"
            ? " aloud, to no one in particular"
            : "";
      return `suggest things the actor could SAY${target}${manner} — speech only, no movement or object manipulation`;
    }
    case "move": {
      const target =
        intent.targetKind === "landmark"
          ? " toward a specific place"
          : intent.targetKind === "actor"
            ? " toward someone"
            : intent.targetKind === "none"
              ? ", wandering aimlessly"
              : "";
      return `suggest where or how the actor could MOVE${target}${manner} — movement only, no speech`;
    }
    case "interact":
      return `suggest how the actor could USE a nearby object${manner} — object interaction only, no speech or locomotion`;
    case "gesture":
      return `suggest a physical gesture the actor could make${manner} — gesture only, no speech or locomotion`;
    case "wait":
      return `suggest quiet waiting or observing${manner} — the actor does nothing conspicuous`;
  }
}

/**
 * Phase 3 (intent-first): narrow a proposal prompt to the decided intent.
 * The cascade already chose the KIND of thing the actor does next — the
 * generator's job is only to enumerate fitting candidates. Pure.
 */
export function buildNarrowedProposalPrompt(
  intent: Intent,
  basePrompt: string,
): string {
  return [
    "DECIDED INTENT — the Laya decision cascade already chose what kind of thing the actor does next. Do not re-decide it; narrow every suggestion to fit:",
    intentDirective(intent),
    "",
    basePrompt,
  ].join("\n");
}

function normalizeSuggestions(suggestions: unknown): string[] {
  if (!Array.isArray(suggestions)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of suggestions) {
    if (typeof s !== "string") continue;
    // Strip echoed numbering the model sometimes adds ("3. Do X").
    const cleaned = s.replace(/^\s*\d+\s*[.)]\s*/, "").trim();
    if (cleaned.length === 0) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

export class LLMProposalEngine implements ProposalEngine {
  constructor(
    private readonly logger: Logger,
    private readonly provider: LLMProvider,
    private readonly options: LlmProposalEngineOptions = {},
  ) {}

  /**
   * Phase 3 (intent-first): when the turn's intent cascade decided an
   * intent, pass it here to narrow the prompt to that intent ("suggest
   * things Dana could SAY to Anton…"). Omitted/undefined keeps the
   * existing wide-open prompt — the signature stays backward compatible.
   */
  async propose(world: World, actorId: string, intent?: Intent): Promise<ProposalResult> {
    const startedAt = Date.now();
    const maxRetries = this.options.maxRetries ?? 3;

    let userPrompt: string;
    let suffix: string;
    try {
      suffix = proposalSuffix();
      const base = `${buildProposalContext(world, actorId, { historyLimit: this.options.historyLimit, maxSuggestions: this.options.maxSuggestions })}\n\n${suffix}`;
      userPrompt = intent === undefined ? base : buildNarrowedProposalPrompt(intent, base);
    } catch (err) {
      this.logger.log({
        module: "proposal",
        event: "proposal_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        input: { actorId },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
      return structuredClone(FALLBACK_PROPOSAL);
    }

    const result = await completeJson({
      logger: this.logger,
      provider: this.provider,
      module: "proposal",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      systemPrompt: LLM_SYSTEM_PROMPT,
      userPrompt,
      input: { actorId },
      maxRetries,
      schema: proposalResultSchema,
      schemaText: PROPOSAL_OUTPUT_SCHEMA,
      // F33: protected instruction tail — kept intact if the input cap
      // truncates the world-dump portion of the prompt.
      suffix,
      extraCheck: (value) => {
        const cleaned = normalizeSuggestions(value.suggestions);
        if (cleaned.length === 0) return "no usable suggestions";
        const min = this.options.minSuggestions ?? MIN_PROPOSAL_SUGGESTIONS;
        if (cleaned.length < min)
          return `only ${cleaned.length} usable suggestion(s), need at least ${min} — generate a full option set`;
        // Exp-4 item 9: reject POV swaps ("Anton wants…" on Dana's turn) so
        // the retry generates options for the DECIDING actor.
        for (const s of cleaned) {
          const leak = detectIdentityLeak(world, actorId, s);
          if (leak !== undefined)
            return `${leak} — rewrite every suggestion from ${actorId}'s own point of view`;
        }
        if (typeof value.reasoning === "string") {
          const leak = detectIdentityLeak(world, actorId, value.reasoning);
          if (leak !== undefined)
            return `${leak} (in reasoning) — reason about ${actorId}'s own goals only`;
        }
        // Exp-4 item 10: proposal-level dedup — a suggestion whose
        // verb+noun core matches a recent own action (6 handshakes, 6
        // greetings) is a repeat even when reworded.
        for (const s of cleaned) {
          const prior = findCoreRepeat(world, actorId, s);
          if (prior !== undefined)
            return `suggestion "${s.slice(0, 60)}" repeats recent action "${prior.slice(0, 60)}" (same verb+noun core) — propose something that moves the scene forward instead`;
        }
        return undefined;
      },
      repairHint:
        "suggestions must be an array of at least 2 distinct non-empty action sentences (aim for the requested max); " +
        "no numbering prefixes, no empty strings, no duplicates; " +
        "every suggestion must be written from the deciding actor's own point of view (never cast another roster actor as the subject, never attribute their goals); " +
        "no suggestion may repeat the verb+noun core of a recent own action.",
    });

    if (!result.ok) {
      this.logger.log({
        module: "proposal",
        event: "proposal_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        input: { actorId },
        prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
        rawResponse: result.lastRaw,
        // F31: usage from the last attempt, when the backend reported it.
        usage: result.usage,
        error: `fallback: ${result.error}`,
        durationMs: Date.now() - startedAt,
      });
      return structuredClone(FALLBACK_PROPOSAL);
    }

    const fullPrompt = `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`;
    this.logger.log({
      module: "proposal",
      event: "proposal_completed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId,
      prompt: fullPrompt,
      promptChars: fullPrompt.length,
      promptTokensEstimate: Math.ceil(fullPrompt.length / 4),
      rawResponse: result.raw,
      parsedResponse: result.value,
      reasoning: result.value.reasoning,
      // F31: per-call usage captured from the chat-completions response.
      usage: result.usage,
      output: result.value,
      durationMs: Date.now() - startedAt,
    });
    // Normalize before returning: strip numbering, drop empties/dupes,
    // truncate to the requested max so callers always get a clean set.
    const max = this.options.maxSuggestions ?? 10;
    const cleaned = normalizeSuggestions(result.value.suggestions).slice(0, Math.max(1, max));
    return { ...result.value, suggestions: cleaned };
  }
}
