// Real SemanticJudge (Decision AI) backed by an LLM (refactor plan §A).
//
// Classifies free-form action meaning — movement intent, addressee
// resolution, speech intent — with a small zod schema + compact prompt
// (actor position, roster names/positions, action text — NOT the full
// world dump). Shares the completeJson retry loop with the other engines.

import type { SemanticJudge } from "../intelligence/types.js";
import type { Action, ActionSemantics, World } from "../types.js";
import { actionSemanticsSchema } from "../schemas.js";
import { suggestSimilarIds } from "../engine/physicalValidator.js";
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
  const landmarks = world.scene.objects
    .map((o) => `${o.name} (${o.id}) at (${o.x}, ${o.y}, ${o.w}x${o.h})`)
    .join(" | ");
  return [
    "Classify what the action sentence MEANS. Return JSON only.",
    "",
    `Acting actor: ${action.actorId}${actor ? ` (${actor.name}) at (${actor.x}, ${actor.y})` : ""}`,
    `Roster: ${roster || "(none)"}`,
    `Landmarks: ${landmarks || "(none)"}`,
    `Action text: ${action.text}`,
    "",
    "FIELD RULES (role split: you own ONLY moves/speaks/contact — quotes and",
    "destinations are resolved deterministically from the action text and your",
    "values for them are kept only when they match that resolution, so never invent them):",
    "moves=true ONLY when the acting actor's own whole-body locomotion is described",
    "(walk/go/move/run/step/come/approach/enter/leave/follow/join, saunter/drift/sidle/dance over,",
    "roll one's chair, slip out, teleport, or moving closer/toward/next to/beside someone or something).",
    "In-place gestures are NOT movement: turning/looking/shaking or nodding the head, smiling/waving/raising",
    "a hand, reaching/grabbing, sipping/drinking, grunting. Someone ELSE's motion in a subordinate clause",
    "('as he enters') is NOT the acting actor moving. Resuming a task ('return/returning/back to",
    "typing/staring/work/task/focus') is NOT movement — only 'return to <place>' (door/desk/...) is.",
    "Perception and cognition are NEVER locomotion: looking or glancing anywhere ('look up', 'glance over",
    "notes'), asking questions, sipping/drinking, reviewing notes, preparing questions, typing, thinking,",
    "waiting — none of these move the body, even when the sentence also names a destination.",
    "Approaching, coming to, or joining someone ALREADY within 2.5 cells (compare the positions above) needs",
    "no movement — set moves=false and omit the destination (they are already there).",
    "Metaphor is NOT movement ('go the extra mile').",
    "destinationActorId: the roster id the acting actor moves toward, ONLY when the action names such an",
    "actor (by name, nickname, or description you can resolve — use pronouns and context) IN A MOVEMENT",
    "PHRASE (walk/go/come toward X). A mere greeting/thank-you addressee ('Thanks Tanya!' while walking",
    "to a desk) is NOT a destination — only set this when the actor's body moves toward that person.",
    "When in doubt, omit: an unmentioned destination is dropped downstream.",
    "It MUST be an exact id from the roster above.",
    "destinationObjectId: the landmark id the acting actor moves toward, ONLY when the action names a",
    "desk, coffee machine, door, chair, or other object above (including 'my desk' = that actor's own desk)",
    "in a movement phrase; omit otherwise. When in doubt, omit.",
    "It MUST be an exact object id from the landmarks above.",
    "speaks=true when the acting actor utters words or the action explicitly intends speech",
    "(says, murmurs, greets, introduces, asks, explains, describes, discusses, mentions, briefs,",
    "thanks, nods along while explaining, shouts, whispers, or quoted dialogue — INCLUDING unquoted",
    "speech verbs like 'nod and start explaining the first task', which still count as speech).",
    "quotedSpeech: copy EXACT quoted strings from the action text (character-for-character substrings) —",
    "never invent, paraphrase, extend, or add dialogue. When the action quotes nothing, use [] even if",
    "speech is implied (speaks may still be true). Any invented quote is dropped downstream.",
    "addresseeActorId: the roster id SPOKEN TO, when the action addresses, asks, greets, or names another",
    "actor (including 'ask Tanya', 'tell him', 'greet the room' has no single addressee — omit).",
    "It MUST be an exact id from the roster above.",
    "contactActorId: the roster id touched or handed something (handshake, hug, kiss, high-five, fist bump,",
    "pat on the shoulder/back, handing coffee/a cup, giving an object). Omit when no touch/handover occurs.",
    "It MUST be an exact id from the roster above.",
    "",
    'Output Schema: {"moves": boolean, "destinationActorId"?: string, "destinationObjectId"?: string, "speaks": boolean, "quotedSpeech": string[], "addresseeActorId"?: string, "contactActorId"?: string}',
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
    const objectIds = new Set(world.scene.objects.map((o) => o.id));

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
      extraCheck: (value) => {
        if (value.destinationActorId !== undefined && !rosterIds.has(value.destinationActorId))
          return `unknown destinationActorId: ${value.destinationActorId}`;
        if (value.destinationObjectId !== undefined && !objectIds.has(value.destinationObjectId)) {
          // Exp-3 item 7: name the closest real ids ("tanya's_desk" →
          // "tanya_desk") so the repair retry can succeed.
          const hint = suggestSimilarIds(value.destinationObjectId, [...objectIds]);
          return (
            `unknown destinationObjectId: ${value.destinationObjectId}` +
            (hint ? ` — did you mean ${hint}?` : "")
          );
        }
        if (value.addresseeActorId !== undefined && !rosterIds.has(value.addresseeActorId))
          return `unknown addresseeActorId: ${value.addresseeActorId}`;
        if (value.contactActorId !== undefined && !rosterIds.has(value.contactActorId))
          return `unknown contactActorId: ${value.contactActorId}`;
        return undefined;
      },
      repairHint:
        "destinationActorId/addresseeActorId/contactActorId must be exact actor ids from the roster (or omit); " +
        "destinationObjectId must be an exact object id from the landmarks (or omit); " +
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
