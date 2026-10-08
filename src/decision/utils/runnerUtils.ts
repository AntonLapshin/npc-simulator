// Pure helpers for the decision-diagram runner. No I/O, fully unit-tested.

import type {
  DecisionDiagram,
  DiagramEdge,
  LayaAnswer,
} from "../decisionTypes.js";

/**
 * Index of the max value; ties break toward the lowest index
 * (deterministic, favors the earlier-listed option).
 */
export function argmax(values: number[]): number {
  if (values.length === 0) throw new Error("argmax of empty array");
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i]! > values[best]!) best = i;
  }
  return best;
}

/** Option id with the highest probability; ties break toward option order. */
export function argmaxOption(probabilities: Record<string, number>, order: string[]): string {
  return order[argmax(order.map((o) => probabilities[o] ?? Number.NEGATIVE_INFINITY))];
}

/**
 * String key used for conditional edge routing: choice -> winner option,
 * noul -> "true"/"false" at p=0.5, score -> rounded expected level index.
 */
export function winnerKey(answer: LayaAnswer): string {
  if (answer.type === "choice") return answer.winner;
  if (answer.type === "noul") return answer.pTrue >= 0.5 ? "true" : "false";
  return String(Math.round(answer.expected));
}

/**
 * Confidence of a single answer on a 0..1 scale: choice -> winner
 * probability, noul -> p of the winning side, score -> p of the
 * rounded-expected level (uniform prior when the distribution is empty).
 */
export function answerConfidence(answer: LayaAnswer, optionCount?: number): number {
  if (answer.type === "choice") {
    return answer.probabilities[answer.winner] ?? answer.confidence;
  }
  if (answer.type === "noul") {
    return answer.pTrue >= 0.5 ? answer.pTrue : 1 - answer.pTrue;
  }
  const dist = answer.distribution;
  const keys = Object.keys(dist);
  if (keys.length === 0) return optionCount && optionCount > 0 ? 1 / optionCount : 0;
  const idx = String(Math.round(answer.expected));
  if (idx in dist) return dist[idx]!;
  const total = keys.reduce((s, k) => s + (dist[k] ?? 0), 0);
  return total > 0 ? Math.max(...keys.map((k) => (dist[k] ?? 0) / total)) : 0;
}

/**
 * Route one step: among edges from `fromId`, prefer the edge whose
 * whenWinner matches `key`; otherwise take the default (no whenWinner)
 * edge; otherwise undefined (walk stops).
 */
export function routeEdge(edges: DiagramEdge[], fromId: string, key: string): string | undefined {
  const from = edges.filter((e) => e.from === fromId);
  const exact = from.find((e) => e.whenWinner === key);
  if (exact) return exact.to;
  return from.find((e) => e.whenWinner === undefined)?.to;
}

/** Node ids with no incoming edges — the walk's starting frontier. */
export function rootsOf(diagram: DecisionDiagram): string[] {
  const targeted = new Set(diagram.edges.map((e) => e.to));
  return diagram.nodes.map((n) => n.id).filter((id) => !targeted.has(id));
}

/**
 * Static topological level per node id: roots are level 0, every other
 * node is 1 + max(level of its predecessors). Used for batching analysis
 * and for the depth cap check. Nodes unreachable from roots get level 0.
 */
export function groupByLevel(diagram: DecisionDiagram): Map<string, number> {
  const levels = new Map<string, number>();
  for (const id of rootsOf(diagram)) levels.set(id, 0);
  let changed = true;
  let guard = diagram.nodes.length + 1;
  while (changed && guard-- > 0) {
    changed = false;
    for (const edge of diagram.edges) {
      const fromLevel = levels.get(edge.from);
      if (fromLevel === undefined) continue;
      const prev = levels.get(edge.to);
      if (prev === undefined || prev < fromLevel + 1) {
        levels.set(edge.to, fromLevel + 1);
        changed = true;
      }
    }
  }
  for (const n of diagram.nodes) {
    if (!levels.has(n.id)) levels.set(n.id, 0);
  }
  return levels;
}

/** Longest static path length (edges) from any root. */
export function diagramDepth(diagram: DecisionDiagram): number {
  const levels = groupByLevel(diagram);
  return Math.max(0, ...levels.values());
}
