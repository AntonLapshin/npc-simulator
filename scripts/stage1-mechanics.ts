// Stage 1 — Mechanics battery (renderer-architecture shakedown).
//
// Scripted simple actions through the FULL turn pipeline (proposal ->
// selection -> engine execute -> mock render) on scenarios/office-anton.json.
// Steps are ordered to match the world.order rotation (anton, tanya, dana)
// and to establish preconditions before use (pick up while adjacent, approach
// before hand-over):
//   0. walk to X (object destination: Anton walks to his desk)
//   1. stationary control (nobody moves on non-locomotion work)
//   2. pick up the laptop (Dana, adjacent to his laptop)
//   3. walk toward Y (actor destination: Anton walks toward Tanya)
//   4. speak an exact quote (byte-identical history check)
//   5. walk while holding (Dana carries the laptop toward Tanya)
//   6. second exact quote (Anton)
//   7. put her own laptop on the desk (Tanya clears her hands — the
//      scenario starts her holding a laptop and the hand-over guard
//      requires a free-handed recipient)
//   8. hand the laptop to Tanya (hand-over, holder flips)
//   9. third exact quote (Anton)
//   10. hand the laptop back to Dana (return transfer; a second
//      "places on the desk" would repeat step 7's putdown|laptop core
//      in the repetition screen)
//
// What it checks per step (the Stage-1 architectural claims):
//   - deterministic execution (whole battery run twice, final states equal)
//   - zero "(not done)" fallbacks on simple actions (sentinel scan)
//   - history quotes byte-identical to action quotes
//   - correct props/holders + scene-object relocation after manipulations
//   - only the acting actor moves
//
// Timing: wall-clock ms per step + total, printed as a table.
// Usage: npx tsx scripts/stage1-mechanics.ts
// Exit code 1 when any check fails.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_DONE_SENTINEL, type World } from "../src/types.js";
import { loadScenario } from "../src/engine/scenarioLoader.js";
import { getCurrentActor } from "../src/engine/worldStore.js";
import { runTurn, type EngineDependencies } from "../src/engine/turnOrchestrator.js";
import { MockIntentEngine } from "../src/mocks/mockIntentEngine.js";
import { MockConsequenceEngine } from "../src/mocks/mockConsequenceEngine.js";
import { Logger } from "../src/logging/logger.js";
import { defaultConfig } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const QUOTE1 = "Morning \u2014 is my laptop ready for the demo?";
const QUOTE2 = "Thanks \u2014 I found my desk.";
const QUOTE3 = "Nice place you have here.";

type Step = {
  name: string;
  actorId: string;
  action: string;
  check: (before: World, after: World) => string | null;
};

function actorPos(w: World, id: string): [number, number] {
  const a = w.actors.find((x) => x.id === id);
  if (!a) throw new Error(`unknown actor ${id}`);
  return [a.x, a.y];
}

function actorProp(w: World, id: string): string | null {
  const a = w.actors.find((x) => x.id === id);
  if (!a) throw new Error(`unknown actor ${id}`);
  return (a.prop ?? null) as string | null;
}

function historyLast(w: World): string {
  const h = w.history.at(-1);
  if (!h) return "";
  return typeof h === "string" ? h : (h.text ?? "");
}

function objectPos(w: World, id: string): [number, number] | null {
  const o = w.scene.objects.find((x) => x.id === id);
  return o ? [o.x, o.y] : null;
}

function othersUnmoved(before: World, after: World, actorId: string): string | null {
  for (const a of before.actors) {
    if (a.id === actorId) continue;
    const [bx, by] = actorPos(before, a.id);
    const [ax, ay] = actorPos(after, a.id);
    if (bx !== ax || by !== ay) return `non-acting actor ${a.id} moved (${bx},${by})->(${ax},${ay})`;
  }
  return null;
}

