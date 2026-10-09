// Phase 6: exhaustive unit tests for the pure telemetry core
// (src/core/telemetry.ts). Branch coverage enumerated by hand.

import { describe, expect, it } from "vitest";
import {
  budgetWarningMessage,
  DEFAULT_TURN_CALL_BUDGET,
  evaluateBudget,
  formatDuration,
  formatFindingsReport,
  formatTurnRow,
  TURN_TABLE_HEADER,
  TURN_TIME_GATE_MS,
  turnTelemetryFromLogLines,
  type TurnTelemetry,
} from "../../../src/core/telemetry.js";

function makeTelemetry(overrides: Partial<TurnTelemetry> = {}): TurnTelemetry {
  return {
    tick: 3,
    turnIndex: 1,
    actorId: "dana",
    proposalMs: 1200,
    selectionExecuteMs: 800,
    renderMs: 25000,
    totalMs: 27000,
    calls: { proposal: 1, selection: 1, render: 1 },
    providerCalls: 3,
    budget: 4,
    budgetExceeded: false,
    outcome: "clean",
    ...overrides,
  };
}

describe("evaluateBudget", () => {
  it("zero calls never exceeds", () => {
    expect(evaluateBudget(0, 4)).toEqual({ exceeded: false, overBy: 0 });
  });

  it("exactly at budget does not exceed", () => {
    expect(evaluateBudget(4, 4)).toEqual({ exceeded: false, overBy: 0 });
  });

  it("one over exceeds by one", () => {
    expect(evaluateBudget(5, 4)).toEqual({ exceeded: true, overBy: 1 });
  });

  it("far over reports the full overage", () => {
    expect(evaluateBudget(11, 4)).toEqual({ exceeded: true, overBy: 7 });
  });

  it("custom budgets are honored", () => {
    expect(evaluateBudget(2, 2).exceeded).toBe(false);
    expect(evaluateBudget(3, 2)).toEqual({ exceeded: true, overBy: 1 });
  });

  it("default budget constant is 4", () => {
    expect(DEFAULT_TURN_CALL_BUDGET).toBe(4);
  });
});

describe("budgetWarningMessage", () => {
  it("names the actor, count, budget, and per-stage split", () => {
    const msg = budgetWarningMessage("dana", 7, 4, { proposal: 2, selection: 1, render: 4 });
    expect(msg).toContain("BUDGET EXCEEDED");
    expect(msg).toContain("dana");
    expect(msg).toContain("7 provider calls");
    expect(msg).toContain("budget 4");
    expect(msg).toContain("proposal 2 / selection 1 / render 4");
    expect(msg).toContain("Not aborting");
  });
});

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45000)).toBe("45s");
    expect(formatDuration(59999)).toBe("1m 0s");
  });

  it("formats minute-plus durations as m s", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(366000)).toBe("6m 6s");
  });

  it("clamps negatives to zero", () => {
    expect(formatDuration(-500)).toBe("0s");
  });

  it("rounds to whole seconds", () => {
    expect(formatDuration(1499)).toBe("1s");
    expect(formatDuration(1500)).toBe("2s");
  });
});

describe("turn-time gate constant", () => {
  it("is 90 seconds", () => {
    expect(TURN_TIME_GATE_MS).toBe(90_000);
  });
});

describe("formatTurnRow", () => {
  it("renders a compact one-line row with all fields", () => {
    const row = formatTurnRow(1, makeTelemetry());
    expect(row).toContain("dana");
    expect(row).toContain("1/1/1");
    expect(row).toContain("clean");
    expect(row).not.toContain("\n");
  });

  it("flags budget-exceeded turns", () => {
    const row = formatTurnRow(2, makeTelemetry({ budgetExceeded: true, providerCalls: 6 }));
    expect(row).toContain("⚠BUDGET");
  });

  it("renders each outcome kind", () => {
    expect(formatTurnRow(1, makeTelemetry({ outcome: "liveness" }))).toContain("liveness");
    expect(formatTurnRow(1, makeTelemetry({ outcome: "fallback" }))).toContain("fallback");
  });

  it("header names the columns", () => {
    expect(TURN_TABLE_HEADER).toContain("proposal");
    expect(TURN_TABLE_HEADER).toContain("sel+exec");
    expect(TURN_TABLE_HEADER).toContain("render");
    expect(TURN_TABLE_HEADER).toContain("calls P/S/R");
  });
});

