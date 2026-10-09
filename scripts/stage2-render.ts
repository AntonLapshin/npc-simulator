// Stage 2 — Render-honesty battery (renderer-architecture shakedown).
//
// Dishonest mock renders through the FULL turn pipeline (proposal ->
// selection -> engine execute -> render -> prose validation) on fresh
// scenarios/office-anton.json worlds (Anton at tick 0 every case). Each
// case asserts what the Stage-2 architectural claim requires:
//   - an honest render is accepted on attempt 1 (1 render call, clean turn)
//   - a render that invents movement / the wrong destination / a phantom
//     manipulation is REJECTED with the grounding code, retried once, and
//     the honest retry wins (state matches the engine facts, not the lie)
//   - an altered quote is repaired deterministically (no retry burned)
//   - an unrecoverable render falls back gracefully (sentinel in history,
//     no state corruption, render calls within budget)
//
// Usage: npx tsx scripts/stage2-render.ts
// Exit code 1 when any check fails.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_DONE_SENTINEL, type Action, type ConsequenceResult, type World } from "../src/types.js";
import type { ConsequenceEngine, ConsequenceResolveOpts } from "../src/intelligence/types.js";
import { loadScenario } from "../src/engine/scenarioLoader.js";
import { runTurn, type EngineDependencies } from "../src/engine/turnOrchestrator.js";
import { MockProposalEngine } from "../src/mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../src/mocks/mockSelectionEngine.js";
import { Logger } from "../src/logging/logger.js";
import { defaultConfig } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

type Prose = Pick<ConsequenceResult, "narrative" | "thoughts" | "emotion" | "reasoning">;

const NEUTRAL_THOUGHTS = "Stay friendly and calm.";
const NEUTRAL_REASONING = "stage2 battery: narrate the executed facts.";

/** Attempt-scripted render stub: attempt N returns attempts[N-1] (last repeats). */
class ScriptedRender implements ConsequenceEngine {
  readonly providerBacked = true;
  calls = 0;
  constructor(private readonly attempts: Prose[]) {}
  async resolve(
    _world: World,
    _action: Action,
    _feedback?: string,
    _opts?: ConsequenceResolveOpts,
  ): Promise<ConsequenceResult> {
    this.calls++;
    const i = Math.min(this.calls, this.attempts.length) - 1;
    return structuredClone(this.attempts[i]!);
  }
}

function prose(narrative: string): Prose {
  return { narrative, thoughts: NEUTRAL_THOUGHTS, emotion: "friendly", reasoning: NEUTRAL_REASONING };
}

function loadOfficeAnton(): World {
  const raw = JSON.parse(readFileSync(join(ROOT, "scenarios/office-anton.json"), "utf-8"));
  return loadScenario(raw);
}

function historyLast(w: World): string {
  const h = w.history.at(-1);
  if (!h) return "";
  return typeof h === "string" ? h : (h.text ?? "");
}

function pos(w: World, id: string): [number, number] {
  const a = w.actors.find((x) => x.id === id);
  if (!a) throw new Error(`unknown actor ${id}`);
  return [a.x, a.y];
}

function prop(w: World, id: string): string | null {
  const a = w.actors.find((x) => x.id === id);
  if (!a) throw new Error(`unknown actor ${id}`);
  return (a.prop ?? null) as string | null;
}

type CaseResult = { world: World; logger: Logger; render: ScriptedRender };

async function runCase(label: string, action: string, attempts: Prose[]): Promise<CaseResult> {
  const world = loadOfficeAnton();
  const logger = new Logger({ sessionId: `stage2-${label}` });
  const tick = world.tick;
  const render = new ScriptedRender(attempts);
  const deps: EngineDependencies = {
    proposalEngine: new MockProposalEngine(logger, {
      [`anton@tick${tick}`]: { suggestions: [action], reasoning: "stage2 battery" },
    }),
    selectionEngine: new MockSelectionEngine(logger, {
      [`anton@tick${tick}`]: { action, reasoning: "stage2 battery" },
    }),
    consequenceEngine: render,
    logger,
    config: { ...defaultConfig, autosaveEnabled: false },
    getUserAction: async () => action,
    forceAllNpc: true,
  };
  const out = await runTurn(world, deps);
  return { world: out, logger, render };
}

