// PLAN_V2 Phase 6: judge-set quality gate — run scripts/eval-datasets/laya-eval.json
// (judge group only; the selection/triage groups measured the deleted
// decision cascade) against a real LayaClient (or --stub for CI plumbing),
// reporting accuracy, ECE (10 bins) over the noul questions, and latency.
//
// Usage:
//   tsx scripts/eval-laya.ts [--stub] [--gate] [--url http://127.0.0.1:8000]
//   --stub : deterministic stub decider (plumbing check, not a quality signal)
//   --gate : exit non-zero when any group falls below its accuracy threshold
//
// Exit code is 0 unless --gate fails. Never throws on a single bad case —
// per-case errors are counted and reported.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LayaAnswer, LayaQuestion } from "../src/decision/decisionTypes.js";
import { buildJudgeState } from "../src/decision/decisionState.js";
import { buildJudgeQuestions } from "../src/decision/judgeQuestions.js";
import { LayaClient } from "../src/decision/layaClient.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Dataset types
// ---------------------------------------------------------------------------

type JudgeExpected = {
  moves: boolean; speaks: boolean;
  addressee: string | null; destination: string | null; contact: string | null;
};
type JudgeCase = {
  id: string; actionText: string; roster: string[]; landmarks: string[];
  expected: JudgeExpected;
};
type Dataset = {
  version: number;
  groups: { judge: JudgeCase[] };
};

// ---------------------------------------------------------------------------
// Decider abstraction (real client vs deterministic stub)
// ---------------------------------------------------------------------------

type Decider = {
  decide(state: string, questions: Record<string, LayaQuestion>): Promise<Record<string, LayaAnswer>>;
};

/** Stub: returns the seeded expected answers with high confidence. Plumbing only. */
function makeStubDecider(seed: Record<string, LayaAnswer>): Decider {
  return {
    async decide(_state, questions) {
      const out: Record<string, LayaAnswer> = {};
      for (const id of Object.keys(questions)) {
        const s = seed[id];
        if (!s) throw new Error(`stub has no seed for question "${id}"`);
        out[id] = s;
      }
      return out;
    },
  };
}

function stubChoice(winner: string, options: string[]): LayaAnswer {
  const probabilities: Record<string, number> = {};
  const rest = (1 - 0.99) / Math.max(1, options.length - 1);
  for (const o of options) probabilities[o] = o === winner ? 0.99 : rest;
  return { type: "choice", winner, probabilities, confidence: 0.99 };
}

