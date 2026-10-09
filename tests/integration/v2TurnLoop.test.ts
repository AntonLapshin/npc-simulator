// PLAN_V2 Phase 6: the v2 turn path is the ONLY turn path (the
// TURN_LOOP flag and the v1 path are deleted). Scripted providers —
// MockIntentEngine + the standard mock engines — drive the turn.
import { describe, expect, it, vi } from "vitest";
import { runTurn } from "../../src/engine/turnOrchestrator.js";
import type { EngineDependencies } from "../../src/engine/turnOrchestrator.js";
import { MockIntentEngine } from "../../src/mocks/mockIntentEngine.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import type { IntentEngine, ConsequenceEngine } from "../../src/intelligence/types.js";
import type { Action, ConsequenceResult, World } from "../../src/types.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { defaultConfig } from "../../src/config.js";
import { makeTestDeps, makeTinyWorld } from "../helpers.js";

function makeV2Deps(
  sessionId: string,
  overrides: Partial<EngineDependencies> = {},
): { deps: EngineDependencies; logger: ReturnType<typeof createTestLogger> } {
  const logger = createTestLogger(sessionId);
  const deps = makeTestDeps(
    logger,
    {
      intentEngine: new MockIntentEngine(logger, {
        n: { action: "N waves at U.", quote: "" },
      }),
      consequenceEngine: new MockConsequenceEngine(logger, {
        "n waves at u.": {
          narrative: "N raises a hand toward U in a friendly wave.",
          thoughts: "Friendly.",
          emotion: "calm",
          reasoning: "scripted v2 turn",
        },
      }),
      getUserAction: async () => "U looks around.",
      ...overrides,
    },
  );
  return { deps, logger };
}