function logEvents(logger: Logger, event: string): Array<{ [k: string]: unknown }> {
  return logger.store.all().filter((e) => e.event === event) as unknown as Array<{ [k: string]: unknown }>;
}

function failedCodes(logger: Logger): string {
  return logEvents(logger, "render_failed")
    .map((e) => JSON.stringify((e["validationErrors"] as unknown) ?? (e as { input?: unknown })["input"]))
    .join(" ");
}

function acceptedAttempts(logger: Logger): number[] {
  return logEvents(logger, "render_accepted").map((e) => {
    const input = (e as { input?: { attempt?: unknown } })["input"];
    return typeof input?.attempt === "number" ? input.attempt : -1;
  });
}

function telemetryOutcome(logger: Logger): string {
  const t = logEvents(logger, "turn_telemetry").at(-1) as
    | { output?: { outcome?: unknown; providerCalls?: unknown } }
    | undefined;
  return typeof t?.output?.outcome === "string" ? t.output.outcome : "?";
}

const QUOTE = "Morning \u2014 is my laptop ready for the demo?";
const QUOTE2 = "Nice place you have here.";
const WAVE = "Anton waves at Tanya.";
// NOTE: worded without "hand" — the manipulation/contact detectors key on
// the "hand" noun ("raises a hand" reads as a hand-over + contact claim),
// a known over-eager pattern recorded as finding F1 in the Stage-2 report.
const WAVE_HONEST = "Anton waves a greeting at Tanya.";