// Rotation: order is [anton, tanya, dana]; step index i must use order[i % 3].
const STEPS: Step[] = [
  {
    name: "walk-to-object",
    actorId: "anton",
    action: "Anton walks to his desk.",
    check: (before, after) => {
      const [bx, by] = actorPos(before, "anton");
      const [ax, ay] = actorPos(after, "anton");
      if (bx === ax && by === ay) return `anton did not move (still ${ax},${ay})`;
      return othersUnmoved(before, after, "anton");
    },
  },
  {
    name: "stationary-control",
    actorId: "tanya",
    // NOTE: worded without "desk" — "stays at her desk" cores to
    // other|desk and collides with the put-down step below (observed
    // false-positive repetition reject; see report). Same for the
    // quote: QUOTE1 carries a laptop noun so its core (other|laptop)
    // stays distinct from this filler (other|).
    action: "Tanya keeps working on the test plan at her seat.",
    check: (before, after) => {
      for (const a of before.actors) {
        const [bx, by] = actorPos(before, a.id);
        const [ax, ay] = actorPos(after, a.id);
        if (bx !== ax || by !== ay) return `actor ${a.id} moved on a stationary turn`;
      }
      return null;
    },
  },
  {
    name: "pick-up-laptop",
    actorId: "dana",
    action: "Dana picks up the laptop.",
    check: (_before, after) => {
      const prop = actorProp(after, "dana");
      if (prop !== "laptop") return `dana.prop = ${JSON.stringify(prop)}, expected "laptop"`;
      const [dx, dy] = actorPos(after, "dana");
      const lp = objectPos(after, "dana_laptop");
      if (lp === null) return "dana_laptop scene object missing after pick-up";
      if (lp[0] !== dx || lp[1] !== dy) {
        return `dana_laptop at (${lp[0]},${lp[1]}) did not travel with Dana (${dx},${dy})`;
      }
      return null;
    },
  },
  {
    name: "walk-toward-actor",
    actorId: "anton",
    action: "Anton walks toward Tanya.",
    check: (before, after) => {
      const [bx, by] = actorPos(before, "anton");
      const [ax, ay] = actorPos(after, "anton");
      if (bx === ax && by === ay) return `anton did not move (still ${ax},${ay})`;
      return othersUnmoved(before, after, "anton");
    },
  },
  {
    name: "exact-quote-1",
    actorId: "tanya",
    action: `Tanya says "${QUOTE1}"`,
    check: (_before, after) => {
      const last = historyLast(after);
      if (!last.includes(QUOTE1)) return `history missing byte-identical quote; got: ${last.slice(0, 160)}`;
      return null;
    },
  },
  {
    name: "walk-while-holding",
    actorId: "dana",
    action: "Dana walks toward Tanya.",
    check: (before, after) => {
      const [bx, by] = actorPos(before, "dana");
      const [ax, ay] = actorPos(after, "dana");
      if (bx === ax && by === ay) return `dana did not move while carrying (still ${ax},${ay})`;
      const prop = actorProp(after, "dana");
      if (prop !== "laptop") return `dana dropped the laptop mid-walk (prop=${JSON.stringify(prop)})`;
      // Stage-1 A3: the linked scene object travels with its holder —
      // no orphan at the pick-up site.
      const lp = objectPos(after, "dana_laptop");
      if (lp === null) return "dana_laptop scene object missing after carry-walk";
      if (lp[0] !== ax || lp[1] !== ay) {
        return `dana_laptop at (${lp[0]},${lp[1]}) did not travel with Dana (${ax},${ay})`;
      }
      return othersUnmoved(before, after, "dana");
    },
  },
  {
    name: "exact-quote-2",
    actorId: "anton",
    action: `Anton says "${QUOTE2}"`,
    check: (_before, after) => {
      const last = historyLast(after);
      if (!last.includes(QUOTE2)) return `history missing byte-identical quote2; got: ${last.slice(0, 160)}`;
      return null;
    },
  },
  {
    name: "clear-hands-put-down",
    actorId: "tanya",
    // Tanya starts the scenario holding a laptop: the hand-over guard
    // ("recipient's hands must be free") correctly rejected the first
    // attempt, so she puts her own laptop down first. Core other|desk —
    // distinct from her priors (other|, other|laptop).
    action: "Tanya places the laptop on the desk.",
    check: (_before, after) => {
      const prop = actorProp(after, "tanya");
      if (prop !== null) return `tanya.prop = ${JSON.stringify(prop)}, expected null after put-down`;
      const [tx, ty] = actorPos(after, "tanya");
      const lp = objectPos(after, "tanya_laptop");
      if (lp === null) return "tanya_laptop scene object missing after put-down";
      if (lp[0] !== tx || lp[1] !== ty) {
        return `tanya_laptop at (${lp[0]},${lp[1]}) not left at Tanya's feet (${tx},${ty})`;
      }
      return null;
    },
  },
  {
    name: "hand-over-laptop",
    actorId: "dana",
    action: "Dana hands Tanya the laptop.",
    check: (before, after) => {
      const d = actorProp(after, "dana");
      const t = actorProp(after, "tanya");
      if (d !== null) return `dana.prop = ${JSON.stringify(d)}, expected null after hand-over`;
      if (t !== "laptop") {
        const [dx, dy] = actorPos(before, "dana");
        const [tx, ty] = actorPos(before, "tanya");
        const dist = Math.hypot(dx - tx, dy - ty).toFixed(2);
        return `tanya.prop = ${JSON.stringify(t)}, expected "laptop" (pre hand-over distance Dana-Tanya: ${dist} cells)`;
      }
      return null;
    },
  },
  {
    name: "exact-quote-3",
    actorId: "anton",
    action: `Anton says "${QUOTE3}"`,
    check: (_before, after) => {
      const last = historyLast(after);
      if (!last.includes(QUOTE3)) return `history missing byte-identical quote3; got: ${last.slice(0, 160)}`;
      return null;
    },
  },
  {
    name: "hand-back-laptop",
    actorId: "tanya",
    // Return hand-over (covers the transfer path twice, both directions).
    // Core other|dana — distinct from her priors (other|desk, other|laptop,
    // other|). A second "places on the desk" here would core-collide with
    // the clear-hands put-down (other|desk) and be screen-rejected.
    action: "Tanya hands Dana the laptop.",
    check: (_before, after) => {
      const t = actorProp(after, "tanya");
      const d = actorProp(after, "dana");
      if (t !== null) return `tanya.prop = ${JSON.stringify(t)}, expected null after hand-back`;
      if (d !== "laptop") return `dana.prop = ${JSON.stringify(d)}, expected "laptop" after hand-back`;
      // Stage-1 A3: object identity is link-based now, not proximity
      // re-linked. Dana picked up dana_laptop (step 3), carried it across
      // the room (step 6), handed THAT object to Tanya (step 9) — so this
      // hand-back must return the same dana_laptop, not tanya_laptop.
      const [dx, dy] = actorPos(after, "dana");
      const lp = objectPos(after, "dana_laptop");
      if (lp === null) return "dana_laptop scene object missing after hand-back";
      if (lp[0] !== dx || lp[1] !== dy) {
        return `dana_laptop at (${lp[0]},${lp[1]}) did not return with Dana (${dx},${dy}): ` +
          `tanya_laptop=${JSON.stringify(objectPos(after, "tanya_laptop"))}`;
      }
      return null;
    },
  },
];

