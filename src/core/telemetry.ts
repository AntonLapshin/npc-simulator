// Turn-economics telemetry (Phase 6 of the renderer architecture).
//
// The turn pipeline is LLM-bound and multiplicative: (calls per turn) x
// (seconds per call). Eleven experiment rounds attacked seconds-per-call;
// nobody attacked calls-per-turn — where ~70% of the time went (exp-7:
// 5.3 consequence terminals per turn). This module is the pure half of
// the economics instrumentation: types, budget evaluation, and the
// generated-findings report formatting. Orchestration (counting,
// timing, logging) lives in src/engine/turnTelemetry.ts and
// src/engine/turnOrchestrator.ts; the CLI report is scripts/report-turns.ts.
//
// Pure: no I/O, no Date, no randomness. Every function is unit-tested.

/** Per-stage provider-call counts for one turn. */
export type TurnCallBreakdown = {
  proposal: number;
  selection: number;
  render: number;
};

/** How the turn resolved, for the economics report. */
export type TurnOutcome = "clean" | "liveness" | "fallback";

/**
 * One turn's economics record. Logged as the `turn_telemetry` JSONL
 * event and consumed by `npm run report:turns`.
 */
export type TurnTelemetry = {
  tick: number;
  turnIndex: number;
  actorId: string;
  /** Proposal engine call wall time. */
  proposalMs: number;
  /** Selection engine calls + screening + deterministic engine execution. */
  selectionExecuteMs: number;
  /** Render-engine provider calls (pure LLM time; excludes engine execution). */
  renderMs: number;
  /** Sum of the three stage buckets above. */
  totalMs: number;
  calls: TurnCallBreakdown;
  /** Sum of the per-stage call counts. */
  providerCalls: number;
  /** The turnCallBudget that applied. */
  budget: number;
  budgetExceeded: boolean;
  outcome: TurnOutcome;
};

/**
 * Phase 6: per-turn wall-time gate for `--auto`. A turn slower than this
 * prints a loud warning (it does not abort — a slow turn that avoids a
 * fallback is better than a fallback).
 */
export const TURN_TIME_GATE_MS = 90_000;

/** Phase 6: default provider-call budget per turn (EngineConfig.turnCallBudget). */
export const DEFAULT_TURN_CALL_BUDGET = 4;

/**
 * Evaluate one turn's provider-call count against its budget. Pure.
 * Exceeding is a warning, never an abort — a turn that needs 5 calls to
 * avoid a fallback is better than a fallback.
 */
export function evaluateBudget(
  providerCalls: number,
  budget: number,
): { exceeded: boolean; overBy: number } {
  const overBy = providerCalls - budget;
  return { exceeded: overBy > 0, overBy: Math.max(0, overBy) };
}

/**
 * The loud warning logged with (and printed for) a `budget_exceeded`
 * event. Pure.
 */
export function budgetWarningMessage(
  actorId: string,
  providerCalls: number,
  budget: number,
  calls: TurnCallBreakdown,
): string {
  return (
    `BUDGET EXCEEDED: turn for ${actorId} burned ${providerCalls} provider calls ` +
    `(budget ${budget}) — proposal ${calls.proposal} / selection ${calls.selection} / render ${calls.render}. ` +
    `Not aborting (a costly turn beats a fallback), but this is where the 73-minute burns come from.`
  );
}

/** Compact human duration: "45s", "1m 30s". Pure. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** Header for the --auto running table (one row per turn follows). */
export const TURN_TABLE_HEADER =
  "turn | tick | actor | proposal | sel+exec | render | total | calls P/S/R | outcome";

/**
 * One compact row of the --auto running table. Pure.
 */
