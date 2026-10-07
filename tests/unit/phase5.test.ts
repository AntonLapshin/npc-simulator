// Phase 5 (longevity plan): compounding memory + context budget.
// Exit criteria: per-turn tokens flat (not linear), open questions persist
// until answered, newcomer refresh fires in Tanya/Dana subjective contexts,
// consequence ships a slim snapshot instead of the full world JSON.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config.js";
import {
  buildConsequenceContext,
  buildCoworkerAnchor,
  buildProposalContext,
  buildSelectionContext,
  buildSlimObjectiveSnapshot,
  estimatePromptTokens,
  formatHistoryForPrompt,
  getOpenQuestions,
  memoryGrowthStats,
  summarizeListForPrompt,
  worldMemoryBytes,
} from "../../src/engine/contextBuilder.js";
import { applyConsequence } from "../../src/engine/patchApplier.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { Logger } from "../../src/logging/logger.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import type { World } from "../../src/types.js";
import { makeTinyWorld, hist } from "../helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadAntonScenario(): World {
  const raw = JSON.parse(
    readFileSync(join(here, "../../scenarios/office-anton.json"), "utf-8"),
  );
  return loadScenario(raw);
}

/** Tiny world with a far-away actor/object carrying secret state. */
function farWorld(): World {
  const world = makeTinyWorld();
  world.scene.width = 30;
  world.scene.height = 30;
  const n = world.actors.find((a) => a.id === "n")!;
  n.x = 29;
  n.y = 29;
  n.memories.push("SECRET-999 far actor memory");
  world.scene.objects.push({
    id: "far_printer", name: "Far printer", description: "SECRET-DESC far object",
    x: 28, y: 28, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false,
  });
  world.scene.objects.push({
    id: "u_mug", name: "U's mug", description: "A mug.",
    x: 1, y: 1, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
  });
  return world;
}

describe("phase5 config limits", () => {
  it("ships budget defaults", () => {
    const config = resolveConfig();
    expect(config.maxBeliefsPerActor).toBeGreaterThan(0);
    expect(config.maxRelationshipsPerActor).toBeGreaterThan(0);
    expect(config.memorySummaryKeepNewest).toBeGreaterThan(0);
    expect(config.promptListBudgetChars).toBeGreaterThan(0);
    expect(config.promptHistoryBudgetChars).toBeGreaterThan(0);
    expect(config.openQuestionScanWindow).toBeGreaterThanOrEqual(60);
    expect(config.consequenceSnapshotRadius).toBeGreaterThan(0);
  });
});

describe("phase5 slim objective snapshot", () => {
  it("omits far-actor memories and far-object descriptions", () => {
    const world = farWorld();
    const snap = buildSlimObjectiveSnapshot(world, { actorId: "u", text: "Wave." });
    expect(snap).not.toContain("SECRET-999");
    expect(snap).not.toContain("SECRET-DESC");
    // Positions still shipped (movement/adjacency reasoning needs them).
    expect(snap).toContain("All actor positions");
    expect(snap).toContain("(29, 29)");
  });

  it("always includes named movement targets even when far", () => {
    const world = farWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const snap = buildSlimObjectiveSnapshot(world, { actorId: "u", text: "Walk to Nadia." });
    expect(snap).toContain("Nadia (n) at (29, 29)");
  });

  it("consequence context keeps the exact-id catalog and one-liners without full-world JSON", () => {
    const world = farWorld();
    const ctx = buildConsequenceContext(world, { actorId: "u", text: "Wave." });
    expect(ctx).toContain("Objective Snapshot");
    expect(ctx).not.toContain("Full Objective World");
    expect(ctx).not.toContain("SECRET-999");
    expect(ctx).not.toContain("SECRET-DESC");
    // Unchanged Phase 1–4 prompt surface.
    expect(ctx).toContain("OBJECT IDS");
    expect(ctx).toContain("QUOTED-SPEECH COPY RULE");
    expect(ctx).toContain("omitting the verb from the narrative never excuses omitting the patch");
    expect(ctx).toContain("at most 6 cells");
    expect(ctx).toContain("All actor positions");
  });
});

