// Phase 6: `npm run report:turns` regenerates the findings table from a
// run's log. This test runs the real script against a fixture JSONL and
// asserts the table output.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

function telemetryLine(output: unknown): string {
  return JSON.stringify({ event: "turn_telemetry", output });
}

describe("report:turns", () => {
  it("regenerates the findings table from a fixture log", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-turns-"));
    const logPath = join(dir, "session.jsonl");
    writeFileSync(
      logPath,
      [
        JSON.stringify({ event: "turn_started", tick: 0 }),
        "not json",
        "",
        telemetryLine({
          tick: 0, turnIndex: 0, actorId: "anton",
          proposalMs: 1000, selectionExecuteMs: 500, renderMs: 20000, totalMs: 21500,
          calls: { proposal: 1, selection: 1, render: 1 },
          providerCalls: 3, budget: 4, budgetExceeded: false, outcome: "clean",
        }),
        telemetryLine({
          tick: 1, turnIndex: 1, actorId: "tanya",
          proposalMs: 2000, selectionExecuteMs: 1000, renderMs: 60000, totalMs: 63000,
          calls: { proposal: 1, selection: 1, render: 4 },
          providerCalls: 6, budget: 4, budgetExceeded: true, outcome: "fallback",
        }),
      ].join("\n"),
    );

    const stdout = execFileSync(
      join(ROOT, "node_modules", ".bin", "tsx"),
      [join(ROOT, "scripts", "report-turns.ts"), logPath],
      { encoding: "utf-8", cwd: ROOT, timeout: 60_000 },
    );

    expect(stdout).toContain("# Turn economics");
    expect(stdout).toContain("do not hand-edit");
    expect(stdout).toContain("| Turns with telemetry | 2 |");
    expect(stdout).toContain("| Total provider calls | 9 (mean 4.5 / turn) |");
    expect(stdout).toContain("| Clean turns | 1 / 2 |");
    expect(stdout).toContain("| Fallback turns | 1 |");
    expect(stdout).toContain("| Turns over call budget | 1 |");
    expect(stdout).toContain("| 1 | 0 | anton |");
    expect(stdout).toContain("| 2 | 1 | tanya |");
    expect(stdout).toContain("6 (1/1/4)");
    expect(stdout).toContain("⚠BUDGET");
    expect(stdout).toContain("| Stage | n | mean | median | max | total |");
  });

  it("exits 2 with guidance when the log has no telemetry", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-turns-"));
    const logPath = join(dir, "old.jsonl");
    writeFileSync(logPath, JSON.stringify({ event: "turn_started", tick: 0 }));

    let stderr = "";
    try {
      execFileSync(
        join(ROOT, "node_modules", ".bin", "tsx"),
        [join(ROOT, "scripts", "report-turns.ts"), logPath],
        { encoding: "utf-8", cwd: ROOT, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect.unreachable("script should exit non-zero");
    } catch (err: any) {
      expect(err.status).toBe(2);
      stderr = err.stderr?.toString() ?? "";
    }
    expect(stderr).toContain("no turn_telemetry events");
  });
});