describe("turnTelemetryFromLogLines", () => {
  function logLine(output: unknown, event = "turn_telemetry"): string {
    return JSON.stringify({ event, output });
  }

  it("parses turn_telemetry events into records", () => {
    const lines = [
      logLine({ tick: 0, turnIndex: 0, actorId: "anton", proposalMs: 100, selectionExecuteMs: 50, renderMs: 900, totalMs: 1050, calls: { proposal: 0, selection: 0, render: 1 }, providerCalls: 1, budget: 4, budgetExceeded: false, outcome: "clean" }),
      logLine({ tick: 1, turnIndex: 1, actorId: "tanya", providerCalls: 5, budget: 4, budgetExceeded: true, outcome: "fallback" }),
    ];
    const turns = turnTelemetryFromLogLines(lines);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.actorId).toBe("anton");
    expect(turns[0]!.renderMs).toBe(900);
    expect(turns[1]!.budgetExceeded).toBe(true);
    // Missing optional numerics default to 0 / sane defaults.
    expect(turns[1]!.proposalMs).toBe(0);
    expect(turns[1]!.calls).toEqual({ proposal: 0, selection: 0, render: 0 });
  });

  it("skips blank lines, malformed JSON, other events, and bad shapes", () => {
    const lines = [
      "",
      "   ",
      "not json at all",
      JSON.stringify({ event: "turn_completed", output: {} }),
      logLine({ tick: "zero", actorId: "anton", providerCalls: 1 }),
      logLine({ event: "turn_telemetry" }),
      logLine({ tick: 2, turnIndex: 0, actorId: "dana", providerCalls: 2, outcome: "clean" }),
    ];
    const turns = turnTelemetryFromLogLines(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.actorId).toBe("dana");
  });
});

describe("formatFindingsReport", () => {
  it("reports empty input plainly", () => {
    expect(formatFindingsReport([])).toContain("No turn_telemetry events");
  });

  it("summarizes totals, means, outcomes, and budget breaches", () => {
    const turns = [
      makeTelemetry({ tick: 0, turnIndex: 0, actorId: "anton", totalMs: 60_000, providerCalls: 1, outcome: "clean" }),
      makeTelemetry({ tick: 1, turnIndex: 1, actorId: "tanya", totalMs: 120_000, providerCalls: 6, budgetExceeded: true, outcome: "fallback", calls: { proposal: 1, selection: 1, render: 4 } }),
      makeTelemetry({ tick: 2, turnIndex: 2, actorId: "dana", totalMs: 60_000, providerCalls: 2, outcome: "liveness" }),
    ];
    const report = formatFindingsReport(turns);
    expect(report).toContain("| Turns with telemetry | 3 |");
    expect(report).toContain("| Total provider calls | 9 (mean 3.0 / turn) |");
    expect(report).toContain("| Clean turns | 1 / 3 |");
    expect(report).toContain("| Liveness-floor turns | 1 |");
    expect(report).toContain("| Fallback turns | 1 |");
    expect(report).toContain("| Turns over call budget | 1 |");
    // Per-turn rows.
    expect(report).toContain("| 2 | 1 | tanya |");
    expect(report).toContain("6 (1/1/4)");
    expect(report).toContain("⚠BUDGET");
    // Per-stage table.
    expect(report).toContain("| Stage | n | mean | median | max | total |");
    expect(report).toContain("| proposal |");
    expect(report).toContain("| selection+execute |");
    expect(report).toContain("| render |");
  });

  it("computes median correctly for an even count", () => {
    const turns = [
      makeTelemetry({ renderMs: 10_000 }),
      makeTelemetry({ renderMs: 30_000 }),
    ];
    const report = formatFindingsReport(turns);
    // Median of (10s, 30s) = 20s.
    expect(report).toMatch(/\| render \| 2 \| .* \| 20s \|/);
  });
});
