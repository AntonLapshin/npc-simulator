// Run-quality eval harness (Exp-4 item 11 / S9, S6-measure, §D).
//
// Scores a COMPLETED run from its artifacts — no live models needed:
//   npx tsx scripts/eval-run-quality.ts <save.json> <log.jsonl> [tasks.json]
//
// Phase 5: cascade-vs-LLM decision comparison mode:
//   npx tsx scripts/eval-run-quality.ts --compare \
//     <cascadeSave> <cascadeLog> <llmSave> <llmLog> [tasks.json]
//
// - save.json: the run's save file (history, actors, memories)
// - log.jsonl:  the run's JSONL trace (per-tick worlds, event counts)
// - tasks.json: optional movement tasks, e.g.
//     [{ "actorId": "anton", "targetObjectId": "coffee_machine",
//        "radius": 2, "label": "reach the coffee machine" }]
//
// Metrics:
//   1. outcome histogram (applied / partial / fallback per actor; user vs NPC)
//   2. task completion — did the actor ever get within `radius` of the
//      target in the APPLIED per-tick worlds (turn_completed snapshots)?
//      Fallback-rate rewards vetoes that freeze the world; this doesn't.
//   3. memory precision — share of memory entries without defects
//      (doubled "Name: Name:" prefix, first-person leakage outside quotes,
//      stubs under 8 words)
//   4. object-patch grounding — objectPatches present in applied/partial
//      turns (approximate: last consequence_completed of each non-fallback
//      tick; the accepted consequence is normally the last one)
//   5. new-machinery event counts (resteers, prop stubs, bans, voice-gate
//      rejections, pour_too_far, …)
//
// --compare adds:
//   6. decision cost — LLM proposal/selection engine invocations per run
//      (the LLM engines log proposal_completed/selection_completed; the
//      Laya cascade engines log neither, so their absence IS the signal),
//      plus `usage` payload counts when the backend reported them.
//   7. verdict — did the cascade eliminate decision LLM calls at quality
//      parity-or-better? The LLM fallback stays default ON until the
//      cascade wins 3 consecutive runs (tracked outside this script).
//
// Pure offline analysis — safe to run anywhere.

import { readFileSync } from "node:fs";
import { NOT_DONE_SENTINEL } from "../src/types.js";
import { detectVoiceViolation } from "../src/engine/validate/narrative.js";

type Actor = {
  id: string;
  name: string;
  x: number;
  y: number;
  state?: string;
  pose?: string;
  emotion?: string;
  prop?: string | null;
  memories?: string[];
};
type SceneObject = { id: string; name: string; x: number; y: number; w: number; h: number };
type World = {
  tick: number;
  actors: Actor[];
  scene: { objects: SceneObject[] };
  history: { text: string }[];
  userActorId: string;
};
type TaskDef = {
  actorId: string;
  targetObjectId?: string;
  targetActorId?: string;
  radius?: number;
  label: string;
};

// ---------------------------------------------------------------------------
// Shared: loading + scoring (pure data; printing lives in the modes below)
// ---------------------------------------------------------------------------

type RunData = { world: World; events: any[] };

function loadRun(savePath: string, logPath: string): RunData {
  const save = JSON.parse(readFileSync(savePath, "utf8"));
  const world: World = save.world ?? save;
  const events: any[] = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { world, events };
}

const byEvent = (events: any[], name: string) => events.filter((e) => e.event === name);

type OutcomeStats = {
  perActor: Map<string, { applied: number; partial: number; fallback: number }>;
  applied: number;
  partial: number;
  fallback: number;
  total: number;
  fallbackRate: number;
};

