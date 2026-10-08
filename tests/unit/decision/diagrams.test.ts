import { describe, expect, it } from "vitest";
import type { DecisionDiagram } from "../../../src/decision/decisionTypes.js";
import {
  buildJudgeQuestions,
  OBSERVER_TRIAGE_QUESTION,
  SALIENCE_QUESTION,
  SELECTION_CASCADE,
  validateDiagram,
} from "../../../src/decision/diagrams.js";

function base(): DecisionDiagram {
  return {
    nodes: [
      { id: "a", type: "choice", instructions: "Pick.", options: ["x", "y"] },
      { id: "b", type: "noul", instructions: "True?" },
    ],
    edges: [{ from: "a", whenWinner: "x", to: "b" }],
    terminal: "b",
  };
}

describe("validateDiagram", () => {
  it("accepts the static SELECTION_CASCADE", () => {
    expect(validateDiagram(SELECTION_CASCADE)).toEqual({
      ok: true,
      diagram: SELECTION_CASCADE,
    });
  });

  it("accepts a minimal valid diagram", () => {
    const result = validateDiagram(base());
    expect(result.ok).toBe(true);
  });

  it("rejects non-object input with schema errors", () => {
    const result = validateDiagram("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects depth > 4", () => {
    const d = base();
    d.nodes = [
      { id: "n0", type: "noul", instructions: "0?" },
      { id: "n1", type: "noul", instructions: "1?" },
      { id: "n2", type: "noul", instructions: "2?" },
      { id: "n3", type: "noul", instructions: "3?" },
      { id: "n4", type: "noul", instructions: "4?" },
      { id: "n5", type: "noul", instructions: "5?" },
    ];
    d.edges = [
      { from: "n0", to: "n1" },
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3" },
      { from: "n3", to: "n4" },
      { from: "n4", to: "n5" },
    ];
    d.terminal = "n5";
    const result = validateDiagram(d);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("depth"))).toBe(true);
  });

  it("rejects more than 12 options", () => {
    const d = base();
    d.nodes[0] = {
      id: "a",
      type: "choice",
      instructions: "Pick.",
      options: Array.from({ length: 13 }, (_, i) => `opt${i}`),
    };
    const result = validateDiagram(d);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("13 options"))).toBe(true);
  });

  it("rejects duplicate and empty options", () => {
    const dup = base();
    dup.nodes[0] = { id: "a", type: "choice", instructions: "Pick.", options: ["x", "x"] };
    const r1 = validateDiagram(dup);
    expect(r1.ok).toBe(false);

    const empty = base();
    empty.nodes[0] = { id: "a", type: "choice", instructions: "Pick.", options: [] };
    // [] fails the zod min(1) on DecisionDiagramSchema.nodes? No — options min
    // is enforced by validateDiagram's own check; schema allows optional.
    const r2 = validateDiagram(empty);
    expect(r2.ok).toBe(false);
  });

  it("rejects an unknown terminal and dangling edges", () => {
    const d = base();
    d.terminal = "ghost";
    const r1 = validateDiagram(d);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors.some((e) => e.includes("terminal"))).toBe(true);

    const d2 = base();
    d2.edges = [{ from: "a", to: "ghost" }];
    const r2 = validateDiagram(d2);
    expect(r2.ok).toBe(false);
  });

  it("rejects duplicate node ids", () => {
    const d = base();
    d.nodes.push({ id: "a", type: "noul", instructions: "dup?" });
    const result = validateDiagram(d);
    expect(result.ok).toBe(false);
  });
});

describe("buildJudgeQuestions", () => {
  it("builds the five-question batched set", () => {
    const qs = buildJudgeQuestions(["Anton", "Dana"], ["whiteboard"]);
    expect(Object.keys(qs).sort()).toEqual(
      ["q_addressee", "q_contact", "q_destination", "q_moves", "q_speaks"].sort(),
    );
    expect(qs["q_moves"]!.type).toBe("noul");
    expect(qs["q_speaks"]!.type).toBe("noul");
    const addressee = qs["q_addressee"]!;
    expect(addressee.type).toBe("choice");
    if (addressee.type === "choice") {
      expect(addressee.options).toContain("Anton");
      expect(addressee.options).toContain("nobody in particular");
    }
    const destination = qs["q_destination"]!;
    if (destination.type === "choice") {
      expect(destination.options).toContain("whiteboard");
      expect(destination.options).toContain("Dana");
    }
  });
});

describe("static triage/salience questions", () => {
  it("has the expected shapes", () => {
    expect(OBSERVER_TRIAGE_QUESTION.type).toBe("noul");
    expect(SALIENCE_QUESTION.type).toBe("score");
    if (SALIENCE_QUESTION.type === "score") {
      expect(SALIENCE_QUESTION.levels).toEqual(["1", "2", "3", "4", "5"]);
    }
  });
});
