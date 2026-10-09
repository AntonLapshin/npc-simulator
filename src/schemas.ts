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
/**
 * F15: lenient-repair notes recorded by normalizeConsequenceResult.
 * Model sloppiness used to pass validation silently; every repair,
 * default, and drop is now named here so completeJson can log it LOUDLY
 * via the logger (with a payload fingerprint). Drained per-parse — see
 * takeConsequenceRepairNotes.
 */
const pendingRepairNotes: string[] = [];

function reportRepair(note: string): void {
  pendingRepairNotes.push(note);
}

/**
 * F15: drain the repair notes recorded by normalizeConsequenceResult.
 * completeJson brackets each schema parse with a drain-before/drain-after
 * so the notes belong to exactly one parse (direct safeParse calls, e.g.
 * the engine-side re-validation in physicalValidator, leave notes pending
 * until the next drain — harmless).
 */
export function takeConsequenceRepairNotes(): string[] {
  const notes = [...pendingRepairNotes];
  pendingRepairNotes.length = 0;
  return notes;
}

/** Top-level consequence keys — anything else is stripped by the non-strict schema. */
const KNOWN_CONSEQUENCE_KEYS = new Set([
  "narrative",
  "actorPatches",
  "objectPatches",
  "reasoning",
  "effects",
]);

/** Patch keys — anything else is stripped by the non-strict patch schemas. */
const KNOWN_ACTOR_PATCH_KEYS = new Set([
  "actorId",
  "x",
  "y",
  "state",
  "emotion",
  "goal",
  "thoughts",
  "memoriesAppend",
  "beliefsAppend",
  "relationshipsAppend",
  "pose",
  "prop",
]);

const KNOWN_OBJECT_PATCH_KEYS = new Set([
  "objectId",
  "description",
  "x",
  "y",
  "w",
  "h",
  "passable",
  "blocksVision",
  "blocksSound",
]);

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

function normalizeActorPatch(patch: unknown, report?: (note: string) => void): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const p = { ...(patch as Record<string, unknown>) };
  if (typeof p["id"] === "string") {
    if (typeof p["actorId"] !== "string") {
      p["actorId"] = p["id"];
      report?.('repaired actor patch: renamed "id" to "actorId"');
    } else {
      report?.('dropped redundant "id" from actor patch ("actorId" already present)');
    }
  }
  delete p["id"];
  return p;
}

function normalizeObjectPatch(patch: unknown, report?: (note: string) => void): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const p = { ...(patch as Record<string, unknown>) };
  if (typeof p["id"] === "string") {
    if (typeof p["objectId"] !== "string") {
      p["objectId"] = p["id"];
      report?.('repaired object patch: renamed "id" to "objectId"');
    } else {
      report?.('dropped redundant "id" from object patch ("objectId" already present)');
    }
  }
  delete p["id"];
  return p;
}

function normalizeConsequenceResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const v = { ...(value as Record<string, unknown>) };
  const report = reportRepair;
  // Unknown top-level keys are stripped by the non-strict object schema —
  // name them so the drop is visible instead of silent.
  for (const key of Object.keys(v)) {
    if (!KNOWN_CONSEQUENCE_KEYS.has(key)) {
      report(`dropped unknown top-level key "${key}"`);
    }
  }
  let actorPatches = parseMaybeStringifiedArray(v["actorPatches"]);
  if (typeof v["actorPatches"] === "string" && Array.isArray(actorPatches)) {
    report("repaired actorPatches: parsed JSON-encoded string into an array");
  }
  let objectPatches = parseMaybeStringifiedArray(v["objectPatches"]);
  if (typeof v["objectPatches"] === "string" && Array.isArray(objectPatches)) {
    report("repaired objectPatches: parsed JSON-encoded string into an array");
  }
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
          report(
            `repaired actor patch: hoisted ${nested.length} nested objectPatch(es) to top level`,
          );
        }
        // Drop hollow remnants that only carried the nested patches
        // ({objectPatches: [...]} with no actor fields at all).
        const keys = Object.keys(rec);
        if (keys.length === 0 || (keys.length === 1 && keys[0] === "id")) {
          report("dropped hollow actor-patch remnant that carried only nested objectPatches");
          continue;
        }
        cleaned.push(normalizeActorPatch(rec, report));
      } else {
        cleaned.push(normalizeActorPatch(p, report));
      }
    }
    actorPatches = cleaned;
    if (hoisted.length > 0) {
      const top = Array.isArray(objectPatches) ? [...objectPatches] : [];
      objectPatches = [...top, ...hoisted];
    }
  }
  if (Array.isArray(objectPatches)) {
    // Arrow wrapper: Array.map passes (element, index) — the index must
    // not reach the report callback.
    objectPatches = objectPatches.map((p) => normalizeObjectPatch(p, report));
  }
  // A missing patch list means "nothing of that kind changed".
  if (actorPatches === undefined) {
    actorPatches = [];
    report("defaulted missing actorPatches to []");
  }
  if (objectPatches === undefined) {
    objectPatches = [];
    report("defaulted missing objectPatches to []");
  }
  v["actorPatches"] = actorPatches;
  v["objectPatches"] = objectPatches;
  // Unknown patch keys are stripped by the non-strict patch schemas —
  // name them so the drop is visible instead of silent.
  for (const p of actorPatches as unknown[]) {
    if (typeof p === "object" && p !== null && !Array.isArray(p)) {
      for (const key of Object.keys(p)) {
        if (!KNOWN_ACTOR_PATCH_KEYS.has(key)) {
          report(`dropped unknown key "${key}" from actor patch`);
        }
      }
    }
  }
  for (const p of objectPatches as unknown[]) {
    if (typeof p === "object" && p !== null && !Array.isArray(p)) {
      for (const key of Object.keys(p)) {
        if (!KNOWN_OBJECT_PATCH_KEYS.has(key)) {
          report(`dropped unknown key "${key}" from object patch`);
        }
      }
    }
  }
  if (typeof v["reasoning"] !== "string") {
    v["reasoning"] = "";
    report('defaulted missing/non-string reasoning to ""');
  }
  // Lenient: small models sometimes stringify the effects object.
  if (typeof v["effects"] === "string") {
    const trimmed = (v["effects"] as string).trim();
    if (trimmed.startsWith("{")) {
      try {
        v["effects"] = JSON.parse(trimmed);
        report("repaired effects: parsed JSON-encoded string into an object");
      } catch {
        delete v["effects"];
        report(
          "WARNING: dropped malformed effects (string was not valid JSON) — " +
            "effects left to the semantic-judge fallback",
        );
      }
    } else {
      delete v["effects"];
      report(
        "WARNING: dropped malformed effects (not a JSON object string) — " +
          "effects left to the semantic-judge fallback",
      );
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
  pose: actorPoseSchema.optional(),
  prop: actorPropSchema.optional(),
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
  // Arrow wrapper: zod passes (data, ctx) — the ctx must not reach the
  // report callback of normalizeActorPatch.
  (p) => normalizeActorPatch(p),
  lenientActorPatchSchema,
) as z.ZodType<ActorPatch>;

export const objectPatchSchema: z.ZodType<ObjectPatch> = z.preprocess(
  // Arrow wrapper: see actorPatchSchema above.
  (p) => normalizeObjectPatch(p),
  lenientObjectPatchSchema,
) as z.ZodType<ObjectPatch>;

export const consequenceEffectsSchema: z.ZodType<ConsequenceEffects> = z.object({
  moved: z.boolean(),
  spoke: z.boolean(),
  quotedSpeech: z.array(z.string()).optional(),
  destinationActorId: z.string().min(1).optional(),
  destinationObjectId: z.string().min(1).optional(),
  addresseeActorId: z.string().min(1).optional(),
  contactActorId: z.string().min(1).optional(),
}) as z.ZodType<ConsequenceEffects>;

export const consequenceResultSchema: z.ZodType<ConsequenceResult> = z.preprocess(
  normalizeConsequenceResult,
  z.object({
    narrative: z.string().min(1, "narrative must be non-empty"),
    actorPatches: z.array(lenientActorPatchSchema),
    objectPatches: z.array(lenientObjectPatchSchema),
    reasoning: z.string().default(""),
    // Full effects shape (see consequenceEffectsSchema): destination ids,
    // addressee, and contact ids must survive normalization — the validator
    // reads them via effectsToSemantics. A partial inline object here would
    // silently strip them (zod drops unknown keys), disabling the
    // destination/addressee/contact gates whenever the model declares them.
    effects: consequenceEffectsSchema.optional(),
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