describe("phase5 rolling summarization (flat tokens)", () => {
  it("keeps newest entries verbatim and folds older ones into a digest", () => {
    const entries = Array.from({ length: 20 }, (_, i) => `Memory number ${i} about the office routine.`);
    const out = summarizeListForPrompt(entries, 3, 1200);
    expect(out).toContain("Memory number 19");
    expect(out).toContain("Memory number 18");
    expect(out).toContain("Memory number 17");
    expect(out).toMatch(/Earlier \(17 entries, summarized\)/);
    expect(out.length).toBeLessThanOrEqual(1200);
  });

  it("dedupes exact repeats and handles empty lists", () => {
    expect(summarizeListForPrompt([])).toBe("(none)");
    const out = summarizeListForPrompt(["Hi.", "Hi.", "Hi."], 8, 1200);
    expect(out).toBe("- Hi.");
  });

  it("proposal tokens stay flat as stored memories compound", () => {
    const makeThick = (n: number): World => {
      const w = makeTinyWorld();
      w.actors.find((a) => a.id === "u")!.memories = Array.from(
        { length: n },
        (_, i) => `Thick memory entry ${i} with some detail about office life and projects.`,
      );
      w.actors.find((a) => a.id === "u")!.beliefs = Array.from(
        { length: n },
        (_, i) => `Thick belief entry ${i} about how the office works.`,
      );
      return w;
    };
    const thinLen = buildProposalContext(makeTinyWorld(), "u").length;
    const sixty = buildProposalContext(makeThick(60), "u").length;
    const hundredTwenty = buildProposalContext(makeThick(120), "u").length;
    // Bounded absolute growth over the thin baseline (two sections at budget)…
    expect(sixty - thinLen).toBeLessThan(4000);
    expect(sixty).toBeLessThan(12000);
    // …and ~zero marginal growth as stored entries double (digest absorbs it).
    expect(hundredTwenty - sixty).toBeLessThan(500);
  });

  it("consequence tokens stay flat as history compounds", () => {
    const thin = makeTinyWorld();
    const thick = makeTinyWorld();
    for (let i = 0; i < 150; i++) {
      thick.history.push(hist(thick, `U: filler turn ${i} describing routine office activity in words.`));
    }
    const thinLen = buildConsequenceContext(thin, { actorId: "u", text: "Wave." }).length;
    const thickLen = buildConsequenceContext(thick, { actorId: "u", text: "Wave." }).length;
    expect(thickLen / thinLen).toBeLessThan(2);
  });

  it("history budget head-truncates with a note", () => {
    const history = Array.from({ length: 30 }, (_, i) => `Entry ${i} ` + "x".repeat(100));
    const out = formatHistoryForPrompt(history, 30, 500);
    expect(out).toMatch(/older entries omitted for budget/);
    expect(out).toContain("Entry 29");
    expect(out.length).toBeLessThan(900);
  });
});

describe("phase5 open questions persist until answered", () => {
  it("survives many intervening turns, closes when the addressee speaks", () => {
    const world = makeTinyWorld();
    world.history.push(hist(world, "U: N, where is my desk?"));
    for (let i = 0; i < 25; i++) {
      world.history.push(hist(world, `Zed: filler chatter turn ${i} about the weather.`));
    }
    // Still open after 25 unrelated turns (old code lost it past the slice).
    expect(getOpenQuestions(world, "n")).toHaveLength(1);
    expect(buildProposalContext(world, "n")).toContain("where is my desk?");
    // Addressee responds -> their turn to move on; question closes.
    world.history.push(hist(world, "N: Over by the window, U!"));
    expect(getOpenQuestions(world, "n")).toHaveLength(0);
  });

  it("a new question after an answer re-opens", () => {
    const world = makeTinyWorld();
    world.history.push(hist(world, "U: N, where is my desk?"));
    world.history.push(hist(world, "N: Over by the window!"));
    world.history.push(hist(world, "U: N, what should my first task be?"));
    expect(getOpenQuestions(world, "n")).toEqual(["U: N, what should my first task be?"]);
  });
});