async function main(): Promise<void> {
  const failures: string[] = [];
  const rows: Array<{ name: string; calls: number; accepted: string; failed: number; outcome: string }> = [];

  const check = (name: string, cond: boolean, detail: string): void => {
    if (!cond) failures.push(`[${name}] ${detail}`);
  };

  // 1. Honest stationary render: accepted attempt 1, 1 call, clean. --------
  {
    const name = "honest-stationary";
    const before = loadOfficeAnton();
    const r = await runCase(name, WAVE, [prose(WAVE_HONEST)]);
    const last = historyLast(r.world);
    check(name, r.render.calls === 1, `render calls = ${r.render.calls}, expected 1`);
    check(name, acceptedAttempts(r.logger).join() === "1", `accepted attempts = ${acceptedAttempts(r.logger)}, expected [1]`);
    check(name, logEvents(r.logger, "render_failed").length === 0, "honest render was rejected");
    check(name, telemetryOutcome(r.logger) === "clean", `outcome = ${telemetryOutcome(r.logger)}, expected clean`);
    check(name, !last.includes(NOT_DONE_SENTINEL) && !/\(not done\)/.test(last), `fallback marker in history: ${last.slice(0, 120)}`);
    check(name, last.includes(WAVE_HONEST), `history missing honest narrative: ${last.slice(0, 120)}`);
    const [bx, by] = pos(before, "anton");
    const [ax, ay] = pos(r.world, "anton");
    check(name, bx === ax && by === ay, `anton moved on a stationary turn (${bx},${by})->(${ax},${ay})`);
    rows.push({ name, calls: r.render.calls, accepted: acceptedAttempts(r.logger).join(), failed: logEvents(r.logger, "render_failed").length, outcome: telemetryOutcome(r.logger) });
  }

  // 2. Hallucinated walk (Stage-1 F5 repro): rejected, retried, honest wins.
  {
    const name = "hallucinated-walk";
    const before = loadOfficeAnton();
    const lie = "Anton walks toward the desk and picks up the pen.";
    const r = await runCase(name, WAVE, [prose(lie), prose(WAVE_HONEST)]);
    const last = historyLast(r.world);
    check(name, r.render.calls === 2, `render calls = ${r.render.calls}, expected 2`);
    check(name, failedCodes(r.logger).includes("movement.narrated_without_move"), `no narrated_without_move in: ${failedCodes(r.logger).slice(0, 200)}`);
    check(name, acceptedAttempts(r.logger).join() === "2", `accepted attempts = ${acceptedAttempts(r.logger)}, expected [2]`);
    check(name, telemetryOutcome(r.logger) === "clean", `outcome = ${telemetryOutcome(r.logger)}, expected clean`);
    check(name, last.includes(WAVE_HONEST) && !last.includes("picks up the pen"), `history carries the lie: ${last.slice(0, 160)}`);
    const [bx, by] = pos(before, "anton");
    const [ax, ay] = pos(r.world, "anton");
    check(name, bx === ax && by === ay, `engine moved anton on a wave turn (${bx},${by})->(${ax},${ay})`);
    check(name, prop(r.world, "anton") === null, `phantom prop: anton.prop = ${JSON.stringify(prop(r.world, "anton"))}`);
    rows.push({ name, calls: r.render.calls, accepted: acceptedAttempts(r.logger).join(), failed: logEvents(r.logger, "render_failed").length, outcome: telemetryOutcome(r.logger) });
  }

  // 3. Wrong destination (Stage-1 F6/turn-1 repro). -------------------------
  {
    const name = "wrong-destination";
    const before = loadOfficeAnton();
    const lie = "Anton walks toward Dana with a grin.";
    const honest = "Anton walks toward Tanya with a grin.";
    const r = await runCase(name, "Anton walks toward Tanya.", [prose(lie), prose(honest)]);
    const last = historyLast(r.world);
    const [bx, by] = pos(before, "anton");
    const [ax, ay] = pos(r.world, "anton");
    check(name, bx !== ax || by !== ay, `engine did not move anton (still ${ax},${ay})`);
    check(name, r.render.calls === 2, `render calls = ${r.render.calls}, expected 2`);
    check(name, failedCodes(r.logger).includes("movement.destination_mismatch"), `no destination_mismatch in: ${failedCodes(r.logger).slice(0, 200)}`);
    check(name, acceptedAttempts(r.logger).join() === "2", `accepted attempts = ${acceptedAttempts(r.logger)}, expected [2]`);
    check(name, last.includes("toward Tanya") && !last.includes("toward Dana"), `history carries the wrong destination: ${last.slice(0, 160)}`);
    rows.push({ name, calls: r.render.calls, accepted: acceptedAttempts(r.logger).join(), failed: logEvents(r.logger, "render_failed").length, outcome: telemetryOutcome(r.logger) });
  }

  // 4. Altered quote: deterministic reinsertion, no retry burned. -----------
  {
    const name = "altered-quote";
    const action = `Anton says "${QUOTE}"`;
    const r = await runCase(name, action, [prose(`Anton mutters "Morning, ready for the demo?" and glances around.`)]);
    const last = historyLast(r.world);
    check(name, r.render.calls === 1, `render calls = ${r.render.calls}, expected 1 (repair burns no call)`);
    check(name, logEvents(r.logger, "render_failed").length === 0, `repaired quote still rejected: ${failedCodes(r.logger).slice(0, 200)}`);
    check(name, logEvents(r.logger, "render_quote_reinserted").length === 1, "deterministic quote reinsertion did not fire");
    check(name, last.includes(QUOTE), `history missing byte-identical quote: ${last.slice(0, 200)}`);
    check(name, !last.includes(NOT_DONE_SENTINEL), `fallback marker in history: ${last.slice(0, 120)}`);
    rows.push({ name, calls: r.render.calls, accepted: acceptedAttempts(r.logger).join(), failed: logEvents(r.logger, "render_failed").length, outcome: telemetryOutcome(r.logger) });
  }

  // 5. Honest quote: accepted attempt 1. ------------------------------------
  {
    const name = "honest-quote";
    const action = `Anton says "${QUOTE2}"`;
    const r = await runCase(name, action, [prose(`Anton says "${QUOTE2}" with a warm smile.`)]);
    const last = historyLast(r.world);
    check(name, r.render.calls === 1, `render calls = ${r.render.calls}, expected 1`);
    check(name, acceptedAttempts(r.logger).join() === "1", `accepted attempts = ${acceptedAttempts(r.logger)}, expected [1]`);
    check(name, last.includes(QUOTE2), `history missing quote: ${last.slice(0, 160)}`);
    rows.push({ name, calls: r.render.calls, accepted: acceptedAttempts(r.logger).join(), failed: logEvents(r.logger, "render_failed").length, outcome: telemetryOutcome(r.logger) });
  }

  // 6. Phantom manipulation: rejected, retried, no phantom prop. ------------
  {
    const name = "phantom-manipulation";
    const lie = "Anton picks up the laptop and waves it at Tanya.";
    const r = await runCase(name, WAVE, [prose(lie), prose(WAVE_HONEST)]);
    const last = historyLast(r.world);
    check(name, r.render.calls === 2, `render calls = ${r.render.calls}, expected 2`);
    check(name, failedCodes(r.logger).includes("object.phantom_manipulation"), `no phantom_manipulation in: ${failedCodes(r.logger).slice(0, 200)}`);
    check(name, prop(r.world, "anton") === null, `phantom prop materialized: anton.prop = ${JSON.stringify(prop(r.world, "anton"))}`);
    check(name, last.includes(WAVE_HONEST), `history carries the phantom: ${last.slice(0, 160)}`);
    rows.push({ name, calls: r.render.calls, accepted: acceptedAttempts(r.logger).join(), failed: logEvents(r.logger, "render_failed").length, outcome: telemetryOutcome(r.logger) });
  }

  // 7. Unrecoverable render: graceful fallback, no corruption, in budget. ---
  {
    const name = "unrecoverable-fallback";
    const before = loadOfficeAnton();
    const r = await runCase(name, WAVE, [
      prose("Anton walks toward the desk and picks up the pen."),
      prose("Anton strides across the room and grabs the laptop."),
    ]);
    const last = historyLast(r.world);
    check(name, r.render.calls === 2, `render calls = ${r.render.calls}, expected 2 (max attempts)`);
    check(name, logEvents(r.logger, "fallback_used").length === 1, "fallback_used not logged");
    check(name, logEvents(r.logger, "liveness_applied").length === 0, "liveness floor fired on a first failure (threshold 3)");
    check(name, last.includes(NOT_DONE_SENTINEL) || /\(not done\)/.test(last), `no fallback marker in history: ${last.slice(0, 120)}`);
    const [bx, by] = pos(before, "anton");
    const [ax, ay] = pos(r.world, "anton");
    check(name, bx === ax && by === ay, `fallback turn moved anton (${bx},${by})->(${ax},${ay})`);
    check(name, prop(r.world, "anton") === null, `fallback turn set a prop: ${JSON.stringify(prop(r.world, "anton"))}`);
    check(name, telemetryOutcome(r.logger) === "fallback", `outcome = ${telemetryOutcome(r.logger)}, expected fallback`);
    check(name, r.render.calls <= 4, `render burned the turn budget (${r.render.calls} calls)`);
    rows.push({ name, calls: r.render.calls, accepted: acceptedAttempts(r.logger).join() || "—", failed: logEvents(r.logger, "render_failed").length, outcome: telemetryOutcome(r.logger) });
  }

  console.log("case                  | calls | accepted@ | failed | outcome");
  console.log("----------------------|-------|-----------|--------|----------");
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(21)} | ${String(row.calls).padEnd(5)} | ${row.accepted.padEnd(9)} | ${String(row.failed).padEnd(6)} | ${row.outcome}`,
    );
  }
  console.log(failures.length === 0 ? "STAGE2_RENDER_BATTERY: PASS" : `STAGE2_RENDER_BATTERY: FAIL (${failures.length})`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`stage2 battery crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
