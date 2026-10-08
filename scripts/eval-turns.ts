// Phase 5 eval driver (LAYA_PLAN.md): run N scripted turns in --mode=chat
// vs --mode=laya and report the Phase-5 comparison metrics.
//
// Runs on the OWNER'S MACHINE — never in CI. Do NOT attempt a live run in
// automation; see the RUNBOOK section of LAYA_PLAN.md.
//
// Requirements:
//   - Ollama serving the configured models (`npm run setup:ollama`)
//   - for --mode=laya: laya-serve answering at LAYA_URL (`npm run serve:laya`)
//   - identical LLM settings for both runs (same .env); only the LAYA_*
//     flags differ between the two modes.
//
// Usage:
//   tsx scripts/eval-turns.ts --mode=chat|laya --turns=30 \
//     [--scenario=scenarios/office-anton.json] [--out=logs/eval-turns.json]
//
// Metrics (definitions: see LAYA_PLAN.md RUNBOOK):
//   applied-turn rate, selection format failures, judge LLM calls,
//   turns/hour, LLM calls/turn, observer thought-churn.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "../src/logging/logger.js";
import { loadEnvFile } from "../src/util/loadEnv.js";
import { resolveConfig } from "../src/config.js";
import { createLlmEngines } from "../src/llm/index.js";
import { loadScenario } from "../src/engine/scenarioLoader.js";
import { runTurns } from "../src/engine/turnOrchestrator.js";
import type { EngineDependencies } from "../src/engine/turnOrchestrator.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(ROOT);

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

function usage(): never {
  console.log(
    [
      "Usage: tsx scripts/eval-turns.ts --mode=chat|laya --turns=N",
      "         [--scenario=scenarios/office-anton.json] [--out=logs/eval-turns.json]",
      "",
      "Runs N scripted turns and reports Phase-5 metrics. Needs Ollama (+models);",
      "--mode=laya additionally needs laya-serve. See LAYA_PLAN.md RUNBOOK.",
    ].join("\n"),
  );
  process.exit(2);
}

const mode = argValue("mode");
if (mode !== "chat" && mode !== "laya") usage();
const turns = Math.max(1, Number.parseInt(argValue("turns") ?? "30", 10));
if (!Number.isFinite(turns)) usage();
const scenarioPath = resolve(ROOT, argValue("scenario") ?? "scenarios/office-anton.json");
const outPath = argValue("out");

// ---------------------------------------------------------------------------
// Laya profile for --mode=laya (explicit env wins over these defaults)
// ---------------------------------------------------------------------------

