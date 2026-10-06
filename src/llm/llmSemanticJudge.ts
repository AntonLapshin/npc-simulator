// Real SemanticJudge (Decision AI) backed by an LLM (refactor plan §A).
//
// Classifies free-form action meaning — movement intent, addressee
// resolution, speech intent — with a small zod schema + compact prompt
// (actor position, roster names/positions, action text — NOT the full
// world dump). Shares the completeJson retry loop with the other engines.

import type { SemanticJudge } from "../intelligence/types.js";
import type { Action, ActionSemantics, World } from "../types.js";
import { actionSemanticsSchema } from "../schemas.js";
import type { Logger } from "../logging/logger.js";
import type { LLMProvider } from "./provider.js";
import { LLM_SYSTEM_PROMPT } from "./prompts.js";
import { completeJson } from "./complete.js";

/** Compact classification prompt: positions + roster + action text only. */
export function buildSemanticJudgePrompt(world: World, action: Action): string {
  const actor = world.actors.find((a) => a.id === action.actorId);
  const roster = world.actors
    .map((a) => `${a.name} (${a.id}) at (${a.x}, ${a.y})`)
    .join(" | ");
  return [
    "Classify what the action sentence MEANS. Return JSON only.",
    "",
    `Acting actor: ${action.actorId}${actor ? ` (${actor.name}) at (${actor.x}, ${actor.y})` : ""}`,
    `Roster: ${roster || "(none)"}`,
    `Action text: ${action.text}`,
    "",
    "FIELD RULES:",
    "moves=true ONLY when the acting actor's own whole-body locomotion is described",
    "(walk/go/move/run/step/come/approach/enter/leave/follow/join, saunter/drift/sidle/dance over,",
    "roll one's chair, slip out, teleport, or moving closer/toward/next to/beside someone or something).",
    "In-place gestures are NOT movement: turning/looking/shaking or nodding the head, smiling/waving/raising",
    "a hand, reaching/grabbing, sipping/drinking, grunting. Someone ELSE's motion in a subordinate clause",
    "('as he enters') is NOT the acting actor moving. Resuming a task ('return/returning/back to",
    "typing/staring/work/task/focus') is NOT movement — only 'return to <place>' (door/desk/...) is.",
    "Metaphor is NOT movement ('go the extra mile').",
    "destinationActorId: the roster id the acting actor moves toward, ONLY when the action names such an",
    "actor (by name, nickname, or description you can resolve — use pronouns and context); omit otherwise.",
    "It MUST be an exact id from the roster above.",
    "speaks=true when the acting actor utters words or the action explicitly intends speech",
    "(says, murmurs, greets, introduces, asks, shouts, whispers, or quoted dialogue).",
    "quotedSpeech: the canonical uttered segments from the action text (exact quoted strings when the",
    "action quotes them; otherwise the spoken words the action states). Empty array when nothing is said.",
    "",
    'Output Schema: {"moves": boolean, "destinationActorId"?: string, "speaks": boolean, "quotedSpeech": string[]}',
    "Return COMPACT single-line JSON (no pretty-print, no markdown).",
  ].join("\n");
}

export type LlmSemanticJudgeOptions = {
  /** Parse-retry budget. Defaults to 3 (matches default EngineConfig). */
  maxRetries?: number;
};

export class LLMSemanticJudge implements SemanticJudge {
  constructor(
    private readonly logger: Logger,
    private readonly provider: LLMProvider,
    private readonly options: LlmSemanticJudgeOptions = {},
  ) {}

  async classify(world: World, action: Action): Promise<ActionSemantics> {
    const startedAt = Date.now();
    const maxRetries = this.options.maxRetries ?? 3;
    const userPrompt = buildSemanticJudgePrompt(world, action);
    const rosterIds = new Set(world.actors.map((a) => a.id));

    const result = await completeJson({
      logger: this.logger,
      provider: this.provider,
      module: "semantic",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      systemPrompt: LLM_SYSTEM_PROMPT,
      userPrompt,
      input: { action },
      maxRetries,
      schema: actionSemanticsSchema,
      extraCheck: (value) =>
        value.destinationActorId !== undefined && !rosterIds.has(value.destinationActorId)
          ? `unknown destinationActorId: ${value.destinationActorId}`
          : undefined,
      repairHint:
        "destinationActorId must be an exact actor id from the roster (or omit it); " +
        "moves/speaks are booleans; quotedSpeech is an array of strings.",
    });

    if (!result.ok) {
      this.logger.log({
        module: "semantic",
        event: "semantic_failed",
        tick: world.tick,
        turnIndex: world.turnIndex,
        actorId: action.actorId,
        input: { action },
        prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
        rawResponse: result.lastRaw,
        error: `judge unavailable: ${result.error}`,
        durationMs: Date.now() - startedAt,
      });
      throw new Error(`SemanticJudge failed: ${result.error}`);
    }

    this.logger.log({
      module: "semantic",
      event: "semantic_completed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      prompt: `${LLM_SYSTEM_PROMPT}\n\n${userPrompt}`,
      rawResponse: result.raw,
      parsedResponse: result.value,
      reasoning: `moves=${result.value.moves} speaks=${result.value.speaks}`,
      output: result.value,
      durationMs: Date.now() - startedAt,
    });
    return result.value;
  }
}