describe("phase5 per-actor newcomer refresh (Exp-2 item 13)", () => {
  it("Tanya's subjective contexts pin Anton as hired ex-Sixt, never stranger/candidate", () => {
    const world = loadAntonScenario();
    const anchor = buildCoworkerAnchor(world, "tanya");
    expect(anchor).toContain("Anton (anton)");
    expect(anchor).toMatch(/Sixt/);
    expect(anchor).toMatch(/never a stranger\/candidate/);
    expect(buildProposalContext(world, "tanya")).toContain("KNOWN HISTORY");
    expect(buildSelectionContext(world, "tanya", ["Wave."])).toContain("KNOWN HISTORY");
  });

  it("Dana's context pins Anton too", () => {
    const world = loadAntonScenario();
    expect(buildCoworkerAnchor(world, "dana")).toContain("Anton (anton)");
  });

  it("emits nothing when no referral/history facts exist (no prompt tax)", () => {
    const world = makeTinyWorld();
    expect(buildCoworkerAnchor(world, "u")).toBe("");
    expect(buildProposalContext(world, "u")).not.toContain("KNOWN HISTORY");
  });

  it("uses only public persona facts — no leaked goals or thoughts", () => {
    const world = loadAntonScenario();
    world.actors.find((a) => a.id === "anton")!.goal = "SECRET-PLAN-999";
    world.actors.find((a) => a.id === "anton")!.thoughts = "SECRET-THOUGHT-999";
    const anchor = buildCoworkerAnchor(world, "tanya");
    expect(anchor).not.toContain("SECRET-PLAN-999");
    expect(anchor).not.toContain("SECRET-THOUGHT-999");
  });
});

describe("phase5 memory caps and growth metrics", () => {
  it("trims beliefs/relationships at the new caps, memories unchanged", () => {
    const world = makeTinyWorld();
    const config = resolveConfig({ maxBeliefsPerActor: 2, maxRelationshipsPerActor: 2 });
    const next = applyConsequence(
      world,
      {
        narrative: "n",
        actorPatches: [{
          actorId: "u",
          beliefsAppend: ["b1", "b2", "b3"],
          relationshipsAppend: ["r1", "r2", "r3"],
        }],
        objectPatches: [],
        reasoning: "r",
      },
      { actorId: "u", text: "act" },
      config,
    );
    const u = next.actors.find((a) => a.id === "u")!;
    expect(u.beliefs).toEqual(["b2", "b3"]);
    expect(u.relationships).toEqual(["r2", "r3"]);
  });

  it("memoryGrowthStats tracks the compounding curve", () => {
    const world = makeTinyWorld();
    const before = memoryGrowthStats(world);
    world.actors.find((a) => a.id === "u")!.memories.push("Something happened today.");
    world.history.push(hist(world, "U: Hello everyone."));
    const after = memoryGrowthStats(world);
    expect(after.memoryEntries).toBe(before.memoryEntries + 1);
    expect(after.historyEntries).toBe(before.historyEntries + 1);
    expect(after.memoryBytes).toBeGreaterThan(before.memoryBytes);
    expect(worldMemoryBytes(world)).toBe(after.memoryBytes);
    expect(estimatePromptTokens("abcd")).toBe(1);
  });

  it("mock consequence_completed logs prompt size for token curves", async () => {
    const logger = new Logger({ sessionId: "phase5-tokens", writeToFile: false });
    const engine = new MockConsequenceEngine(logger);
    await engine.resolve(makeTinyWorld(), { actorId: "u", text: "Wave." });
    const done = logger.store.byEvent("consequence_completed");
    expect(done).toHaveLength(1);
    expect(done[0]!.promptChars).toBeGreaterThan(0);
    expect(done[0]!.promptTokensEstimate).toBeGreaterThan(0);
  });
});
