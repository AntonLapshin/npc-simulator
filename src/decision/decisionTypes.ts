// Shared Zod schemas + TS types for the Laya decision layer.
// Everything crossing the Laya wire or a diagram boundary is validated here.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Laya questions (what we send)
// ---------------------------------------------------------------------------

export const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string().min(1).max(2000),
  /** Option ids; sent on the wire as a criteria map {id: id}. */
  options: z.array(z.string().min(1)).min(2).max(255),
});

export const NoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string().min(1).max(2000),
});

export const ScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.string().min(1).max(2000),
  /** Ordered level labels, e.g. ["1","2","3","4","5"]. */
  levels: z.array(z.string().min(1)).min(2).max(10),
});

export const LayaQuestionSchema = z.discriminatedUnion("type", [
  ChoiceQuestionSchema,
  NoulQuestionSchema,
  ScoreQuestionSchema,
]);

export type ChoiceQuestion = z.infer<typeof ChoiceQuestionSchema>;
export type NoulQuestion = z.infer<typeof NoulQuestionSchema>;
export type ScoreQuestion = z.infer<typeof ScoreQuestionSchema>;
export type LayaQuestion = z.infer<typeof LayaQuestionSchema>;

// ---------------------------------------------------------------------------
// Laya answers (normalized form of what we receive)
// ---------------------------------------------------------------------------

export const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  winner: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});

export const NoulAnswerSchema = z.object({
  type: z.literal("noul"),
  /** Calibrated P(true). */
  pTrue: z.number().min(0).max(1),
});

export const ScoreAnswerSchema = z.object({
  type: z.literal("score"),
  /** Expected level (index into the question's levels, may be fractional). */
  expected: z.number(),
  /** Distribution over level indices, keys stringified. */
  distribution: z.record(z.string(), z.number()),
});

export const LayaAnswerSchema = z.discriminatedUnion("type", [
  ChoiceAnswerSchema,
  NoulAnswerSchema,
  ScoreAnswerSchema,
]);

export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type NoulAnswer = z.infer<typeof NoulAnswerSchema>;
export type ScoreAnswer = z.infer<typeof ScoreAnswerSchema>;
export type LayaAnswer = z.infer<typeof LayaAnswerSchema>;

// ---------------------------------------------------------------------------
// (Decision diagrams and the cascade Intent type lived here until
// PLAN_V2 Phase 6: the static diagrams, the intent cascade, and the
// proposal/selection engines were deleted. Laya survives only as the
// semantic parser — one batched decide over the action sentence.)
// ---------------------------------------------------------------------------
