// PLAN_V2 Phase 6: --compare must count failed attempts that burned
// provider calls (the Stage-3 36-vs-34 lesson). A fallback engine that
// retries internally logs *_failed events WITH usage payloads but no
// *_completed — counting only completions understates the true
// per-turn call cost. These tests fabricate such logs and assert the
// failedDecisionCalls tally.
import { describe, expect, it } from "vitest";
import { decisionStats } from "../../scripts/eval-run-quality.js";

function ev(event: string, usage?: { promptTokens: number }): Record<string, unknown> {
  return usage === undefined ? { event } : { event, usage };
}

describe("--compare failed-attempt call counting (Stage-3 lesson)", () => {
  it("counts usage-carrying failed attempts as provider calls", () => {
    const events = [
      ev("proposal_completed"),
      ev("proposal_completed"),
      // Two failed intent attempts that burned provider calls…
      ev("intent_failed", { promptTokens: 100 }),
      ev("intent_failed", { promptTokens: 100 }),
      // …and one failure with no usage (prompt-build error, no call).
      ev("intent_failed"),
    ];
    const stats = decisionStats(events);
    expect(stats.llmProposalCalls).toBe(2);
    expect(stats.failedDecisionCalls).toBe(2);
  });

  it("counts legacy Stage-3 event names too (proposal_failed / selection_failed)", () => {
    const events = [
      ev("proposal_completed"),
      ev("proposal_failed", { promptTokens: 50 }),
      ev("selection_failed", { promptTokens: 50 }),
      ev("selection_failed"), // no usage → not a provider call
    ];
    const stats = decisionStats(events);
    expect(stats.failedDecisionCalls).toBe(2);
  });

  it("ignores usage-less failures and counts usage payloads separately", () => {
    const events = [
      ev("intent_completed", { promptTokens: 200 }),
      ev("intent_failed"),
      ev("consequence_failed", { promptTokens: 300 }),
    ];
    const stats = decisionStats(events);
    expect(stats.failedDecisionCalls).toBe(0);
    // usageEvents counts every payload-carrying event (consequence leg).
    expect(stats.usageEvents).toBe(2);
  });
});
