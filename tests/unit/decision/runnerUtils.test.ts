import { describe, expect, it } from "vitest";
import type { DecisionDiagram } from "../../../src/decision/decisionTypes.js";
import {
  answerConfidence,
  argmax,
  argmaxOption,
  diagramDepth,
  groupByLevel,
  rootsOf,
  routeEdge,
  winnerKey,
} from "../../../src/decision/utils/runnerUtils.js";

describe("argmax", () => {
  it("returns the index of the max value", () => {
    expect(argmax([0.1, 0.7, 0.2])).toBe(1);
  });

  it("breaks ties toward the lowest index", () => {
    expect(argmax([0.5, 0.5, 0.2])).toBe(0);
  });

  it("throws on empty input", () => {
    expect(() => argmax([])).toThrow();
  });
});

describe("argmaxOption", () => {
  it("picks the highest-probability option in option order", () => {
    expect(argmaxOption({ a: 0.2, b: 0.8 }, ["a", "b"])).toBe("b");
  });

  it("treats missing probabilities as -Infinity", () => {
    expect(argmaxOption({ b: 0.1 }, ["a", "b"])).toBe("b");
  });
});

describe("winnerKey", () => {
  it("returns the choice winner", () => {
    expect(
      winnerKey({ type: "choice", winner: "speak", probabilities: {}, confidence: 1 }),
    ).toBe("speak");
  });

  it("maps noul at the 0.5 boundary", () => {
    expect(winnerKey({ type: "noul", pTrue: 0.9 })).toBe("true");
    expect(winnerKey({ type: "noul", pTrue: 0.1 })).toBe("false");
    expect(winnerKey({ type: "noul", pTrue: 0.5 })).toBe("true");
  });

  it("rounds the score expectation", () => {
    expect(winnerKey({ type: "score", expected: 2.6, distribution: {} })).toBe("3");
  });
});

describe("answerConfidence", () => {
  it("uses the winner probability for choice", () => {
    expect(
      answerConfidence(
        { type: "choice", winner: "b", probabilities: { a: 0.2, b: 0.8 }, confidence: 0.5 },
      ),
    ).toBe(0.8);
  });

  it("uses the winning side for noul", () => {
    expect(answerConfidence({ type: "noul", pTrue: 0.9 })).toBe(0.9);
    expect(answerConfidence({ type: "noul", pTrue: 0.2 })).toBe(0.8);
  });

  it("uses the rounded-level probability for score", () => {
    expect(
      answerConfidence({ type: "score", expected: 1.2, distribution: { 0: 0.1, 1: 0.7, 2: 0.2 } }),
    ).toBe(0.7);
  });
});

const DIAGRAM: DecisionDiagram = {
  nodes: [
    { id: "root", type: "choice", instructions: "r", options: ["a", "b"] },
    { id: "left", type: "noul", instructions: "l" },
    { id: "right", type: "noul", instructions: "r" },
    { id: "end", type: "noul", instructions: "e" },
  ],
  edges: [
    { from: "root", whenWinner: "a", to: "left" },
    { from: "root", whenWinner: "b", to: "right" },
    { from: "root", to: "end" },
    { from: "left", to: "end" },
    { from: "right", to: "end" },
  ],
  terminal: "end",
};

describe("routeEdge", () => {
  it("prefers the exact winner match over the default edge", () => {
    expect(routeEdge(DIAGRAM.edges, "root", "a")).toBe("left");
    expect(routeEdge(DIAGRAM.edges, "root", "b")).toBe("right");
  });

  it("falls back to the default edge", () => {
    expect(routeEdge(DIAGRAM.edges, "root", "zzz")).toBe("end");
  });

  it("returns undefined when nothing matches", () => {
    expect(routeEdge(DIAGRAM.edges, "left", "true")).toBe("end");
    expect(routeEdge([], "root", "a")).toBeUndefined();
  });
});

describe("rootsOf / groupByLevel / diagramDepth", () => {
  it("finds roots", () => {
    expect(rootsOf(DIAGRAM)).toEqual(["root"]);
  });

  it("assigns static levels", () => {
    const levels = groupByLevel(DIAGRAM);
    expect(levels.get("root")).toBe(0);
    expect(levels.get("left")).toBe(1);
    expect(levels.get("right")).toBe(1);
    expect(levels.get("end")).toBe(2);
  });

  it("measures depth as the longest path in edges", () => {
    expect(diagramDepth(DIAGRAM)).toBe(2);
  });
});