function stubNoul(expected: boolean): LayaAnswer {
  return { type: "noul", pTrue: expected ? 0.95 : 0.05 };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

type EceBin = { count: number; sumConf: number; sumCorrect: number };

function computeEce(pairs: Array<{ p: number; label: boolean }>, bins = 10): number {
  const acc: EceBin[] = Array.from({ length: bins }, () => ({ count: 0, sumConf: 0, sumCorrect: 0 }));
  for (const { p, label } of pairs) {
    const b = Math.min(bins - 1, Math.floor(p * bins));
    const bin = acc[b]!;
    bin.count++;
    bin.sumConf += p;
    bin.sumCorrect += label ? 1 : 0;
  }
  const n = pairs.length;
  if (n === 0) return 0;
  return acc.reduce(
    (ece, bin) => ece + (bin.count / n) * Math.abs(bin.sumCorrect / Math.max(1, bin.count) - bin.sumConf / Math.max(1, bin.count)),
    0,
  );
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function latencyStats(ms: number[]): { mean: number; p50: number; p99: number; n: number } {
  const sorted = [...ms].sort((a, b) => a - b);
  const mean = ms.length === 0 ? 0 : ms.reduce((s, v) => s + v, 0) / ms.length;
  return { mean, p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99), n: ms.length };
}

// ---------------------------------------------------------------------------
// Group runners
// ---------------------------------------------------------------------------

type GroupResult = {
  name: string;
  accuracy: number;
  correct: number;
  total: number;
  errors: number;
  detail: Record<string, number>;
};

const noulPairs: Array<{ p: number; label: boolean }> = [];
const latencies: number[] = [];

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

/** Argmax over a choice answer's probability map (was in deleted runnerUtils). */
function argmaxOption(
  probabilities: Record<string, number> | undefined,
  options: string[],
): string | undefined {
  if (!probabilities) return undefined;
  let best: string | undefined;
  let bestP = -Infinity;
  for (const o of options) {
    const p = probabilities[o] ?? -Infinity;
    if (p > bestP) { bestP = p; best = o; }
  }
  return best;
}

function choiceWinner(answer: LayaAnswer | undefined, options: string[]): string | undefined {
  if (!answer || answer.type !== "choice") return undefined;
  return argmaxOption(answer.probabilities, options);
}

const NOBODY = "nobody in particular";
const NOWHERE = "stays put / nowhere";
const NO_CONTACT = "no physical contact";

async function runJudge(
  cases: JudgeCase[],
  decider: Decider,
  stub: boolean,
): Promise<GroupResult> {
  let correct = 0;
  let errors = 0;
  const fieldCorrect: Record<string, number> = {
    moves: 0, speaks: 0, addressee: 0, destination: 0, contact: 0,
  };
  for (const c of cases) {
    const questions = buildJudgeQuestions(c.roster, c.landmarks);
    const state = buildJudgeState(c.actionText, c.roster, c.landmarks);
    const qIds = Object.keys(questions);
    let d: Decider = decider;
    if (stub) {
      const exp = c.expected;
      d = makeStubDecider({
        q_moves: stubNoul(exp.moves),
        q_speaks: stubNoul(exp.speaks),
        q_addressee: stubChoice(exp.addressee ?? NOBODY, [...c.roster, NOBODY]),
        q_destination: stubChoice(exp.destination ?? NOWHERE, [...c.landmarks, ...c.roster, NOWHERE]),
        q_contact: stubChoice(exp.contact ?? NO_CONTACT, [...c.roster, NO_CONTACT]),
      });
    }
    try {
      const { value: answers, ms } = await timed(() => d.decide(state, questions));
      latencies.push(ms);
      const moves = answers["q_moves"]?.type === "noul" ? answers["q_moves"].pTrue >= 0.5 : undefined;
      const speaks = answers["q_speaks"]?.type === "noul" ? answers["q_speaks"].pTrue >= 0.5 : undefined;
      if (moves !== undefined) noulPairs.push({ p: (answers["q_moves"] as { pTrue: number }).pTrue, label: c.expected.moves });
      if (speaks !== undefined) noulPairs.push({ p: (answers["q_speaks"] as { pTrue: number }).pTrue, label: c.expected.speaks });
      const addressee = choiceWinner(answers["q_addressee"], [...c.roster, NOBODY]);
      const destination = choiceWinner(answers["q_destination"], [...c.landmarks, ...c.roster, NOWHERE]);
      const contact = choiceWinner(answers["q_contact"], [...c.roster, NO_CONTACT]);
      const norm = (v: string | undefined, noneToken: string): string | null =>
        !v || v === noneToken ? null : v;
      const checks: Array<[string, boolean]> = [
        ["moves", moves === c.expected.moves],
        ["speaks", speaks === c.expected.speaks],
        ["addressee", norm(addressee, NOBODY) === c.expected.addressee],
        ["destination", norm(destination, NOWHERE) === c.expected.destination],
        ["contact", norm(contact, NO_CONTACT) === c.expected.contact],
      ];
      let allOk = true;
      for (const [field, ok] of checks) {
        if (ok) fieldCorrect[field]!++;
        else allOk = false;
      }
      if (allOk) correct++;
    } catch {
      errors++;
    }
  }
  const total = cases.length;
  const detail: Record<string, number> = {};
  for (const [f, n] of Object.entries(fieldCorrect)) detail[`field:${f}`] = n / total;
  return { name: "judge", accuracy: correct / total, correct, total, errors, detail };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const GATE_THRESHOLDS: Record<string, number> = {
  judge: 0.6,
};

function parseArgs(): { stub: boolean; gate: boolean; url: string; dataset: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    stub: args.includes("--stub"),
    gate: args.includes("--gate"),
    url: get("--url") ?? process.env["LAYA_URL"] ?? "http://127.0.0.1:8000",
    dataset: get("--dataset") ?? join(ROOT, "scripts", "eval-datasets", "laya-eval.json"),
  };
}

async function main(): Promise<void> {
  const { stub, gate, url, dataset } = parseArgs();
  const data = JSON.parse(readFileSync(dataset, "utf-8")) as Dataset;
  const client = new LayaClient({ baseUrl: url });
  const decider: Decider = client;

  console.log(`laya eval: ${stub ? "STUB decider" : `live ${url}`} | dataset ${dataset}`);
  console.log(`cases: judge=${data.groups.judge.length}`);

  const results = [await runJudge(data.groups.judge, decider, stub)];

  const ece = computeEce(noulPairs, 10);
  const lat = latencyStats(latencies);

  const failures: string[] = [];
  for (const r of results) {
    const errNote = r.errors > 0 ? ` (${r.errors} errors)` : "";
    console.log(
      `\n[${r.name}] accuracy ${(r.accuracy * 100).toFixed(1)}% (${r.correct}/${r.total})${errNote}`,
    );
    for (const [k, v] of Object.entries(r.detail)) {
      console.log(`    ${k}: ${(v * 100).toFixed(1)}%`);
      if (gate) {
        const threshold = GATE_THRESHOLDS[`${r.name}:${k}`];
        if (threshold !== undefined && v < threshold) {
          failures.push(`${r.name}:${k} ${(v * 100).toFixed(1)}% < ${(threshold * 100).toFixed(0)}%`);
        }
      }
    }
    if (gate) {
      const threshold = GATE_THRESHOLDS[r.name];
      if (threshold !== undefined && r.accuracy < threshold) {
        failures.push(`${r.name} ${(r.accuracy * 100).toFixed(1)}% < ${(threshold * 100).toFixed(0)}%`);
      }
    }
  }
  console.log(`\nnoul ECE (10 bins, n=${noulPairs.length}): ${ece.toFixed(4)}`);
  console.log(
    `latency per decide(): n=${lat.n} mean=${lat.mean.toFixed(0)}ms p50=${lat.p50.toFixed(0)}ms p99=${lat.p99.toFixed(0)}ms`,
  );

  const summary = {
    mode: stub ? "stub" : "live",
    url: stub ? undefined : url,
    groups: Object.fromEntries(
      results.map((r) => [r.name, { accuracy: r.accuracy, correct: r.correct, total: r.total, errors: r.errors, detail: r.detail }]),
    ),
    noulEce: ece,
    noulPairs: noulPairs.length,
    latencyMs: lat,
  };
  console.log(`\n${JSON.stringify(summary)}`);

  if (gate) {
    if (ece > 0.15) failures.push(`noul ECE ${ece.toFixed(3)} > 0.15`);
    if (failures.length > 0) {
      console.error(`\nGATE FAILED:\n- ${failures.join("\n- ")}`);
      process.exit(1);
    }
    console.log("\nGATE PASSED");
  }
}

main().catch((err) => {
  console.error(`eval crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
