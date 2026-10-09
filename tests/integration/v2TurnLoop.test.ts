// PLAN_V2 Phase 1: the TURN_LOOP=v2 turn path with scripted providers.
// No network — MockIntentEngine + the standard mock engines drive the turn.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runTurn } from "../../src/engine/turnOrchestrator.js";
import type { EngineDependencies } from "../../src/engine/turnOrchestrator.js";
import { MockIntentEngine } from "../../src/mocks/mockIntentEngine.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import type { IntentEngine, ConsequenceEngine } from "../../src/intelligence/types.js";
import type { Action, ConsequenceResult, World } from "../../src/types.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { defaultConfig, readTurnLoopV2 } from "../../src/config.js";
import { makeTestDeps, makeTinyWorld } from "../helpers.js";

const TURN_LOOP_ENV = "TURN_LOOP";
let savedTurnLoop: string | undefined;

beforeEach(() => {
  savedTurnLoop = process.env[TURN_LOOP_ENV];
});

afterEach(() => {
  if (savedTurnLoop === undefined) delete process.env[TURN_LOOP_ENV];
  else process.env[TURN_LOOP_ENV] = savedTurnLoop;
});

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

describe("readTurnLoopV2", () => {
  it("is true only for TURN_LOOP=v2", () => {
    expect(readTurnLoopV2({ TURN_LOOP: "v2" })).toBe(true);
    expect(readTurnLoopV2({})).toBe(false);
    expect(readTurnLoopV2({ TURN_LOOP: "V2" })).toBe(false);
    expect(readTurnLoopV2({ TURN_LOOP: "v1" })).toBe(false);
  });
});

describe("TURN_LOOP=v2 turn path", () => {
  it("replaces proposal+selection with the intent call; downstream is unchanged", async () => {
    process.env[TURN_LOOP_ENV] = "v2";
    const { deps, logger } = makeV2Deps("v2turn1");
    let world = makeTinyWorld();
    world = await runTurn(world, deps); // user turn (u)
    world = await runTurn(world, deps); // NPC turn (n) — the v2 path

    // The intent call ran; proposal/selection never did.
    expect(logger.store.byEvent("intent_completed")).toHaveLength(1);
    expect(logger.store.byEvent("proposal_completed")).toHaveLength(0);
    expect(logger.store.byEvent("selection_completed")).toHaveLength(0);
    expect(logger.store.byEvent("proposal_skipped")).toHaveLength(1); // user turn

    // Downstream received the intent: the chosen action is the intent text.
    const chosen = logger.store.byEvent("action_chosen").find((e) => e.actorId === "n")!;
    expect(chosen.output).toMatchObject({ actorId: "n", text: "N waves at U." });

    // The turn completes like a v1 turn: render ran, history appended, tick advanced.
    expect(
      logger.store.byEvent("render_accepted").filter((e) => e.actorId === "n"),
    ).toHaveLength(1);
    expect(world.tick).toBe(2);
    expect(world.history.map((e) => e.text).join("\n")).toContain("raises a hand toward U");
  });

  it("the intent fallback still produces a completing turn", async () => {
    process.env[TURN_LOOP_ENV] = "v2";
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

  it("human turns are unchanged on the v2 path — the user's text IS the intent", async () => {
    process.env[TURN_LOOP_ENV] = "v2";
    const getUserAction = vi.fn(async () => "User does a custom thing.");
    const { deps, logger } = makeV2Deps("v2turn3", { getUserAction });
    const world = await runTurn(makeTinyWorld(), deps); // user turn
    expect(getUserAction).toHaveBeenCalledOnce();
    expect(logger.store.byEvent("intent_completed")).toHaveLength(0);
    expect(logger.store.byEvent("proposal_skipped")).toHaveLength(1);
    expect(world.history[0]!.text).toContain("User does a custom thing.");
  });

  it("throws a clear error when the flag is set but no intent engine is wired", async () => {
    process.env[TURN_LOOP_ENV] = "v2";
    const logger = createTestLogger("v2turn4");
    const deps = makeTestDeps(logger, {
      getUserAction: async () => "User looks around.",
    });
    expect(deps.intentEngine).toBeUndefined();
    let world = makeTinyWorld();
    world = await runTurn(world, deps); // user turn — fine without it
    await expect(runTurn(world, deps)).rejects.toThrow(/TURN_LOOP=v2 requires an IntentEngine/);
  });

  it("the intent call counts in the turn budget's proposal slot when provider-backed", async () => {
    process.env[TURN_LOOP_ENV] = "v2";
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
});

describe("v1 path untouched", () => {
  it("with the flag unset, the intent engine is never called", async () => {
    delete process.env[TURN_LOOP_ENV];
    const logger = createTestLogger("v1untouched");
    const intentSpy = vi.fn(async (_world: World, _actorId: string) => {
      throw new Error("intent must not be called on the v1 path");
    });
    const intentEngine: IntentEngine = {
      intent: intentSpy,
      providerBacked: true,
    };
    const deps = makeTestDeps(logger, {
      intentEngine,
      getUserAction: async () => "User looks around.",
    });
    let world = makeTinyWorld();
    world = await runTurn(world, deps); // user turn
    world = await runTurn(world, deps); // NPC turn — v1 proposal+selection
    expect(intentSpy).not.toHaveBeenCalled();
    expect(logger.store.byEvent("proposal_completed").length).toBeGreaterThanOrEqual(1);
    expect(logger.store.byEvent("selection_completed").length).toBeGreaterThanOrEqual(1);
    expect(world.tick).toBe(2);
  });
});

describe("turn_time_exceeded", () => {
  it("fires when a turn crosses the wall-time budget — and the turn still completes", async () => {
    delete process.env[TURN_LOOP_ENV];
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
    delete process.env[TURN_LOOP_ENV];
    const { deps, logger } = makeV2Deps("time2", {
      config: { ...defaultConfig, autosaveEnabled: false, turnTimeBudgetMs: 30_000 },
    });
    process.env[TURN_LOOP_ENV] = "v2";
    const world = await runTurn(makeTinyWorld(), deps);
    expect(logger.store.byEvent("turn_time_exceeded")).toHaveLength(0);
    expect(world.tick).toBe(1);
  });
});
