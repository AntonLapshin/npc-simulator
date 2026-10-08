import { describe, expect, it, vi } from "vitest";
import type {
  DecisionDiagram,
  LayaAnswer,
  LayaQuestion,
} from "../../../src/decision/decisionTypes.js";
import { SELECTION_CASCADE, validateDiagram } from "../../../src/decision/diagrams.js";
import { runDiagram, type DecideFn } from "../../../src/decision/diagramRunner.js";

function choice(winner: string, p: number, options: string[]): LayaAnswer {
  const probabilities: Record<string, number> = {};
  for (const o of options) probabilities[o] = o === winner ? p : (1 - p) / Math.max(1, options.length - 1);
  return { type: "choice", winner, probabilities, confidence: p };
}

const CASCADING: DecisionDiagram = {
  nodes: [
    { id: "a", type: "choice", instructions: "a?", options: ["x", "y"] },
    { id: "b", type: "choice", instructions: "b?", options: ["p", "q"] },
    { id: "c", type: "choice", instructions: "c?", options: ["m", "n"] },
  ],
  edges: [
    { from: "a", whenWinner: "x", to: "b" },
    { from: "a", whenWinner: "y", to: "c" },
  ],
  terminal: "b",
};

describe("runDiagram", () => {
  it("routes on winners and stops at the terminal", async () => {
    const decide: DecideFn = async (_s, qs) => {
      const out: Record<string, LayaAnswer> = {};
      if ("a" in qs) out["a"] = choice("x", 0.9, ["x", "y"]);
      if ("b" in qs) out["b"] = choice("p", 0.8, ["p", "q"]);
      return out;
    };
    const result = await runDiagram(CASCADING, "state", decide);
    expect(result.path).toEqual(["a", "b"]);
    expect(result.decisions["a"]?.type).toBe("choice");
    // confidence = min winner prob along the path
    expect(result.confidence).toBeCloseTo(0.8, 5);
  });

  it("takes the other branch when the winner differs", async () => {
    const decide: DecideFn = async (_s, qs) => {
      const out: Record<string, LayaAnswer> = {};
      if ("a" in qs) out["a"] = choice("y", 0.7, ["x", "y"]);
      if ("c" in qs) out["c"] = choice("m", 0.6, ["m", "n"]);
      return out;
    };
    const result = await runDiagram(CASCADING, "state", decide);
    expect(result.path).toEqual(["a", "c"]);
    expect(result.confidence).toBeCloseTo(0.6, 5);
  });

  it("batches independent roots into a single decide() call", async () => {
    const decide = vi.fn(async (_s: string, _q: Record<string, LayaQuestion>) => ({}));
    const diagram: DecisionDiagram = {
      nodes: [
        { id: "n1", type: "noul", instructions: "one?" },
        { id: "n2", type: "noul", instructions: "two?" },
      ],
      edges: [],
      terminal: "n1",
    };
    await runDiagram(diagram, "state", decide);
    expect(decide).toHaveBeenCalledOnce();
    const batched = Object.keys(decide.mock.calls[0]![1]);
    expect(batched.sort()).toEqual(["n1", "n2"]);
  });

  it("respects maxSteps on cyclic diagrams", async () => {
    const decide: DecideFn = async (_s, qs) => {
      const out: Record<string, LayaAnswer> = {};
      for (const id of Object.keys(qs)) out[id] = { type: "noul", pTrue: 0.9 };
      return out;
    };
    const loop: DecisionDiagram = {
      nodes: [
        { id: "x", type: "noul", instructions: "x?" },
        { id: "y", type: "noul", instructions: "y?" },
      ],
      edges: [
        { from: "x", whenWinner: "true", to: "y" },
        { from: "y", whenWinner: "true", to: "x" },
      ],
      terminal: "zzz",
    };
    const result = await runDiagram(loop, "state", decide, { maxSteps: 3 });
    expect(result.path.length).toBeLessThanOrEqual(3);
  });

  it("calls onNode for every decided node in order", async () => {
    const seen: string[] = [];
    const decide: DecideFn = async (_s, qs) => {
      const out: Record<string, LayaAnswer> = {};
      if ("a" in qs) out["a"] = choice("x", 0.9, ["x", "y"]);
      if ("b" in qs) out["b"] = choice("p", 0.8, ["p", "q"]);
      return out;
    };
    await runDiagram(CASCADING, "state", decide, { onNode: (id) => seen.push(id) });
    expect(seen).toEqual(["a", "b"]);
  });

  it("walks the real SELECTION_CASCADE end to end", async () => {
    expect(validateDiagram(SELECTION_CASCADE).ok).toBe(true);
    const decide: DecideFn = async (_s, qs) => {
      const out: Record<string, LayaAnswer> = {};
      for (const [id, q] of Object.entries(qs)) {
        if (q.type === "choice") out[id] = choice(q.options[0]!, 0.9, q.options);
        else out[id] = { type: "noul", pTrue: 0.9 };
      }
      return out;
    };
    const result = await runDiagram(SELECTION_CASCADE, "state", decide);
    // intent_kind defaults to first option "speak" -> addressee -> manner
    expect(result.path).toEqual(["intent_kind", "addressee", "manner"]);
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });
});