/** Section 1: outcome histogram from save history (the canonical record). */
function outcomeStats(world: World): OutcomeStats {
  const perActor = new Map<string, { applied: number; partial: number; fallback: number }>();
  for (const h of world.history) {
    const text = h.text;
    // Author prefixes mirror the engine's: "Name:", "id:", "Name tried:", "id tried:".
    const actor = world.actors.find((a) =>
      [`${a.name}:`, `${a.id}:`, `${a.name} tried:`, `${a.id} tried:`].some((p) =>
        text.startsWith(p),
      ),
    );
    if (!actor) continue;
    const s = perActor.get(actor.id) ?? { applied: 0, partial: 0, fallback: 0 };
    if (text.includes(NOT_DONE_SENTINEL) || /\(not done\)/.test(text)) s.fallback++;
    else if (text.includes("(partial)")) s.partial++;
    else s.applied++;
    perActor.set(actor.id, s);
  }
  let applied = 0, partial = 0, fallback = 0;
  for (const s of perActor.values()) {
    applied += s.applied; partial += s.partial; fallback += s.fallback;
  }
  const total = applied + partial + fallback;
  return { perActor, applied, partial, fallback, total, fallbackRate: total > 0 ? fallback / total : 0 };
}

type TaskResult = { label: string; done: boolean; best: number; bestTick: number; radius: number; note?: string };

/** Section 2: task completion from turn_completed per-tick applied worlds. */
function taskStats(world: World, events: any[], tasks: TaskDef[]): TaskResult[] {
  const snapshots = byEvent(events, "turn_completed")
    .map((e) => ({ tick: e.tick as number, world: e.output as World }))
    .filter((s) => s.world && Array.isArray(s.world.actors))
    .sort((a, b) => a.tick - b.tick);
  if (snapshots.length === 0) {
    return tasks.map((t) => ({ label: t.label, done: false, best: Infinity, bestTick: -1, radius: t.radius ?? 2, note: "no snapshots" }));
  }
  const distToRect = (x: number, y: number, o: SceneObject) => {
    const cx = Math.min(Math.max(x, o.x), o.x + o.w);
    const cy = Math.min(Math.max(y, o.y), o.y + o.h);
    return Math.hypot(x - cx, y - cy);
  };
  const firstObjects = snapshots[0]!.world.scene.objects;
  const out: TaskResult[] = [];
  for (const t of tasks) {
    const radius = t.radius ?? 2;
    if (t.targetActorId) {
      let best = Infinity, bestTick = -1;
      for (const s of snapshots) {
        const a = s.world.actors.find((a) => a.id === t.actorId);
        const tgt = s.world.actors.find((a) => a.id === t.targetActorId);
        if (!a || !tgt) continue;
        const d = Math.hypot(a.x - tgt.x, a.y - tgt.y);
        if (d < best) { best = d; bestTick = s.tick; }
      }
      out.push({ label: t.label, done: best <= radius, best, bestTick, radius });
      continue;
    }
    const o = t.targetObjectId
      ? firstObjects.find((o) => o.id === t.targetObjectId)
      : undefined;
    if (!o) {
      out.push({ label: t.label, done: false, best: Infinity, bestTick: -1, radius, note: "target not found" });
      continue;
    }
    let best = Infinity, bestTick = -1;
    for (const s of snapshots) {
      const a = s.world.actors.find((a) => a.id === t.actorId);
      if (!a) continue;
      const d =
        o.w * o.h > 1
          ? distToRect(a.x, a.y, o)
          : Math.hypot(a.x - (o.x + o.w / 2), a.y - (o.y + o.h / 2));
      if (d < best) { best = d; bestTick = s.tick; }
    }
    out.push({ label: t.label, done: best <= radius, best, bestTick, radius });
  }
  return out;
}

/**
 * A memory truncated mid-quote ("…referrin…") leaves an unterminated quote
 * whose "I" is really the character speaking — strip from the last
 * unterminated quote so the voice check doesn't false-positive. The
 * truncation itself is still reported (model-side, not engine-fixable).
 */
