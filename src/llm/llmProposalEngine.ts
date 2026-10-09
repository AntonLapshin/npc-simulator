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
import { CONTACT_RADIUS, distanceToRect } from "../engine/validate/movement.js";
import { OBJECT_INTERACT_RADIUS } from "../engine/validate/objects.js";

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

/**
 * Exp-6 item 4 (M5/S6): renderability-matched proposals. The proposal
 * prompt already says "only suggest renderable actions", but the
 * consequence tier still receives contact/use verbs it cannot ground
 * (handshake ×5, papers-shuffle ×3, chair-push all died in validation).
 * This deterministic post-filter drops suggestions that are
 * unrenderable BY CONSTRUCTION, before selection can pick them:
 * - contact verbs (shake/hug/high-five/hand-over/give/pass) naming a
 *   roster actor farther than CONTACT_RADIUS (2.5) cells away — the
 *   validator's validateContactAdjacency would fail them;
 * - pour/brew/fill verbs with no brew-machine noun in the text AND no
 *   machine within OBJECT_INTERACT_RADIUS (4) cells — telekinetic pours;
 * - sit verbs with no chair/sofa within seating range (1.5 edge cells).
 * Conservative by design: anything ambiguous is kept (fail-open). When
 * filtering would leave fewer than 2 suggestions, the unfiltered list is
 * returned — a turn with options beats a perfectly-filtered empty set.
 * Pure.
 */
export function filterUnrenderableSuggestions(
  world: World,
  actorId: string,
  suggestions: string[],
): { kept: string[]; dropped: Array<{ suggestion: string; reason: string }> } {
  const actor = world.actors.find((a) => a.id === actorId);
  const dropped: Array<{ suggestion: string; reason: string }> = [];
  const kept: string[] = [];
  // Bare "coffee" is the beverage, not a machine. A pour is machine-grounded
  // only when the text names a machine ("coffee machine", "espresso", ...)
  // — exp-6 tick-28: "I pour coffee from the cup into my mouth" hallucinated
  // a pour with no machine in the text and none nearby.
  const machineRe =
    /\b(coffee\s+machine|machine|coffeemaker|espresso|kettle|brewer|dispenser|cooler)\b/i;
  const seatingRe = /chair|sofa/i;
  const contactRe =
    /\b(handshake|shakes?(\s+hands?)?|shook|shaking|shaken|hugs?|hugged|high[\s-]?five|fist[\s-]?bump|hands?\s+(it\s+)?over|gives?|passes?|handing)\b/i;
  const pourRe = /\b(brews?|brewing|pours?|pouring|fills?(?:ing)?|makes?\s+coffee)\b/i;
  const sitRe = /\b(sits?|sitting|sat|takes?\s+a\s+seat)\b/i;

  const mentionsActor = (text: string): { id: string; x: number; y: number } | undefined => {
    const lower = text.toLowerCase();
    for (const a of world.actors) {
      if (a.id === actorId) continue;
      const first = a.name.split(/[^a-z0-9]+/i)[0]?.toLowerCase() ?? "";
      if (
        (a.id.length >= 2 && lower.includes(a.id.toLowerCase())) ||
        (a.name.length >= 2 && lower.includes(a.name.toLowerCase())) ||
        (first.length >= 3 && new RegExp(`\\b${first}\\b`).test(lower))
      ) {
        return { id: a.id, x: a.x, y: a.y };
      }
    }
    return undefined;
  };

  for (const s of suggestions) {
    if (actor === undefined) {
      kept.push(s);
      continue;
    }
    const other = mentionsActor(s);
    if (contactRe.test(s) && other !== undefined) {
      const d = Math.hypot(actor.x - other.x, actor.y - other.y);
      if (d > CONTACT_RADIUS) {
        dropped.push({
          suggestion: s,
          reason: `contact verb with ${other.id} ${d.toFixed(1)} cells away (contact needs ≤ ${CONTACT_RADIUS}) — unrenderable`,
        });
        continue;
      }
    }
    if (pourRe.test(s)) {
      const namesMachine = machineRe.test(s);
      const nearMachine = world.scene.objects.some(
        (o) =>
          /coffee|machine|kettle|brewer|espresso|cooler|dispenser/i.test(`${o.id} ${o.name}`) &&
          Math.hypot(actor.x - (o.x + o.w / 2), actor.y - (o.y + o.h / 2)) <=
            OBJECT_INTERACT_RADIUS,
      );
      if (!namesMachine && !nearMachine) {
        dropped.push({
          suggestion: s,
          reason:
            "pour/brew verb with no brew machine named and none within 4 cells — unrenderable",
        });
        continue;
      }
    }
    if (sitRe.test(s)) {
      const nearSeating = world.scene.objects.some(
        (o) =>
          seatingRe.test(`${o.id} ${o.name}`) &&
          distanceToRect(actor.x, actor.y, o) <= 1.5,
      );
      if (!nearSeating) {
        dropped.push({
          suggestion: s,
          reason: "sit verb with no chair/sofa within 1.5 cells — unrenderable",
        });
        continue;
      }
    }
    kept.push(s);
  }
  // Fail-open: never return fewer than 2 options from filtering alone.
  if (kept.length < 2 && suggestions.length >= 2) {
    return { kept: suggestions, dropped: [] };
  }
  return { kept, dropped };
}

export class LLMProposalEngine implements ProposalEngine {
  /** Phase 6: propose() performs provider calls — counted by the turn budget. */
  readonly providerBacked = true;

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
    // Exp-6 item 4: drop unrenderable-by-construction suggestions before
    // selection can pick them (fail-open: never fewer than 2 options).
    const filtered = filterUnrenderableSuggestions(world, actorId, cleaned);
    if (filtered.dropped.length > 0) {
      this.logger.log({
        module: "proposal",
        event: "proposal_filtered",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId,
        input: { suggestions: cleaned },
        output: {
          kept: filtered.kept,
          dropped: filtered.dropped,
        },
      });
    }
    return { ...result.value, suggestions: filtered.kept };
  }
}
