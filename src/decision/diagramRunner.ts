// DAG walker for decision diagrams. Independent frontier nodes batch into
// ONE client.decide() call per level; conditional edges route on winners.

import type {
  DecisionDiagram,
  DiagramNode,
  LayaAnswer,
  LayaQuestion,
} from "./decisionTypes.js";
import {
  answerConfidence,
  rootsOf,
  routeEdge,
  winnerKey,
} from "./utils/runnerUtils.js";

export type DecideFn = (
  state: string,
  questions: Record<string, LayaQuestion>,
) => Promise<Record<string, LayaAnswer>>;

export type RunDiagramOptions = {
  /** Hard stop on walk length (edges traversed). Default 8. */
  maxSteps?: number;
  /** Per-node hook for replayable logging. */
  onNode?: (nodeId: string, answer: LayaAnswer) => void;
};

export type DiagramRunResult = {
  decisions: Record<string, LayaAnswer>;
  /** Node ids in visit order. */
  path: string[];
  /** Min winner-confidence along the path (0..1). */
  confidence: number;
};

const DEFAULT_MAX_STEPS = 8;

function nodeToQuestion(node: DiagramNode): LayaQuestion {
  if (node.type === "choice") {
    return { type: "choice", instructions: node.instructions, options: node.options ?? [] };
  }
  if (node.type === "score") {
    return { type: "score", instructions: node.instructions, levels: node.levels ?? [] };
  }
  return { type: "noul", instructions: node.instructions };
}

/**
 * Walk the diagram from its roots. Each frontier is decided in a single
 * batched call; winners route along conditional edges. Stops at the
 * terminal node, when routing dead-ends, or at maxSteps.
 */
export async function runDiagram(
  diagram: DecisionDiagram,
  state: string,
  decide: DecideFn,
  opts: RunDiagramOptions = {},
): Promise<DiagramRunResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const decisions: Record<string, LayaAnswer> = {};
  const path: string[] = [];
  let confidence = 1;

  let frontier = rootsOf(diagram);
  if (frontier.length === 0) frontier = [diagram.terminal];
  let steps = 0;

  while (frontier.length > 0 && steps < maxSteps) {
    const questions: Record<string, LayaQuestion> = {};
    for (const id of frontier) {
      const node = byId.get(id);
      if (node && !(id in decisions)) questions[id] = nodeToQuestion(node);
    }
    if (Object.keys(questions).length === 0) break;

    const answers = await decide(state, questions);
    const next = new Set<string>();
    for (const id of Object.keys(questions)) {
      const answer = answers[id];
      if (!answer) continue; // tolerate a dropped answer; routing just ends
      decisions[id] = answer;
      path.push(id);
      opts.onNode?.(id, answer);
      confidence = Math.min(confidence, answerConfidence(answer));
      if (id === diagram.terminal) continue; // terminal: no outgoing edges
      const target = routeEdge(diagram.edges, id, winnerKey(answer));
      if (target && byId.has(target) && !(target in decisions)) next.add(target);
    }
    // If the terminal was decided this round, stop regardless of siblings.
    if (diagram.terminal in decisions) break;
    frontier = [...next];
    steps++;
  }

  return { decisions, path, confidence };
}
