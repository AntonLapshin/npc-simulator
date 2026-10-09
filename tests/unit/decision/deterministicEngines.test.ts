// Tests for the deterministic fallback engines
// (src/decision/deterministicEngines.ts). Phase 5: last resort when the
// Laya cascade is unavailable and LLM_DECISION_FALLBACK=0.
import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_SUGGESTIONS,
  DeterministicProposalEngine,
  DeterministicSelectionEngine,
} from "../../../src/decision/deterministicEngines.js";
import { makeTinyWorld } from "../../helpers.js";

describe("DeterministicProposalEngine", () => {
  it("returns the fixed suggestion set", async () => {
    const result = await new DeterministicProposalEngine().propose(makeTinyWorld(), "u");
    expect(result.suggestions).toEqual(DETERMINISTIC_SUGGESTIONS);
    expect(result.reasoning).toContain("LLM_DECISION_FALLBACK=0");
  });
  it("returns a fresh array each call", async () => {
    const engine = new DeterministicProposalEngine();
    const a = await engine.propose(makeTinyWorld(), "u");
    const b = await engine.propose(makeTinyWorld(), "u");
    expect(a.suggestions).not.toBe(b.suggestions);
  });
});

describe("DeterministicSelectionEngine", () => {
  it("picks the first suggestion", async () => {
    const result = await new DeterministicSelectionEngine().select(
      makeTinyWorld(), "u", ["b", "a"],
    );
    expect(result.action).toBe("b");
    expect(result.reasoning).toContain("first suggestion");
  });
  it("falls back to a fixed sentence on empty suggestions", async () => {
    const result = await new DeterministicSelectionEngine().select(makeTinyWorld(), "u", []);
    expect(result.action).toBe(DETERMINISTIC_SUGGESTIONS[0]);
  });
});
