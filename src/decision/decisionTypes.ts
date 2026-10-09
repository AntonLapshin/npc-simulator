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
// Decision diagrams (static DAGs of questions)
// ---------------------------------------------------------------------------

export const DiagramNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["choice", "noul", "score"]),
  instructions: z.string().min(1).max(2000),
  /** Required for choice; the option ids. */
  options: z.array(z.string().min(1)).optional(),
  /** Required for score; ordered level labels. */
  levels: z.array(z.string().min(1)).optional(),
});

export const DiagramEdgeSchema = z.object({
  from: z.string().min(1),
  /** Winner key this edge fires on (choice option, "true"/"false" for noul,
   *  rounded level index for score). Omitted = default fallthrough. */
  whenWinner: z.string().optional(),
  to: z.string().min(1),
});

export const DecisionDiagramSchema = z.object({
  nodes: z.array(DiagramNodeSchema).min(1).max(8),
  edges: z.array(DiagramEdgeSchema).max(24),
  terminal: z.string().min(1),
});

export type DiagramNode = z.infer<typeof DiagramNodeSchema>;
export type DiagramEdge = z.infer<typeof DiagramEdgeSchema>;
export type DecisionDiagram = z.infer<typeof DecisionDiagramSchema>;

// ---------------------------------------------------------------------------
// Intent (output of the decision cascade)
//
// Phase 5: typed intents map directly onto engine executors with no
// translation layer —
//   move     (+ targetId) -> movementExecutor destination
//   speak    (+ quote)    -> speechExecutor exactQuote
//   interact (+ targetId) -> manipulationExecutor object target
//   gesture / wait        -> prose-only, no executor
// A "fully-typed" intent (kind + resolved targetId) is authoritative for
// the executors: it generated the action text, so the executors use its
// fields instead of re-parsing the text.
// ---------------------------------------------------------------------------

export const IntentSchema = z.object({
  kind: z.enum(["speak", "move", "interact", "gesture", "wait"]),
  targetId: z.string().optional(),
  targetKind: z.enum(["actor", "object", "landmark", "none"]).optional(),
  manner: z.string().optional(),
  /** Phase 5: engine-dictated exact words for speak intents (feeds exactQuote). */
  quote: z.string().optional(),
});

export type Intent = z.infer<typeof IntentSchema>;

/**
 * Phase 5: true when the intent is fully typed — kind plus a resolved
 * target id. Only the cascade's target-resolution step produces these, so
 * executors may treat them as authoritative (no text re-parsing). Pure.
 */
export function isFullyTypedIntent(
  intent: Intent | undefined,
): intent is Intent {
  return (
    intent !== undefined &&
    intent.targetId !== undefined &&
    intent.targetId.length > 0
  );
}