if (mode === "laya") {
  const profile: Record<string, string> = {
    LAYA_MODE: "static",
    LAYA_SELECTION: "1",
    LAYA_JUDGE: "1",
    LAYA_TRIAGE: "1",
    LAYA_SALIENCE: "1",
  };
  for (const [k, v] of Object.entries(profile)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  // LAYA_PLANNER and LAYA_PLAUSIBILITY stay off: the planner gets its own
  // eval, and plausibility is advisory-only by design.
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type EvalMetrics = {
  mode: string;
  scenario: string;
  turns: number;
  elapsedMs: number;
  /** Fraction of turns whose consequence was not the "Nothing changes." fallback. */
  appliedTurnRate: number;
  /** selection_failed + selection_rejected log records (format/repeat screens). */
  selectionFormatFailures: number;
  /** semantic_completed records (chat judge calls; ~0 expected in laya mode). */
  judgeLlmCalls: number;
  turnsPerHour: number;
  /**
   * Engine completion records (proposal/selection/consequence/semantic
   * *_completed + *_failed) per turn. Laya decisions are not LLM calls and
   * are excluded by construction.
   */
  llmCallsPerTurn: number;
  /** Observer (non-acting) actorPatches carrying thoughts, per turn. */
  observerThoughtChurnPerTurn: number;
  /** module=laya event counts (empty in chat mode). */
  layaEvents: Record<string, number>;
};

const LLM_CALL_MODULES = new Set(["proposal", "selection", "consequence", "semantic"]);

async function main(): Promise<void> {
  const logger = new Logger({
    sessionId: `eval_${mode}_${Date.now().toString(36)}`,
    logDir: join(ROOT, "logs"),
    writeToFile: false, // in-memory only; metrics read from logger.store
  });

  const world = loadScenario(
    JSON.parse(readFileSync(scenarioPath, "utf-8")),
    logger,
  );
  const engines = createLlmEngines(logger, { env: process.env });
  const deps: EngineDependencies = {
    ...engines,
    logger,
    config: resolveConfig({ autosaveEnabled: false }),
    // Scripted user: the user actor keeps working instead of blocking on
    // stdin, so long unattended runs are possible. Documented in RUNBOOK.
    getUserAction: async () => "continues working quietly.",
  };

  console.log(
    `eval-turns: mode=${mode} turns=${turns} scenario=${scenarioPath}`,
  );
  console.log(
    `eval-turns: LAYA_MODE=${process.env["LAYA_MODE"] ?? "off"} ` +
      `SELECTION=${process.env["LAYA_SELECTION"] ?? "0"} JUDGE=${process.env["LAYA_JUDGE"] ?? "0"} ` +
      `TRIAGE=${process.env["LAYA_TRIAGE"] ?? "0"} SALIENCE=${process.env["LAYA_SALIENCE"] ?? "0"}`,
  );

  const startedAt = Date.now();
  await runTurns(world, deps, turns);
  const elapsedMs = Date.now() - startedAt;

  const entries = logger.store.all();
  const fallbackTurns = entries.filter((e) => e.event === "fallback_used").length;
  const selectionFormatFailures = entries.filter(
    (e) =>
      e.module === "selection" &&
      (e.event === "selection_failed" || e.event === "selection_rejected"),
  ).length;
  const judgeLlmCalls = entries.filter(
    (e) => e.module === "semantic" && e.event === "semantic_completed",
  ).length;
  const llmCalls = entries.filter(
    (e) => LLM_CALL_MODULES.has(e.module) && /_(completed|failed)$/.test(e.event),
  ).length;

  let observerThoughts = 0;
  for (const e of entries) {
    if (e.event !== "patch_applied") continue;
    const input = e.input as
      | { action?: { actorId?: string }; consequence?: { actorPatches?: Array<{ actorId?: string; thoughts?: string }> } }
      | undefined;
    const actingId = input?.action?.actorId;
    for (const p of input?.consequence?.actorPatches ?? []) {
      if (p.actorId !== actingId && p.thoughts !== undefined) observerThoughts++;
    }
  }

  const layaEvents: Record<string, number> = {};
  for (const e of entries) {
    if (e.module !== "laya") continue;
    layaEvents[e.event] = (layaEvents[e.event] ?? 0) + 1;
  }

  const metrics: EvalMetrics = {
    mode: mode!,
    scenario: scenarioPath,
    turns,
    elapsedMs,
    appliedTurnRate: (turns - fallbackTurns) / turns,
    selectionFormatFailures,
    judgeLlmCalls,
    turnsPerHour: turns / (elapsedMs / 3_600_000),
    llmCallsPerTurn: llmCalls / turns,
    observerThoughtChurnPerTurn: observerThoughts / turns,
    layaEvents,
  };

  const rows: Array<[string, string]> = [
    ["applied-turn rate", `${(metrics.appliedTurnRate * 100).toFixed(1)}%`],
    ["selection format failures", String(metrics.selectionFormatFailures)],
    ["judge LLM calls", String(metrics.judgeLlmCalls)],
    ["turns/hour", metrics.turnsPerHour.toFixed(1)],
    ["LLM calls/turn", metrics.llmCallsPerTurn.toFixed(2)],
    ["observer thought-churn/turn", metrics.observerThoughtChurnPerTurn.toFixed(2)],
    ["elapsed", `${(elapsedMs / 1000).toFixed(1)}s`],
  ];
  console.log("\nmode  metric                        value");
  console.log("----  ----------------------------  -----");
  for (const [k, v] of rows) {
    console.log(`${mode!.padEnd(4)}  ${k.padEnd(28)}  ${v}`);
  }
  if (Object.keys(layaEvents).length > 0) {
    console.log("\nlaya events:", JSON.stringify(layaEvents));
  }

  if (outPath !== undefined) {
    const full = resolve(ROOT, outPath);
    writeFileSync(full, JSON.stringify(metrics, null, 2));
    console.log(`\nwrote ${full}`);
  }
}

main().catch((err) => {
  console.error(`eval-turns failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