describe("v2 turn path", () => {
  it("the intent call decides the action; downstream is unchanged", async () => {
    const { deps, logger } = makeV2Deps("v2turn1");
    let world = makeTinyWorld();
    world = await runTurn(world, deps); // user turn (u)
    world = await runTurn(world, deps); // NPC turn (n)

    // The intent call ran; proposal/selection engines don't exist anymore.
    expect(logger.store.byEvent("intent_completed")).toHaveLength(1);
    expect(logger.store.byEvent("proposal_completed")).toHaveLength(0);
    expect(logger.store.byEvent("selection_completed")).toHaveLength(0);
    expect(logger.store.byEvent("proposal_skipped")).toHaveLength(1); // user turn

    // Downstream received the intent: the chosen action is the intent text.
    const chosen = logger.store.byEvent("action_chosen").find((e) => e.actorId === "n")!;
    expect(chosen.output).toMatchObject({ actorId: "n", text: "N waves at U." });

    // The turn completes: render ran, history appended, tick advanced.
    expect(
      logger.store.byEvent("render_accepted").filter((e) => e.actorId === "n"),
    ).toHaveLength(1);
    expect(world.tick).toBe(2);
    expect(world.history.map((e) => e.text).join("\n")).toContain("raises a hand toward U");
  });

  it("the intent fallback still produces a completing turn", async () => {
    // No script for "n" — the mock returns FALLBACK_INTENT.
    const logger = createTestLogger("v2turn2");
    const deps = makeTestDeps(logger, {
      intentEngine: new MockIntentEngine(logger),
      getUserAction: async () => "U looks around.",
    });
    let world = makeTinyWorld();
    world = await runTurn(world, deps);
    world = await runTurn(world, deps);
    expect(logger.store.byEvent("intent_completed")).toHaveLength(1);
    const chosen = logger.store.byEvent("action_chosen").find((e) => e.actorId === "n")!;
    expect(chosen.output).toMatchObject({
      actorId: "n",
      text: "waits and observes the situation.",
    });
    expect(world.tick).toBe(2);
  });

  it("human turns are unchanged — the user's text IS the intent", async () => {
    const getUserAction = vi.fn(async () => "User does a custom thing.");
    const { deps, logger } = makeV2Deps("v2turn3", { getUserAction });
    const world = await runTurn(makeTinyWorld(), deps); // user turn
    expect(getUserAction).toHaveBeenCalledOnce();
    expect(logger.store.byEvent("intent_completed")).toHaveLength(0);
    expect(logger.store.byEvent("proposal_skipped")).toHaveLength(1);
    expect(world.history[0]!.text).toContain("User does a custom thing.");
  });

  it("the intent call counts in the turn budget's proposal slot when provider-backed", async () => {
    const logger = createTestLogger("v2turn5");
    const deps = makeTestDeps(logger, {
      intentEngine: new MockIntentEngine(
        logger,
        { n: { action: "N waves at U.", quote: "" } },
        { providerBacked: true },
      ),
      consequenceEngine: new MockConsequenceEngine(
        logger,
        {
          "n waves at u.": {
            narrative: "N raises a hand toward U in a friendly wave.",
            thoughts: "Friendly.",
            emotion: "calm",
            reasoning: "scripted",
          },
        },
        { providerBacked: true },
      ),
      config: { ...defaultConfig, autosaveEnabled: false, turnCallBudget: 1 },
      getUserAction: async () => "U looks around.",
    });
    let world = makeTinyWorld();
    world = await runTurn(world, deps);
    world = await runTurn(world, deps);
    // 2 provider calls (intent + render) over a budget of 1 → loud warning, no abort.
    const exceeded = logger.store.byEvent("budget_exceeded");
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]!.output).toMatchObject({ providerCalls: 2, budget: 1 });
    expect(world.tick).toBe(2);
  });

  it("an intent engine failure surfaces via throw", async () => {
    const logger = createTestLogger("v2turn6");
    const failingIntent: IntentEngine = {
      async intent() {
        throw new Error("provider down");
      },
    };
    const deps = makeTestDeps(logger, {
      intentEngine: failingIntent,
      getUserAction: async () => "act",
    });
    // User turns skip the intent call, so advance past the user turn first
    // and let the NPC turn hit the failing intent engine.
    let world = await runTurn(makeTinyWorld(), deps);
    await expect(runTurn(world, deps)).rejects.toThrow("provider down");
  });
});

describe("turn_time_exceeded", () => {
  it("fires when a turn crosses the wall-time budget — and the turn still completes", async () => {
    const logger = createTestLogger("time1");
    const slow: ConsequenceEngine = {
      async resolve(_world: World, action: Action): Promise<ConsequenceResult> {
        await new Promise((r) => setTimeout(r, 60));
        return {
          narrative: `${action.actorId} sits still and breathes.`,
          thoughts: "Slow test.",
          emotion: "calm",
          reasoning: "scripted slow render",
        };
      },
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: slow,
      config: { ...defaultConfig, autosaveEnabled: false, turnTimeBudgetMs: 1 },
      getUserAction: async () => "User sits still.",
    });
    const world = await runTurn(makeTinyWorld(), deps);
    const events = logger.store.byEvent("turn_time_exceeded");
    expect(events).toHaveLength(1);
    expect(events[0]!.output).toMatchObject({ timeBudgetMs: 1 });
    expect(events[0]!.error).toContain("TURN TIME EXCEEDED");
    // Never aborts: the turn completed normally.
    expect(world.tick).toBe(1);
    expect(world.history).toHaveLength(1);
    expect(logger.store.byEvent("turn_completed")).toHaveLength(1);
  });

  it("stays silent when the turn is within budget", async () => {
    const { deps, logger } = makeV2Deps("time2", {
      config: { ...defaultConfig, autosaveEnabled: false, turnTimeBudgetMs: 30_000 },
    });
    const world = await runTurn(makeTinyWorld(), deps);
    expect(logger.store.byEvent("turn_time_exceeded")).toHaveLength(0);
    expect(world.tick).toBe(1);
  });
});
