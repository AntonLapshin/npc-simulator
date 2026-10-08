import { describe, expect, it } from "vitest";
import type { World } from "../../../src/types.js";
import {
  buildCandidateState,
  buildIntentState,
  buildJudgeState,
  estimateTokens,
  STATE_CHAR_BUDGET,
  truncateToChars,
} from "../../../src/decision/decisionState.js";

function makeWorld(): World {
  return {
    version: 1,
    id: "w1",
    title: "Office",
    narrative: "",
    userActorId: "a1",
    order: ["a1", "a2"],
    tick: 3,
    turnIndex: 3,
    history: [
      { text: "Dana asked Anton about the deadline.", perceivers: ["a1", "a2"] },
      { text: "Anton said the auth fix needs two hours.", perceivers: ["a1", "a2"] },
      { text: "Mira refilled the coffee machine.", perceivers: ["a1", "a2"] },
    ],
    scene: {
      width: 10,
      height: 10,
      objects: [
        { id: "o1", name: "whiteboard", description: "", x: 1, y: 1, w: 2, h: 1, passable: false, blocksVision: false, blocksSound: false },
        { id: "o2", name: "coffee machine", description: "", x: 5, y: 5, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false },
      ],
    },
    actors: [
      {
        id: "a1", name: "Anton", persona: "A careful backend engineer who hates surprises.",
        x: 1, y: 1, state: "reviewing code", emotion: "focused",
        goal: "Ship the release before Friday.", thoughts: "The auth module is fragile.",
        memories: [], beliefs: [], relationships: [],
      },
      {
        id: "a2", name: "Dana", persona: "An anxious project manager.",
        x: 2, y: 2, state: "waiting", emotion: "anxious",
        goal: "Get a status update.", thoughts: "",
        memories: [], beliefs: [], relationships: [],
      },
    ],
  };
}

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("truncateToChars", () => {
  it("leaves short text alone", () => {
    expect(truncateToChars("hello", 10)).toBe("hello");
  });

  it("truncates long text with an ellipsis", () => {
    const out = truncateToChars("one two three four five", 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.endsWith("…")).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(truncateToChars("a\n\n  b", 10)).toBe("a b");
  });
});

describe("buildIntentState", () => {
  it("stays within the char budget and names the actor", () => {
    const state = buildIntentState(makeWorld(), "a1");
    expect(state.length).toBeLessThanOrEqual(STATE_CHAR_BUDGET);
    expect(estimateTokens(state)).toBeLessThanOrEqual(450);
    expect(state).toContain("Anton");
    expect(state).toContain("Ship the release");
    expect(state).toContain("Dana");
    expect(state).toContain("whiteboard");
  });

  it("throws for an unknown actor", () => {
    expect(() => buildIntentState(makeWorld(), "nope")).toThrow();
  });

  it("tolerates a missing thoughts field (untyped worlds, e.g. diagnose-ai stub)", () => {
    // scripts/diagnose-ai.ts is not typechecked (scripts/ excluded from
    // tsconfig) and builds its stub world without `thoughts`; the state
    // build must not crash on it (S9: "Cannot read properties of undefined
    // (reading 'trim')").
    const world = makeWorld();
    delete (world.actors[0] as unknown as Record<string, unknown>)["thoughts"];
    let state = "";
    expect(() => {
      state = buildIntentState(world, "a1");
    }).not.toThrow();
    expect(state).toContain("Anton");
    expect(state).not.toContain("Thinking:");
  });

  it("holds the budget even with huge inputs", () => {
    const world = makeWorld();
    world.actors[0]!.persona = "x".repeat(10000);
    world.actors[0]!.thoughts = "y".repeat(10000);
    world.history = Array.from({ length: 50 }, (_, i) => ({
      text: `event ${i} `.repeat(200),
      perceivers: ["a1"],
    }));
    const state = buildIntentState(world, "a1");
    expect(state.length).toBeLessThanOrEqual(STATE_CHAR_BUDGET);
  });
});

describe("buildCandidateState", () => {
  it("appends numbered candidates within budget", () => {
    const state = buildCandidateState(makeWorld(), "a1", ["Do X.", "Do Y."]);
    expect(state.length).toBeLessThanOrEqual(STATE_CHAR_BUDGET);
    expect(state).toContain("1. Do X.");
    expect(state).toContain("2. Do Y.");
  });
});

describe("buildJudgeState", () => {
  it("includes the action text and name inventories", () => {
    const state = buildJudgeState("Anton walks to the whiteboard.", ["Anton", "Dana"], ["whiteboard"]);
    expect(state.length).toBeLessThanOrEqual(STATE_CHAR_BUDGET);
    expect(state).toContain("Anton walks to the whiteboard.");
    expect(state).toContain("Dana");
    expect(state).toContain("whiteboard");
  });

  it("handles empty inventories", () => {
    const state = buildJudgeState("Someone waits.", [], []);
    expect(state).toContain("Someone waits.");
  });
});
