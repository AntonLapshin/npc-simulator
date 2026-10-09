import { z } from "zod";
import type { ActionSemantics, ConsequenceResult } from "./types.js";

const nonEmptyString = z.string().min(1, "must be a non-empty string");

export const sceneObjectSchema = z
  .object({
    id: nonEmptyString,
    name: z.string(),
    description: z.string(),
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite(),
    h: z.number().finite(),
    passable: z.boolean(),
    blocksVision: z.boolean(),
    blocksSound: z.boolean(),
  })
  .strict();

export const sceneSchema = z
  .object({
    width: z.number().finite(),
    height: z.number().finite(),
    objects: z.array(sceneObjectSchema),
  })
  .strict();

export const actorLookSchema = z
  .object({
    skin: z.string().optional(),
    skin2: z.string().optional(),
    hair: z.string().optional(),
    hairStyle: z.string().optional(),
    shirt: z.string().optional(),
    shirt2: z.string().optional(),
    pants: z.string().optional(),
    shoes: z.string().optional(),
  })
  .strict();

export const actorPoseSchema = z.enum(["stand", "sit", "kneel", "doggy", "prone"]);

// Phase 3: the held prop is engine-owned and scenario-open (see ActorProp
// in src/types.ts) — any string, not just cup/laptop.
export const actorPropSchema = z.string().nullable();

export const actorSchema = z
  .object({
    id: nonEmptyString,
    name: z.string(),
    persona: z.string(),
    x: z.number().finite(),
    y: z.number().finite(),
    state: z.string(),
    emotion: z.string(),
    goal: z.string(),
    // One-time inner reaction; defaults to "" so older scenario/save
    // files without the field still load.
    thoughts: z.string().default(""),
    memories: z.array(z.string()),
    beliefs: z.array(z.string()),
    relationships: z.array(z.string()),
    // Visual appearance (data-driven per npc-simulator-ui raw input
    // contract). All optional with defaults so older scenario/save files
    // without them still load; the UI falls back to derived looks.
    color: z.string().optional(),
    pose: actorPoseSchema.default("stand"),
    prop: actorPropSchema.default(null),
    look: actorLookSchema.default({}),
    // Exp-7 item A6: third-person pronouns for narrative prose
    // ("he/him", "she/her", "they/them"). Optional so older files load;
    // when present, prompts name them and the validator checks prose.
    pronouns: z.string().optional(),
  })
  .strict();

export const historyEntrySchema = z
  .object({
    text: z.string(),
    perceivers: z.array(z.string()),
  })
  .strict();

export const scenarioVocabularySchema = z
  .object({
    objectNouns: z.array(z.string()).optional(),
  })
  .strict();

export const scenarioSchema = z
  .object({
    version: z.number().int(),
    id: nonEmptyString,
    title: z.string(),
    narrative: z.string(),
    userActorId: nonEmptyString,
    order: z.array(nonEmptyString).min(1, "order must contain at least one actor"),
    scene: sceneSchema,
    actors: z.array(actorSchema).min(1, "scenario must contain at least one actor"),
    // F8: optional per-scenario object vocabulary (validated in detail by
    // the scenario loader; accepted here so strict parsing doesn't drop it).
    vocabulary: scenarioVocabularySchema.optional(),
  })
  .strict();

export const worldSchema = scenarioSchema
  .extend({
    tick: z.number().int().min(0),
    turnIndex: z.number().int().min(0),
    // F6: new saves store HistoryEntry objects; legacy saves store plain
    // strings. Both are accepted and normalized on load.
    history: z.array(z.union([z.string(), historyEntrySchema])),
  })
  .strict();

export const actionSchema = z
  .object({
    actorId: nonEmptyString,
    text: z.string(),
  })
  .strict();

export const proposalResultSchema = z
  .object({
    suggestions: z.array(z.string()),
    reasoning: z.string(),
  })
  .strict();

export const selectionResultSchema = z
  .object({
    action: z.string(),
    reasoning: z.string(),
  })
  .strict();

/**
 * F15: lenient-repair notes recorded by normalizeRenderResult. Model
 * sloppiness used to pass validation silently; every drop is now named
 * here so completeJson can log it LOUDLY via the logger (with a payload
 * fingerprint). Drained per-parse — see takeConsequenceRepairNotes.
 */
const pendingRepairNotes: string[] = [];

function reportRepair(note: string): void {
  pendingRepairNotes.push(note);
}

/**
 * F15: drain the repair notes recorded by normalizeRenderResult.
 * completeJson brackets each schema parse with a drain-before/drain-after
 * so the notes belong to exactly one parse (direct safeParse calls leave
 * notes pending until the next drain — harmless).
 */
export function takeConsequenceRepairNotes(): string[] {
  const notes = [...pendingRepairNotes];
  pendingRepairNotes.length = 0;
  return notes;
}

/**
 * Phase 4: the render-only consequence contract. Prose in, prose out —
 * narrative + the acting actor's thoughts/emotion. Unknown keys (old-
 * schema actorPatches/objectPatches/effects, or model-invented extras) are
 * stripped by the non-strict object schema — never validated — and named
 * here so completeJson logs the drop LOUDLY (consequence_lenient_repair)
 * instead of silently.
 */

/** Top-level render keys — anything else is stripped, never validated. */
const KNOWN_RENDER_KEYS = new Set([
  "narrative",
  "thoughts",
  "emotion",
  "reasoning",
  "fallback",
]);

function normalizeRenderResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const v = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(v)) {
    if (!KNOWN_RENDER_KEYS.has(key)) {
      reportRepair(
        `dropped unknown key "${key}" (render contract is prose-only: narrative/thoughts/emotion)`,
      );
    }
  }
  if (typeof v["reasoning"] !== "string") {
    reportRepair("defaulted missing/non-string reasoning to \"\"");
    v["reasoning"] = "";
  }
  return v;
}

export const consequenceResultSchema: z.ZodType<ConsequenceResult> = z.preprocess(
  normalizeRenderResult,
  z.object({
    narrative: z.string().min(1, "narrative must be non-empty"),
    thoughts: z.string().optional(),
    emotion: z.string().optional(),
    reasoning: z.string().default(""),
    fallback: z.boolean().optional(),
  }),
) as z.ZodType<ConsequenceResult>;

export const actionSemanticsSchema: z.ZodType<ActionSemantics> = z.object({
  moves: z.boolean(),
  destinationActorId: z.string().min(1).optional(),
  destinationObjectId: z.string().min(1).optional(),
  speaks: z.boolean(),
  quotedSpeech: z.array(z.string()),
  addresseeActorId: z.string().min(1).optional(),
  contactActorId: z.string().min(1).optional(),
}) as z.ZodType<ActionSemantics>;

export const engineConfigSchema = z
  .object({
    maxMemoriesPerActor: z.number().int().positive(),
    maxHistoryEntries: z.number().int().positive(),
    defaultPerceptionRadius: z.number().finite().positive(),
    maxRetries: z.number().int().min(0),
    logDir: z.string(),
    saveDir: z.string(),
    autosaveEnabled: z.boolean(),
  })
  .strict();

export const saveFileSchema = z
  .object({
    world: worldSchema,
  })
  .strict();
