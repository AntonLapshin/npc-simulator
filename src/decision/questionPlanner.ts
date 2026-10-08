// Phase 4: dynamic question generation. A low-temperature chat LLM
// enumerates the decision space as diagram JSON; Laya collapses every
// node. Zod + validateDiagram are the safety rails; a TTL cache keeps the
// planner call rare.

import { createHash } from "node:crypto";
import type { DecisionDiagram } from "./decisionTypes.js";
import { DecisionDiagramSchema } from "./decisionTypes.js";
import { validateDiagram } from "./diagrams.js";
import { extractJsonObject } from "./utils/jsonExtract.js";

export class PlannerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlannerError";
  }
}

/** Chat completion hook injected by the wiring layer (thin shell boundary). */
export type ChatComplete = (prompt: string) => Promise<string>;

export type PlanDiagramOptions = {
  /** Cache TTL in ms. Default 10 minutes. 0 disables the cache. */
  cacheTtlMs?: number;
};

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

/** Stable cache key for (goal, stateSummary): sha1 hex of the pair. Pure. */
export function diagramCacheKey(goal: string, stateSummary: string): string {
  return createHash("sha1").update(`${goal}\n\x00\n${stateSummary}`, "utf8").digest("hex");
}

type CacheEntry = { diagram: DecisionDiagram; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Test hook: drop all cached diagrams. */
export function clearDiagramCache(): void {
  cache.clear();
}

/** Test hook: how many diagrams are currently cached. */
export function diagramCacheSize(): number {
  return cache.size;
}

function buildPlannerPrompt(goal: string, stateSummary: string): string {
  return [
    "You enumerate decision spaces; you never choose. Respond with ONLY a JSON object.",
    "",
    "Design a small decision diagram (a DAG of questions) that breaks down the goal below",
    "into 2-6 micro-decisions a calibrated classifier could answer. Rules:",
    "- at most 8 nodes, at most 12 options per choice node, options non-empty and distinct",
    "- max depth 4 (longest chain of edges)",
    "- node: {id, type: choice|noul|score, instructions, options? (choice), levels? (score, e.g. [\"1\",\"2\",\"3\",\"4\",\"5\"])}",
    "- edge: {from, to, whenWinner?} — whenWinner routes on the winner (choice option,",
    '  "true"/"false" for noul, rounded level index for score); omit it for the default edge',
    "- terminal: id of the final node",
    "- instructions: one crisp sentence each, grounded in the state summary",
    "",
    `Goal: ${goal}`,
    "",
    `State: ${stateSummary}`,
    "",
    "JSON:",
  ].join("\n");
}

function parsePlannerOutput(raw: string): DecisionDiagram {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) throw new PlannerError("planner output contains no JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new PlannerError("planner output is not valid JSON", { cause: err });
  }
  const schema = DecisionDiagramSchema.safeParse(parsed);
  if (!schema.success) {
    throw new PlannerError(
      `planner diagram failed schema validation: ${schema.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const validated = validateDiagram(schema.data);
  if (!validated.ok) {
    throw new PlannerError(`planner diagram failed safety validation: ${validated.errors.join("; ")}`);
  }
  return validated.diagram;
}

/**
 * Generate (or fetch from cache) a decision diagram for this goal+state.
 * Throws PlannerError when the chat model fails or the diagram is unsafe —
 * callers fall back to the static diagram.
 */
export async function planDiagram(
  goal: string,
  stateSummary: string,
  chatComplete: ChatComplete,
  opts: PlanDiagramOptions = {},
): Promise<DecisionDiagram> {
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const key = diagramCacheKey(goal, stateSummary);
  if (ttlMs > 0) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.diagram;
    if (hit) cache.delete(key);
  }
  let raw: string;
  try {
    raw = await chatComplete(buildPlannerPrompt(goal, stateSummary));
  } catch (err) {
    throw new PlannerError("planner chat call failed", { cause: err });
  }
  const diagram = parsePlannerOutput(raw);
  if (ttlMs > 0) cache.set(key, { diagram, expiresAt: Date.now() + ttlMs });
  return diagram;
}
