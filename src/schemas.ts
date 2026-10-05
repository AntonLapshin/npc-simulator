import { z } from "zod";

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
  })
  .strict();

export const worldSchema = scenarioSchema
  .extend({
    tick: z.number().int().min(0),
    turnIndex: z.number().int().min(0),
    history: z.array(z.string()),
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

export const actorPatchSchema = z
  .object({
    actorId: nonEmptyString,
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    state: z.string().optional(),
    emotion: z.string().optional(),
    goal: z.string().optional(),
    thoughts: z.string().optional(),
    memoriesAppend: z.array(z.string()).optional(),
    beliefsAppend: z.array(z.string()).optional(),
    relationshipsAppend: z.array(z.string()).optional(),
  })
  .strict();

export const objectPatchSchema = z
  .object({
    objectId: nonEmptyString,
    description: z.string().optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    w: z.number().finite().optional(),
    h: z.number().finite().optional(),
    passable: z.boolean().optional(),
    blocksVision: z.boolean().optional(),
    blocksSound: z.boolean().optional(),
  })
  .strict();

export const consequenceResultSchema = z
  .object({
    narrative: z.string().min(1, "narrative must be non-empty"),
    actorPatches: z.array(actorPatchSchema),
    objectPatches: z.array(objectPatchSchema),
    reasoning: z.string(),
  })
  .strict();

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