function cleanMemory(m: string): { text: string; truncated: boolean } {
  const trimmed = m.trim();
  const truncated = /…$/.test(trimmed);
  let text = m;
  const quotes = (text.match(/"/g) ?? []).length;
  if (truncated && quotes % 2 === 1) {
    text = text.slice(0, text.lastIndexOf('"'));
  }
  return { text, truncated };
}
/**
 * Exp-6 item 13 (S10): corrupt-canonical memory defects. The salience
 * gate decides WHAT gets banked; these patterns show what it let through
 * (exp-6: 5x "greets the office" stubs, the "stranger" line, and the
 * phantom coffee stain all became permanent memories). A memory
 * containing them is precise-looking but fiction.
 */
function corruptCanonicalDefects(m: string): string[] {
  const out: string[] = [];
  if (/\bgreets the office\b/i.test(m)) out.push("stub-phrase");
  if (/\b(a|the|some)\s+stranger\b|\bunknown\s+(person|man|woman|coworker|colleague)\b/i.test(m))
    out.push("alienation-label");
  if (/\b(coffee stain|spill|broke|tore).{0,40}\b(anton|tanya|dana)\b/i.test(m) && /\b(cup|mug)\b/i.test(m))
    out.push("phantom-contact");
  return out;
}

type MemoryStats = {
  perActor: { id: string; precision: number; clean: number; total: number; examples: string[] }[];
  /** Mean precision over actors that have memories (0..1); null when none. */
  meanPrecision: number | null;
};

/** Section 3: memory precision — share of entries without defects. */
function memoryStats(world: World): MemoryStats {
  const perActor: MemoryStats["perActor"] = [];
  for (const a of world.actors) {
    const mems = a.memories ?? [];
    if (mems.length === 0) {
      perActor.push({ id: a.id, precision: 1, clean: 0, total: 0, examples: [] });
      continue;
    }
    let defects = 0;
    const examples: string[] = [];
    for (const m of mems) {
      const { text, truncated } = cleanMemory(m);
      const v = detectVoiceViolation(text, a.name);
      const corrupt = corruptCanonicalDefects(m);
      if (v.length > 0 || truncated || corrupt.length > 0) {
        defects++;
        if (examples.length < 2) {
          const kinds = [...v.map((x) => x.code), ...(truncated ? ["truncated"] : []), ...corrupt];
          examples.push(`[${kinds.join(",")}] ${m.slice(0, 90)}`);
        }
      }
    }
    perActor.push({
      id: a.id,
      precision: 1 - defects / mems.length,
      clean: mems.length - defects,
      total: mems.length,
      examples,
    });
  }
  const withMems = perActor.filter((p) => p.total > 0);
  return {
    perActor,
    meanPrecision: withMems.length > 0
      ? withMems.reduce((s, p) => s + p.precision, 0) / withMems.length
      : null,
  };
}

export type DecisionStats = {
  /** LLM proposal engine invocations (proposal_completed events). */
  llmProposalCalls: number;
  /** LLM selection engine invocations (selection_completed events). */
  llmSelectionCalls: number;
  /** Laya cascade intent decisions (intent_decided events). */
  layaIntentDecisions: number;
  /** Events carrying a backend usage payload (token counts). */
  usageEvents: number;
  /**
   * PLAN_V2 Phase 6 (Stage-3 lesson): failed decision attempts that
   * burned a provider call — proposal_failed / selection_failed /
   * intent_failed events carrying a `usage` payload. A fallback engine
   * that retries internally logs these without ever logging a
   * *_completed, so counting only completions understates the true
   * per-turn call cost (Stage 3 reported 23 vs 19; the honest count
   * from usage-carrying failures was 36 vs 34).
   */
  failedDecisionCalls: number;
  selectionRejected: number;
  intentBanned: number;
  proposalFiltered: number;
};

/**
 * Phase 5 §6: decision cost + decision-quality signals.
 *
 * The LLM engines log proposal_completed / selection_completed; the Laya
 * cascade engines log neither — so zero counts on the cascade path ARE
 * the zero-LLM-call proof (each event is one engine invocation).
 *
 * PLAN_V2 Phase 6: internal retries inside a fallback engine log
 * *_failed events WITH usage payloads but no *_completed — those burned
 * real provider calls and are counted in failedDecisionCalls.
 */
export function decisionStats(events: any[]): DecisionStats {
  const usageEvents = events.filter((e) => e.usage !== undefined && e.usage !== null).length;
  const hasUsage = (e: any): boolean => e.usage !== undefined && e.usage !== null;
  const failedDecisionCalls = events.filter(
    (e) =>
      hasUsage(e) &&
      (e.event === "proposal_failed" ||
        e.event === "selection_failed" ||
        e.event === "intent_failed"),
  ).length;
  return {
    llmProposalCalls: byEvent(events, "proposal_completed").length,
    llmSelectionCalls: byEvent(events, "selection_completed").length,
    layaIntentDecisions: byEvent(events, "intent_decided").length,
    usageEvents,
    failedDecisionCalls,
    selectionRejected: byEvent(events, "selection_rejected").length,
    intentBanned: byEvent(events, "intent_banned").length + byEvent(events, "intent_cluster_banned").length,
    proposalFiltered: byEvent(events, "proposal_filtered").length,
  };
}

function loadTasks(tasksPath?: string): TaskDef[] {
  if (!tasksPath) return [];
  return JSON.parse(readFileSync(tasksPath, "utf8")) as TaskDef[];
}

// ---------------------------------------------------------------------------
// Single-run mode (original behavior, now via the shared scorers)
// ---------------------------------------------------------------------------

function runSingle(savePath: string, logPath: string, tasksPath?: string): void {
  const { world, events } = loadRun(savePath, logPath);

  // 1. Outcome histogram (from save history — the canonical record)
  console.log("== outcomes (from save history) ==");
  const o = outcomeStats(world);
  for (const [id, s] of o.perActor) {
    const n = s.applied + s.partial + s.fallback;
    const who = id === world.userActorId ? "user" : "npc";
    console.log(
      `  ${id} (${who}): ${s.applied} applied / ${s.partial} partial / ${s.fallback} fallback ` +
        `(${(100 * s.fallback / n).toFixed(0)}% fallback)`,
    );
  }
  console.log(
    `  TOTAL: ${o.applied} applied / ${o.partial} partial / ${o.fallback} fallback ` +
      `(${(100 * o.fallbackRate).toFixed(0)}% fallback, ${o.total} turns)`,
  );

  // 2. Task completion (from turn_completed per-tick applied worlds)
  const snapshots = byEvent(events, "turn_completed")
    .map((e) => ({ tick: e.tick as number, world: e.output as World }))
    .filter((s) => s.world && Array.isArray(s.world.actors))
    .sort((a, b) => a.tick - b.tick);

  const tasks = loadTasks(tasksPath);
  if (tasks.length > 0 && snapshots.length > 0) {
    console.log("\n== task completion (applied worlds only) ==");
    for (const r of taskStats(world, events, tasks)) {
      if (r.note) {
        console.log(`  [?] ${r.label}: ${r.note}`);
      } else {
        console.log(
          `  [${r.done ? "DONE" : "miss"}] ${r.label}: closest ${r.best.toFixed(1)} cells ` +
            `(radius ${r.radius}) at tick ${r.bestTick}`,
        );
      }
    }
    // Displacement summary: total path length vs net displacement per actor.
    console.log("\n  displacement (applied path length vs net):");
    const ids = snapshots[0]!.world.actors.map((a) => a.id);
    for (const id of ids) {
      let path = 0, prev: { x: number; y: number } | null = null;
      let first: { x: number; y: number } | null = null, last: { x: number; y: number } | null = null;
      for (const s of snapshots) {
        const a = s.world.actors.find((a) => a.id === id);
        if (!a) continue;
        if (!first) first = { x: a.x, y: a.y };
        last = { x: a.x, y: a.y };
        if (prev) path += Math.hypot(a.x - prev.x, a.y - prev.y);
        prev = { x: a.x, y: a.y };
      }
      const net = first && last ? Math.hypot(last.x - first.x, last.y - first.y) : 0;
      console.log(`    ${id}: path ${path.toFixed(1)} cells, net ${net.toFixed(1)} cells`);
    }
  } else if (tasks.length > 0) {
    console.log("\n== task completion: no turn_completed snapshots in log ==");
  }

  // 3. Memory precision
  console.log("\n== memory precision ==");
  const mem = memoryStats(world);
  for (const p of mem.perActor) {
    if (p.total === 0) {
      console.log(`  ${p.id}: no memories`);
      continue;
    }
    console.log(
      `  ${p.id}: ${(100 * p.precision).toFixed(0)}% clean (${p.clean}/${p.total})`,
    );
    for (const ex of p.examples) console.log(`      - ${ex}`);
  }
  // Exp-6 item 13 (S10): bind the salience gate to the measurement —
  // corrupt memories banked WHILE the gate was active are gate misses.
  {
    const salience = byEvent(events, "salience_scored").length;
    const triage = byEvent(events, "triage_applied").length;
    const banked = byEvent(events, "memory_banked").length;
    console.log(
      `  salience: ${salience} scored / ${triage} triaged` +
        (banked > 0 ? ` / ${banked} banked` : " (no memory_banked events in log)"),
    );
  }

  // 4. Object-patch grounding in applied/partial turns (approximate)
  console.log("\n== object grounding (applied/partial turns) ==");
  const fallbackTicks = new Set(byEvent(events, "fallback_used").map((e) => e.tick));
  const consByTick = new Map<number, any[]>();
  for (const e of byEvent(events, "consequence_completed")) {
    const arr = consByTick.get(e.tick) ?? [];
    arr.push(e);
    consByTick.set(e.tick, arr);
  }
  let objPatchTurns = 0, scoredTurns = 0, totalObjPatches = 0;
  for (const [tick, arr] of consByTick) {
    if (fallbackTicks.has(tick)) continue;
    const last = arr[arr.length - 1]!;
    const n = (last.output?.objectPatches ?? []).length;
    scoredTurns++;
    totalObjPatches += n;
    if (n > 0) objPatchTurns++;
  }
  console.log(
    `  ${objPatchTurns}/${scoredTurns} non-fallback ticks carried objectPatches ` +
      `(${totalObjPatches} total; approx: last consequence per tick)`,
  );
  // Exp-5 item 12 (S6): TRUE applied measure — JSON diff of scene.objects
  // between the first and last turn_completed snapshots. The count above
  // is what the model PROPOSED; this is what actually changed in the world
  // (exp-5: 0 proposed-applied gap — 18 nonempty objectPatches proposed,
  // 0 applied, fifth run in a row).
  if (snapshots.length >= 2) {
    const first = snapshots[0]!.world.scene.objects;
    const last = snapshots[snapshots.length - 1]!.world.scene.objects;
    const keyOf = (oo: SceneObject) => oo.id;
    const firstById = new Map(first.map((oo) => [keyOf(oo), oo]));
    const lastById = new Map(last.map((oo) => [keyOf(oo), oo]));
    let changed = 0;
    const changedIds: string[] = [];
    for (const [id, oo] of lastById) {
      const before = firstById.get(id);
      if (!before || JSON.stringify(before) !== JSON.stringify(oo)) {
        changed++;
        if (changedIds.length < 5) changedIds.push(id);
      }
    }
    console.log(
      `  applied object changes: ${changed} object(s) differ between first and last applied snapshots` +
        (changedIds.length > 0 ? ` (${changedIds.join(", ")}${changed > changedIds.length ? ", …" : ""})` : ""),
    );
  } else {
    console.log("  applied object changes: n/a (fewer than 2 turn_completed snapshots)");
  }
  // Prop states from the final save.
  for (const a of world.actors) {
    console.log(`  ${a.id}: prop=${a.prop ?? "null"} pose=${a.pose} emotion=${a.emotion} state=${JSON.stringify(a.state)}`);
  }

  // 5. Machinery event counts
  console.log("\n== machinery events ==");
  const interesting = [
    "movement_repair_resteered",
    "movement_repair_vetoed",
    "movement_downgraded_stationary",
    "stationary_downgrade_rejected",
    "repair_target_disagreement",
    "movement_repaired",
    "object_prop_stub_applied",
    "intent_banned",
    "intent_cluster_banned",
    "liveness_applied",
    "retry_aborted",
    "salvage_best_attempt",
    "salvage_quote_reinserted",
    "salvage_prose_synthesized",
    "narrative_prefix_collapsed",
    "user_capable_tier_noop",
    "selection_rejected",
    // Exp-6 machinery.
    "proposal_filtered",
    "consequence_budget_raised",
    "proposal_budget_raised",
    "consequence_slow_call",
    "proposal_slow_call",
  ];
  for (const name of interesting) {
    const n = byEvent(events, name).length;
    if (n > 0) console.log(`  ${name}: ${n}`);
  }
  // Voice-gate + pour-distance rejections surface as validation failures;
  // count them by error code across validation_failed outputs.
  const codeCounts = new Map<string, number>();
  for (const e of events) {
    const errs: any[] = e.output?.errors ?? e.validationErrors ?? [];
    for (const er of errs) {
      const code = typeof er === "string" ? er.match(/\[([^\]]+)\]/)?.[1] : er.code;
      if (
        code === "narrative.first_person" ||
        code === "narrative.doubled_prefix" ||
        code === "narrative.stranger_label" ||
        code === "object.invented_contact" ||
        code === "object_grounding.pour_too_far"
      ) {
        codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
      }
    }
  }
  for (const [code, n] of codeCounts) console.log(`  ${code}: ${n} validation hits`);
}

// ---------------------------------------------------------------------------
// Phase 5: cascade-vs-LLM decision comparison mode
// ---------------------------------------------------------------------------

type ScoredRun = {
  label: string;
  outcomes: OutcomeStats;
  tasks: TaskResult[];
  memory: MemoryStats;
  decisions: DecisionStats;
};

function scoreRun(label: string, savePath: string, logPath: string, tasks: TaskDef[]): ScoredRun {
  const { world, events } = loadRun(savePath, logPath);
  return {
    label,
    outcomes: outcomeStats(world),
    tasks: taskStats(world, events, tasks),
    memory: memoryStats(world),
    decisions: decisionStats(events),
  };
}

function runCompare(
  cascadeSave: string,
  cascadeLog: string,
  llmSave: string,
  llmLog: string,
  tasksPath?: string,
): void {
  const tasks = loadTasks(tasksPath);
  const cascade = scoreRun("cascade", cascadeSave, cascadeLog, tasks);
  const llm = scoreRun("llm", llmSave, llmLog, tasks);

  console.log("== cascade vs LLM decision comparison ==");
  const row = (metric: string, c: string, l: string) =>
    console.log(`  ${metric.padEnd(28)} cascade=${c}  llm=${l}`);

  // Decision cost. PLAN_V2 Phase 6: failed attempts carrying usage
  // payloads burned provider calls without a *_completed event — they
  // count here (the Stage-3 36-vs-34 correction).
  const cCalls = cascade.decisions.llmProposalCalls + cascade.decisions.llmSelectionCalls +
    cascade.decisions.failedDecisionCalls;
  const lCalls = llm.decisions.llmProposalCalls + llm.decisions.llmSelectionCalls +
    llm.decisions.failedDecisionCalls;
  row("turns", String(cascade.outcomes.total), String(llm.outcomes.total));
  row("LLM proposal calls", String(cascade.decisions.llmProposalCalls), String(llm.decisions.llmProposalCalls));
  row("LLM selection calls", String(cascade.decisions.llmSelectionCalls), String(llm.decisions.llmSelectionCalls));
  row("failed-attempt provider calls", String(cascade.decisions.failedDecisionCalls), String(llm.decisions.failedDecisionCalls));
  row("laya intent decisions", String(cascade.decisions.layaIntentDecisions), String(llm.decisions.layaIntentDecisions));
  row("usage payloads", String(cascade.decisions.usageEvents), String(llm.decisions.usageEvents));
  row("fallback rate",
    `${(100 * cascade.outcomes.fallbackRate).toFixed(0)}%`,
    `${(100 * llm.outcomes.fallbackRate).toFixed(0)}%`);
  row("applied/partial/fallback",
    `${cascade.outcomes.applied}/${cascade.outcomes.partial}/${cascade.outcomes.fallback}`,
    `${llm.outcomes.applied}/${llm.outcomes.partial}/${llm.outcomes.fallback}`);
  if (tasks.length > 0) {
    const cDone = cascade.tasks.filter((t) => t.done).length;
    const lDone = llm.tasks.filter((t) => t.done).length;
    row("tasks done", `${cDone}/${cascade.tasks.length}`, `${lDone}/${llm.tasks.length}`);
  }
  const mp = (m: MemoryStats) =>
    m.meanPrecision === null ? "n/a" : `${(100 * m.meanPrecision).toFixed(0)}%`;
  row("memory precision", mp(cascade.memory), mp(llm.memory));
  row("selection rejections",
    String(cascade.decisions.selectionRejected), String(llm.decisions.selectionRejected));
  row("intent bans",
    String(cascade.decisions.intentBanned), String(llm.decisions.intentBanned));

  // Verdict.
  console.log("\n== verdict ==");
  const costEliminated = cCalls === 0 && lCalls > 0;
  const qualityDelta =
    (llm.outcomes.fallbackRate - cascade.outcomes.fallbackRate) +
    ((cascade.memory.meanPrecision ?? 0) - (llm.memory.meanPrecision ?? 0));
  const tasksDelta = tasks.length > 0
    ? cascade.tasks.filter((t) => t.done).length - llm.tasks.filter((t) => t.done).length
    : 0;
  const isMock = cascade.decisions.usageEvents === 0 && llm.decisions.usageEvents === 0;
  if (costEliminated && qualityDelta >= 0 && tasksDelta >= 0) {
    console.log("  CASCADE WINS: zero decision LLM calls at quality parity-or-better.");
    if (!isMock) {
      console.log("  (One win toward the 3-consecutive-wins gate for removing the LLM fallback.)");
    }
  } else if (costEliminated) {
    console.log("  TIE-LEAN-CASCADE: zero decision LLM calls, but quality regressed somewhere —");
    console.log("  compare fallback rate / tasks / memory rows above. LLM fallback stays default ON.");
  } else if (cCalls > 0) {
    console.log("  NO DECISION: the cascade path still made LLM proposal/selection calls");
    console.log(`  (${cCalls} vs ${lCalls} on the LLM path) — investigate before any gate talk.`);
  } else {
    console.log("  INCONCLUSIVE: neither path made decision LLM calls (mock harness?) —");
    console.log("  cost comparison is vacuous; judge on the quality rows only.");
  }
  if (isMock) {
    console.log("  NOTE: no backend usage reported on either run (mock harness) —");
    console.log("  quality parity here is vacuous; only the cost row is meaningful,");
    console.log("  and mock wins do not count toward the live 3-win gate.");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Importable for unit tests (decisionStats) — the CLI only runs as a script.
import { pathToFileURL } from "node:url";
const isMainEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainEntry) {
  main();
}

function main(): void {
const args = process.argv.slice(2);
if (args[0] === "--compare") {
  const [, cascadeSave, cascadeLog, llmSave, llmLog, tasksPath] = args;
  if (!cascadeSave || !cascadeLog || !llmSave || !llmLog) {
    console.error(
      "usage: npx tsx scripts/eval-run-quality.ts --compare " +
        "<cascadeSave> <cascadeLog> <llmSave> <llmLog> [tasks.json]",
    );
    process.exit(1);
  }
  runCompare(cascadeSave, cascadeLog, llmSave, llmLog, tasksPath);
} else {
  const [savePath, logPath, tasksPath] = args;
  if (!savePath || !logPath) {
    console.error(
      "usage: npx tsx scripts/eval-run-quality.ts <save.json> <log.jsonl> [tasks.json]",
    );
    process.exit(1);
  }
  runSingle(savePath, logPath, tasksPath);
}
}
