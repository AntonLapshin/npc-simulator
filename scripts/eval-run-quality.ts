// Run-quality eval harness (Exp-4 item 11 / S9, S6-measure, §D).
//
// Scores a COMPLETED run from its artifacts — no live models needed:
//   npx tsx scripts/eval-run-quality.ts <save.json> <log.jsonl> [tasks.json]
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
// Pure offline analysis — safe to run anywhere.

import { readFileSync } from "node:fs";
import { NOT_DONE_SENTINEL } from "../src/types.js";
import { detectVoiceViolation } from "../src/engine/validate/narrative.js";

const [savePath, logPath, tasksPath] = process.argv.slice(2);
if (!savePath || !logPath) {
  console.error(
    "usage: npx tsx scripts/eval-run-quality.ts <save.json> <log.jsonl> [tasks.json]",
  );
  process.exit(1);
}

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

const byEvent = (name: string) => events.filter((e) => e.event === name);

// ---------------------------------------------------------------------------
// 1. Outcome histogram (from save history — the canonical record)
// ---------------------------------------------------------------------------

console.log("== outcomes (from save history) ==");
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
let tA = 0, tP = 0, tF = 0;
for (const [id, s] of perActor) {
  const n = s.applied + s.partial + s.fallback;
  tA += s.applied; tP += s.partial; tF += s.fallback;
  const who = id === world.userActorId ? "user" : "npc";
  console.log(
    `  ${id} (${who}): ${s.applied} applied / ${s.partial} partial / ${s.fallback} fallback ` +
      `(${(100 * s.fallback / n).toFixed(0)}% fallback)`,
  );
}
const tN = tA + tP + tF;
console.log(
  `  TOTAL: ${tA} applied / ${tP} partial / ${tF} fallback (${(100 * tF / tN).toFixed(0)}% fallback, ${tN} turns)`,
);

// ---------------------------------------------------------------------------
// 2. Task completion (from turn_completed per-tick applied worlds)
// ---------------------------------------------------------------------------

const snapshots = byEvent("turn_completed")
  .map((e) => ({ tick: e.tick as number, world: e.output as World }))
  .filter((s) => s.world && Array.isArray(s.world.actors))
  .sort((a, b) => a.tick - b.tick);

const distToRect = (x: number, y: number, o: SceneObject) => {
  const cx = Math.min(Math.max(x, o.x), o.x + o.w);
  const cy = Math.min(Math.max(y, o.y), o.y + o.h);
  return Math.hypot(x - cx, y - cy);
};

if (tasksPath && snapshots.length > 0) {
  console.log("\n== task completion (applied worlds only) ==");
  const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as {
    actorId: string;
    targetObjectId?: string;
    targetActorId?: string;
    radius?: number;
    label: string;
  }[];
  // Target positions from the FIRST snapshot (objects may move later).
  const firstObjects = snapshots[0]!.world.scene.objects;
  for (const t of tasks) {
    const radius = t.radius ?? 2;
    const report = (ok: boolean, best: number, bestTick: number) =>
      console.log(
        `  [${ok ? "DONE" : "miss"}] ${t.label}: closest ${best.toFixed(1)} cells ` +
          `(radius ${radius}) at tick ${bestTick}`,
      );
    if (t.targetActorId) {
      // Track the target actor's CURRENT position per snapshot.
      let best = Infinity, bestTick = -1;
      for (const s of snapshots) {
        const a = s.world.actors.find((a) => a.id === t.actorId);
        const tgt = s.world.actors.find((a) => a.id === t.targetActorId);
        if (!a || !tgt) continue;
        const d = Math.hypot(a.x - tgt.x, a.y - tgt.y);
        if (d < best) { best = d; bestTick = s.tick; }
      }
      report(best <= radius, best, bestTick);
      continue;
    }
    const o = t.targetObjectId
      ? firstObjects.find((o) => o.id === t.targetObjectId)
      : undefined;
    if (!o) {
      console.log(`  [?] ${t.label}: target object not found in first snapshot`);
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
    report(best <= radius, best, bestTick);
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
} else if (tasksPath) {
  console.log("\n== task completion: no turn_completed snapshots in log ==");
}

// ---------------------------------------------------------------------------
// 3. Memory precision
// ---------------------------------------------------------------------------

console.log("\n== memory precision ==");
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
for (const a of world.actors) {
  const mems = a.memories ?? [];
  if (mems.length === 0) {
    console.log(`  ${a.id}: no memories`);
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
        examples.push(`      - [${kinds.join(",")}] ${m.slice(0, 90)}`);
      }
    }
  }
  const precision = 1 - defects / mems.length;
  console.log(
    `  ${a.id}: ${(100 * precision).toFixed(0)}% clean (${mems.length - defects}/${mems.length})`,
  );
  for (const ex of examples) console.log(ex);
}
// Exp-6 item 13 (S10): bind the salience gate to the measurement —
// corrupt memories banked WHILE the gate was active are gate misses.
{
  const salience = byEvent("salience_scored").length;
  const triage = byEvent("triage_applied").length;
  const banked = byEvent("memory_banked").length;
  console.log(
    `  salience: ${salience} scored / ${triage} triaged` +
      (banked > 0 ? ` / ${banked} banked` : " (no memory_banked events in log)"),
  );
}

// ---------------------------------------------------------------------------
// 4. Object-patch grounding in applied/partial turns (approximate)
// ---------------------------------------------------------------------------

console.log("\n== object grounding (applied/partial turns) ==");
const fallbackTicks = new Set(byEvent("fallback_used").map((e) => e.tick));
const consByTick = new Map<number, any[]>();
for (const e of byEvent("consequence_completed")) {
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
  const keyOf = (o: SceneObject) => o.id;
  const firstById = new Map(first.map((o) => [keyOf(o), o]));
  const lastById = new Map(last.map((o) => [keyOf(o), o]));
  let changed = 0;
  const changedIds: string[] = [];
  for (const [id, o] of lastById) {
    const before = firstById.get(id);
    if (!before || JSON.stringify(before) !== JSON.stringify(o)) {
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

// ---------------------------------------------------------------------------
// 5. Machinery event counts
// ---------------------------------------------------------------------------

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
  const n = byEvent(name).length;
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