function loadOfficeAnton(): World {
  const raw = JSON.parse(readFileSync(join(ROOT, "scenarios/office-anton.json"), "utf-8"));
  return loadScenario(raw);
}

function snapshot(w: World): string {
  return JSON.stringify({
    actors: w.actors.map((a) => ({
      id: a.id,
      x: a.x,
      y: a.y,
      prop: a.prop ?? null,
      // Stage-1 A3: the held-object link is engine state — it must be
      // deterministic across passes too.
      heldObjectId: a.heldObjectId ?? null,
    })),
    objects: (w.scene.objects as Array<{ id: string; x: number; y: number }>).map((o) => ({
      id: o.id,
      x: o.x,
      y: o.y,
    })),
    history: w.history.map((h) => (typeof h === "string" ? h : h.text)),
    tick: w.tick,
  });
}

async function runBattery(label: string): Promise<{ world: World; stepMs: number[]; failures: string[] }> {
  let world = loadOfficeAnton();
  const stepMs: number[] = [];
  const failures: string[] = [];

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i]!;
    const current = getCurrentActor(world);
    if (current.id !== step.actorId) {
      failures.push(
        `[${label} step ${i + 1} ${step.name}] rotation mismatch: turn actor is ${current.id}, step expects ${step.actorId}`,
      );
      break;
    }
    const tick = world.tick;
    const quiet = new Logger({ sessionId: `stage1-${label}` });
    const intent = new MockIntentEngine(quiet, {
      [`${step.actorId}@tick${tick}`]: { action: step.action, quote: "" },
    });
    const consequence = new MockConsequenceEngine(quiet);
    const deps: EngineDependencies = {
      intentEngine: intent,
      consequenceEngine: consequence,
      logger: quiet,
      config: { ...defaultConfig, autosaveEnabled: false },
      getUserAction: async () => step.action,
      forceAllNpc: true,
    };
    const before = structuredClone(world);
    const t0 = performance.now();
    try {
      world = await runTurn(world, deps);
    } catch (err) {
      failures.push(
        `[${label} step ${i + 1} ${step.name}] runTurn threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      stepMs.push(performance.now() - t0);
      break;
    }
    stepMs.push(performance.now() - t0);

    const last = historyLast(world);
    if (last.includes(NOT_DONE_SENTINEL) || /\(not done\)/.test(last)) {
      failures.push(`[${label} step ${i + 1} ${step.name}] fallback marker in history: ${last.slice(0, 160)}`);
    }
    const problem = step.check(before, world);
    if (problem) failures.push(`[${label} step ${i + 1} ${step.name}] ${problem}`);
  }
  return { world, stepMs, failures };
}

async function main(): Promise<void> {
  const total0 = performance.now();
  const pass1 = await runBattery("pass1");
  const pass1Ms = performance.now() - total0;
  const total1 = performance.now();
  const pass2 = await runBattery("pass2");
  const pass2Ms = performance.now() - total1;

  const failures = [...pass1.failures, ...pass2.failures];
  const snap1 = snapshot(pass1.world);
  const snap2 = snapshot(pass2.world);
  const deterministic = snap1 === snap2;
  if (!deterministic) failures.push("non-determinism: pass1 and pass2 final snapshots differ");

  console.log("step | name               | actor | pass1 ms | pass2 ms");
  console.log("-----|--------------------|-------|----------|----------");
  STEPS.forEach((s, i) => {
    const a = (pass1.stepMs[i] ?? NaN).toFixed(1).padStart(8);
    const b = (pass2.stepMs[i] ?? NaN).toFixed(1).padStart(8);
    console.log(`${String(i + 1).padEnd(4)} | ${s.name.padEnd(18)} | ${s.actorId.padEnd(5)} | ${a} | ${b}`);
  });
  console.log(`\npass1 total ${(pass1Ms / 1000).toFixed(2)}s, pass2 total ${(pass2Ms / 1000).toFixed(2)}s`);
  console.log(`deterministic: ${deterministic}`);
  console.log(`not-done fallbacks: ${failures.filter((f) => f.includes("fallback marker")).length}`);
  console.log(failures.length === 0 ? "STAGE1_BATTERY: PASS" : `STAGE1_BATTERY: FAIL (${failures.length})`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`stage1 battery crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