export function formatTurnRow(n: number, t: TurnTelemetry): string {
  const calls = `${t.calls.proposal}/${t.calls.selection}/${t.calls.render}`;
  const flag = t.budgetExceeded ? " ⚠BUDGET" : "";
  return (
    `${String(n).padStart(4)} | ${String(t.tick).padStart(4)} | ${t.actorId.padEnd(6)} | ` +
    `${formatDuration(t.proposalMs).padStart(8)} | ${formatDuration(t.selectionExecuteMs).padStart(8)} | ` +
    `${formatDuration(t.renderMs).padStart(6)} | ${formatDuration(t.totalMs).padStart(5)} | ` +
    `${calls.padStart(9)} | ${t.outcome}${flag}`
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Parse JSONL log lines into turn-telemetry records. Malformed lines and
 * non-telemetry events are skipped (never throw on a dirty log). Pure.
 */
export function turnTelemetryFromLogLines(lines: string[]): TurnTelemetry[] {
  const out: TurnTelemetry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry?.event !== "turn_telemetry") continue;
    const t = entry?.output;
    if (
      typeof t?.tick !== "number" ||
      typeof t?.turnIndex !== "number" ||
      typeof t?.actorId !== "string" ||
      typeof t?.providerCalls !== "number"
    ) {
      continue;
    }
    out.push({
      tick: t.tick,
      turnIndex: t.turnIndex,
      actorId: t.actorId,
      proposalMs: t.proposalMs ?? 0,
      selectionExecuteMs: t.selectionExecuteMs ?? 0,
      renderMs: t.renderMs ?? 0,
      totalMs: t.totalMs ?? 0,
      calls: {
        proposal: t.calls?.proposal ?? 0,
        selection: t.calls?.selection ?? 0,
        render: t.calls?.render ?? 0,
      },
      providerCalls: t.providerCalls,
      budget: t.budget ?? DEFAULT_TURN_CALL_BUDGET,
      budgetExceeded: t.budgetExceeded ?? false,
      outcome: t.outcome ?? "clean",
    });
  }
  return out;
}

/**
 * The exp-7-style findings table, generated — never hand-written.
 * Summary + per-turn rows + per-stage aggregates. Pure.
 */
export function formatFindingsReport(turns: TurnTelemetry[]): string {
  if (turns.length === 0) {
    return "No turn_telemetry events found — run with the Phase-6 build so each turn logs its economics.";
  }
  const walls = turns.map((t) => t.totalMs);
  const calls = turns.map((t) => t.providerCalls);
  const totalCalls = sum(calls);
  const outcomes = {
    clean: turns.filter((t) => t.outcome === "clean").length,
    liveness: turns.filter((t) => t.outcome === "liveness").length,
    fallback: turns.filter((t) => t.outcome === "fallback").length,
  };
  const budgetBlown = turns.filter((t) => t.budgetExceeded).length;

  const lines: string[] = [];
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Turns with telemetry | ${turns.length} |`);
  lines.push(`| Total wall time | ${formatDuration(sum(walls))} |`);
  lines.push(`| Mean turn time | ${formatDuration(mean(walls))} |`);
  lines.push(`| Total provider calls | ${totalCalls} (mean ${(totalCalls / turns.length).toFixed(1)} / turn) |`);
  lines.push(`| Clean turns | ${outcomes.clean} / ${turns.length} |`);
  lines.push(`| Liveness-floor turns | ${outcomes.liveness} |`);
  lines.push(`| Fallback turns | ${outcomes.fallback} |`);
  lines.push(`| Turns over call budget | ${budgetBlown} |`);
  lines.push("");
  lines.push("## Per-turn economics");
  lines.push("");
  lines.push("| Turn | Tick | Actor | Wall | Calls (P/S/R) | Outcome |");
  lines.push("|---|---|---|---|---|---|---|");
  turns.forEach((t, i) => {
    const c = `${t.calls.proposal}/${t.calls.selection}/${t.calls.render}`;
    const flag = t.budgetExceeded ? " ⚠BUDGET" : "";
    lines.push(`| ${i + 1} | ${t.tick} | ${t.actorId} | ${formatDuration(t.totalMs)} | ${t.providerCalls} (${c}) | ${t.outcome}${flag} |`);
  });
  lines.push("");
  lines.push("## Per-stage latency");
  lines.push("");
  lines.push("| Stage | n | mean | median | max | total |");
  lines.push("|---|---|---|---|---|---|");
  const stages: Array<[string, number[]]> = [
    ["proposal", turns.map((t) => t.proposalMs)],
    ["selection+execute", turns.map((t) => t.selectionExecuteMs)],
    ["render", turns.map((t) => t.renderMs)],
  ];
  for (const [name, ms] of stages) {
    lines.push(
      `| ${name} | ${ms.length} | ${formatDuration(mean(ms))} | ${formatDuration(median(ms))} | ` +
      `${formatDuration(Math.max(...ms))} | ${formatDuration(sum(ms))} |`,
    );
  }
  return lines.join("\n");
}
