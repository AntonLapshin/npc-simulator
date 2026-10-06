import { z } from "zod";
import type { ActionSemantics, ActorPatch, ConsequenceEffects, ConsequenceResult, ObjectPatch } from "./types.js";

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

/**
 * Lenient normalization for small-LLM consequence output (e.g. 3B Ollama
 * models). Observed failure modes in real runs:
 * - `id` instead of `actorId` / `objectId`;
 * - `actorPatches` / `objectPatches` emitted as JSON-encoded *strings*;
 * - missing `reasoning`;
 * - `objectPatches` nested inside an actor-patch element.
 * All are repaired here so validation judges content, not field-name
 * drift. Unknown keys are stripped (not rejected) at this layer —
 * physical validation still rejects unknown ids and bad coordinates.
 */
function parseMaybeStringifiedArray(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
    // A single patch object encoded as a string ("{...}") — wrap in an array.
    if (trimmed.startsWith("{")) {
      try {
        return [JSON.parse(trimmed)];
      } catch {
        return value;
      }
    }
  }
  return value;
}

function normalizeActorPatch(patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const p = { ...(patch as Record<string, unknown>) };
  if (typeof p["actorId"] !== "string" && typeof p["id"] === "string") {
    p["actorId"] = p["id"];
  }
  delete p["id"];
  return p;
}

function normalizeObjectPatch(patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const p = { ...(patch as Record<string, unknown>) };
  if (typeof p["objectId"] !== "string" && typeof p["id"] === "string") {
    p["objectId"] = p["id"];
  }
  delete p["id"];
  return p;
}

function normalizeConsequenceResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const v = { ...(value as Record<string, unknown>) };
  let actorPatches = parseMaybeStringifiedArray(v["actorPatches"]);
  let objectPatches = parseMaybeStringifiedArray(v["objectPatches"]);
  // Hoist mis-nested objectPatches out of actor-patch elements
  // (small models sometimes emit [{actorId, ..., objectPatches: [...]}]).
  if (Array.isArray(actorPatches)) {
    const hoisted: unknown[] = [];
    const cleaned: unknown[] = [];
    for (const p of actorPatches) {
      if (typeof p === "object" && p !== null && !Array.isArray(p)) {
        const rec = { ...(p as Record<string, unknown>) };
        const nested = parseMaybeStringifiedArray(rec["objectPatches"]);
        if (Array.isArray(nested)) {
          hoisted.push(...nested);
          delete rec["objectPatches"];
        }
        // Drop hollow remnants that only carried the nested patches
        // ({objectPatches: [...]} with no actor fields at all).
        const keys = Object.keys(rec);
        if (keys.length === 0 || (keys.length === 1 && keys[0] === "id")) continue;
        cleaned.push(normalizeActorPatch(rec));
      } else {
        cleaned.push(normalizeActorPatch(p));
      }
    }
    actorPatches = cleaned;
    if (hoisted.length > 0) {
      const top = Array.isArray(objectPatches) ? [...objectPatches] : [];
      objectPatches = [...top, ...hoisted];
    }
  }
  if (Array.isArray(objectPatches)) {
    objectPatches = objectPatches.map(normalizeObjectPatch);
  }
  // A missing patch list means "nothing of that kind changed".
  if (actorPatches === undefined) actorPatches = [];
  if (objectPatches === undefined) objectPatches = [];
  v["actorPatches"] = actorPatches;
  v["objectPatches"] = objectPatches;
  if (typeof v["reasoning"] !== "string") v["reasoning"] = "";
  // Lenient: small models sometimes stringify the effects object.
  if (typeof v["effects"] === "string") {
    const trimmed = (v["effects"] as string).trim();
    if (trimmed.startsWith("{")) {
      try {
        v["effects"] = JSON.parse(trimmed);
      } catch {
        delete v["effects"];
      }
    } else {
      delete v["effects"];
    }
  }
  return v;
}

const lenientActorPatchSchema = z.object({
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
});

const lenientObjectPatchSchema = z.object({
  objectId: nonEmptyString,
  description: z.string().optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  w: z.number().finite().optional(),
  h: z.number().finite().optional(),
  passable: z.boolean().optional(),
  blocksVision: z.boolean().optional(),
  blocksSound: z.boolean().optional(),
});

export const actorPatchSchema: z.ZodType<ActorPatch> = z.preprocess(
  normalizeActorPatch,
  lenientActorPatchSchema,
) as z.ZodType<ActorPatch>;

export const objectPatchSchema: z.ZodType<ObjectPatch> = z.preprocess(
  normalizeObjectPatch,
  lenientObjectPatchSchema,
) as z.ZodType<ObjectPatch>;

export const consequenceResultSchema: z.ZodType<ConsequenceResult> = z.preprocess(
  normalizeConsequenceResult,
  z.object({
    narrative: z.string().min(1, "narrative must be non-empty"),
    actorPatches: z.array(lenientActorPatchSchema),
    objectPatches: z.array(lenientObjectPatchSchema),
    reasoning: z.string().default(""),
    effects: z
      .object({
        moved: z.boolean(),
        spoke: z.boolean(),
        quotedSpeech: z.array(z.string()).optional(),
        destinationActorId: z.string().min(1).optional(),
      })
      .optional(),
  }),
) as z.ZodType<ConsequenceResult>;

export const actionSemanticsSchema: z.ZodType<ActionSemantics> = z.object({
  moves: z.boolean(),
  destinationActorId: z.string().min(1).optional(),
  speaks: z.boolean(),
  quotedSpeech: z.array(z.string()),
}) as z.ZodType<ActionSemantics>;

export const consequenceEffectsSchema: z.ZodType<ConsequenceEffects> = z.object({
  moved: z.boolean(),
  spoke: z.boolean(),
  quotedSpeech: z.array(z.string()).optional(),
  destinationActorId: z.string().min(1).optional(),
}) as z.ZodType<ConsequenceEffects>;

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
