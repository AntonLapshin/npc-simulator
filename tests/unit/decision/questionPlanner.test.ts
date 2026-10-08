import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  clearDiagramCache,
  diagramCacheKey,
  diagramCacheSize,
  planDiagram,
  PlannerError,
} from "../../../src/decision/questionPlanner.js";
import { extractJsonObject } from "../../../src/decision/utils/jsonExtract.js";

const GOOD_DIAGRAM = JSON.stringify({
  nodes: [
    { id: "q1", type: "choice", instructions: "Which tool?", options: ["hammer", "wrench"] },
    { id: "q2", type: "noul", instructions: "Is it urgent?" },
  ],
  edges: [{ from: "q1", whenWinner: "hammer", to: "q2" }],
  terminal: "q2",
});

describe("diagramCacheKey", () => {
  it("is deterministic and sensitive to both inputs", () => {
    const a = diagramCacheKey("goal", "state");
    expect(diagramCacheKey("goal", "state")).toBe(a);
    expect(diagramCacheKey("goal!", "state")).not.toBe(a);
    expect(diagramCacheKey("goal", "state!")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("extractJsonObject", () => {
  it("pulls JSON out of prose and fences", () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a": 1}\n```\nDone')).toBe('{"a": 1}');
  });

  it("ignores braces inside strings", () => {
    expect(extractJsonObject('{"t": "a } b { c"}')).toBe('{"t": "a } b { c"}');
  });

  it("returns undefined when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeUndefined();
    expect(extractJsonObject('{"unclosed": true')).toBeUndefined();
  });
});

describe("planDiagram", () => {
  beforeEach(() => clearDiagramCache());

  it("parses a valid planner reply", async () => {
    const chatComplete = vi.fn(async () => `Some prose\n${GOOD_DIAGRAM}\n`);
    const diagram = await planDiagram("fix the sink", "kitchen state", chatComplete);
    expect(diagram.terminal).toBe("q2");
    expect(diagram.nodes).toHaveLength(2);
    expect(chatComplete).toHaveBeenCalledOnce();
  });

  it("caches by (goal, stateSummary) within the TTL", async () => {
    const chatComplete = vi.fn(async () => GOOD_DIAGRAM);
    const first = await planDiagram("g", "s", chatComplete);
    const second = await planDiagram("g", "s", chatComplete);
    expect(second).toEqual(first);
    expect(chatComplete).toHaveBeenCalledOnce();
    expect(diagramCacheSize()).toBe(1);
  });

  it("bypasses the cache when ttl is 0", async () => {
    const chatComplete = vi.fn(async () => GOOD_DIAGRAM);
    await planDiagram("g", "s", chatComplete, { cacheTtlMs: 0 });
    await planDiagram("g", "s", chatComplete, { cacheTtlMs: 0 });
    expect(chatComplete).toHaveBeenCalledTimes(2);
    expect(diagramCacheSize()).toBe(0);
  });

  it("throws PlannerError on non-JSON output", async () => {
    await expect(planDiagram("g", "s", async () => "no json at all")).rejects.toThrow(
      PlannerError,
    );
  });

  it("throws PlannerError when the diagram violates safety caps", async () => {
    const bad = JSON.stringify({
      nodes: [
        {
          id: "q1",
          type: "choice",
          instructions: "Pick.",
          options: Array.from({ length: 20 }, (_, i) => `o${i}`),
        },
      ],
      edges: [],
      terminal: "q1",
    });
    await expect(planDiagram("g", "s", async () => bad)).rejects.toThrow(PlannerError);
  });

  it("throws PlannerError when the chat call fails", async () => {
    const chatComplete = async () => {
      throw new Error("boom");
    };
    await expect(planDiagram("g", "s", chatComplete)).rejects.toThrow(PlannerError);
  });

  it("does not cache failed plans", async () => {
    await expect(planDiagram("g", "s", async () => "garbage")).rejects.toThrow(PlannerError);
    expect(diagramCacheSize()).toBe(0);
  });
});
