import { describe, expect, it, vi } from "vitest";
import { runTurn, resolveRender } from "../../src/engine/turnOrchestrator.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import { MockIntentEngine } from "../../src/mocks/mockIntentEngine.js";
import type { ConsequenceEngine } from "../../src/intelligence/types.js";
import { Logger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld } from "../helpers.js";
import type { Action, ConsequenceResult, World } from "../../src/types.js";

describe("turn loop", () => {
  it("turn order advances and tick increments", async () => {
    const logger = new Logger({ sessionId: "turn1", writeToFile: false });
    const deps = makeTestDeps(logger, { getUserAction: async () => "User does something." });
    let world = makeTinyWorld();
    expect(world.order[world.turnIndex]).toBe("u");
    world = await runTurn(world, deps);
    expect(world.tick).toBe(1);
    expect(world.order[world.turnIndex]).toBe("n");
    world = await runTurn(world, deps);
    expect(world.tick).toBe(2);
    expect(world.order[world.turnIndex]).toBe("u");
  });

  it("user actor waits for input (no proposal/selection on user turns)", async () => {
    const logger = new Logger({ sessionId: "turn2", writeToFile: false });
    const getUserAction = vi.fn(async (_actorId: string, suggestions: string[]) => {
      // User turns skip proposal entirely — no suggestions are generated.
      expect(suggestions).toEqual([]);
      return "Free-form user text.";
    });
    const deps = makeTestDeps(logger, { getUserAction });
    const world = await runTurn(makeTinyWorld(), deps);
    expect(getUserAction).toHaveBeenCalledOnce();
    expect(world.history[0]!.text).toContain("Free-form user text.");
    expect(logger.store.byEvent("useractionsubmitted")).toHaveLength(1);
    expect(logger.store.byEvent("proposal_skipped")).toHaveLength(1);
    expect(logger.store.byEvent("proposal_completed")).toHaveLength(0);
    expect(logger.store.byEvent("selection_completed")).toHaveLength(0);
  });

  it("NPC actor decides via one intent call", async () => {
    const logger = new Logger({ sessionId: "turn3", writeToFile: false });
    const deps = makeTestDeps(logger, { getUserAction: async () => "user act" });
    let world = makeTinyWorld();
    world = await runTurn(world, deps); // user turn (intent skipped)
    world = await runTurn(world, deps); // NPC turn
    // Only the NPC turn runs the intent call.
    expect(logger.store.byEvent("proposal_skipped")).toHaveLength(1);
    expect(logger.store.byEvent("intent_started")).toHaveLength(1);
    expect(logger.store.byEvent("intent_completed").length).toBeGreaterThanOrEqual(1);
    expect(world.history.map((e) => e.text).join("\n")).toContain("N:");
  });

  it("bad render fails twice then is accepted-and-marked (no salvage, no patch repairs)", async () => {
    const logger = new Logger({ sessionId: "turn4", writeToFile: false });
    // The narrative claims a walk the engine never executed — a prose
    // violation under the render contract (movement is engine-owned).
    const bad: ConsequenceResult = {
      narrative: "U walks to the door.",
      reasoning: "bad",
    };
    const consequenceEngine = new MockConsequenceEngine(logger, {
      "wave.": bad,
    });
    const deps = makeTestDeps(logger, {
      consequenceEngine,
      getUserAction: async () => "Wave.",
    });
    const world = await runTurn(makeTinyWorld(), deps);
    // PLAN_V2 Phase 4: exactly one retry, then the flawed paragraph is
    // accepted and marked honest — a flawed paragraph beats a dead turn.
    expect(logger.store.byEvent("render_failed")).toHaveLength(2);
    expect(logger.store.byEvent("narrate_accepted_despite_violations")).toHaveLength(1);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });

  it("history appends a single tickless entry per turn", async () => {
    const logger = new Logger({ sessionId: "turn5", writeToFile: false });
    const deps = makeTestDeps(logger, { getUserAction: async () => "Say hello." });
    const world = await runTurn(makeTinyWorld(), deps);
    expect(world.history).toHaveLength(1);
    expect(world.history[0]!.text).toContain("Say hello.");
    expect(world.history[0]!.text).not.toMatch(/^Tick \d+ - /);
  });

  it("resolveRender returns prose without retry on clean turns", async () => {
    const logger = new Logger({ sessionId: "turn6", writeToFile: false });
    const deps = makeTestDeps(logger);
    const world = makeTinyWorld();
    const { render, executed } = await resolveRender(
      world,
      { actorId: "u", text: "Wave." },
      deps,
    );
    expect(render.narrative.length).toBeGreaterThan(0);
    expect(executed.movement).toBeNull();
    expect(logger.store.byEvent("render_accepted")).toHaveLength(1);
    expect(logger.store.byEvent("render_failed")).toHaveLength(0);
  });

  it("prose failure retries once with feedback, then accepts", async () => {
    const logger = new Logger({ sessionId: "turn7", writeToFile: false });
    let calls = 0;
    let sawFeedback = false;
    const flaky: ConsequenceEngine = {
      async resolve(_world: World, action: Action, feedback?: string): Promise<ConsequenceResult> {
        calls++;
        if (feedback !== undefined) sawFeedback = true;
        if (calls === 1) {
          // Claims unexecuted locomotion — a render-contract violation.
          return { narrative: "U walks to the door.", reasoning: "bad" };
        }
        return { narrative: "U waves.", reasoning: "ok" };
      },
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: flaky,
      getUserAction: async () => "act",
    });
    await runTurn(makeTinyWorld(), deps);
    expect(calls).toBe(2);
    expect(sawFeedback).toBe(true);
    expect(logger.store.byEvent("render_failed")).toHaveLength(1);
    expect(logger.store.byEvent("render_accepted")).toHaveLength(1);
  });

  it("engine error paths: NPC intent failure surfaces via throw", async () => {
    const logger = new Logger({ sessionId: "turn8", writeToFile: false });
    const failingIntent = {
      async intent() {
        throw new Error("provider down");
      },
    };
    const deps = makeTestDeps(logger, {
      intentEngine: failingIntent as unknown as MockIntentEngine,
      getUserAction: async () => "act",
    });
    // User turns skip intent, so advance past the user turn first and let
    // the NPC turn hit the failing intent engine.
    let world = await runTurn(makeTinyWorld(), deps);
    await expect(runTurn(world, deps)).rejects.toThrow("provider down");
  });

  it("ACCEPTANCE: 3-turn run stays within the per-turn call budget", async () => {
    const logger = new Logger({ sessionId: "accept_calls", writeToFile: false });
    // Provider-call counting wrapper: every engine call is one provider call.
    const callsByTick = new Map<number, { intent: number; consequence: number }>();
    const bucket = (tick: number) => {
      let b = callsByTick.get(tick);
      if (!b) {
        b = { intent: 0, consequence: 0 };
        callsByTick.set(tick, b);
      }
      return b;
    };
    const counting = <T extends { intent?: unknown; resolve?: unknown }>(
      engine: T,
      kind: "intent" | "consequence",
      method: "intent" | "resolve",
    ): T => {
      const orig = (engine as Record<string, (...a: never[]) => Promise<unknown>>)[method]!.bind(engine);
      (engine as Record<string, unknown>)[method] = async (...args: never[]) => {
        const world = args[0] as World;
        bucket(world.tick)[kind]++;
        return orig(...args);
      };
      return engine;
    };
    const deps = makeTestDeps(logger, {
      intentEngine: counting(new MockIntentEngine(logger), "intent", "intent"),
      consequenceEngine: counting(
        new MockConsequenceEngine(logger, {
          "wave at n.": { narrative: "U waves at N.", thoughts: "Friendly.", reasoning: "r" },
          "say hi.": { narrative: "U says hi.", thoughts: "Polite.", reasoning: "r" },
        }),
        "consequence",
        "resolve",
      ),
      getUserAction: async () => "Wave at N.",
    });
    let world = makeTinyWorld();
    for (let i = 0; i < 3; i++) world = await runTurn(world, deps);

    expect(callsByTick.size).toBe(3);
    for (const [tick, counts] of callsByTick) {
      const total = counts.intent + counts.consequence;
      // Turn = intent (LLM, skipped on user turns) → parse (Laya, local,
      // 0 provider calls) → execute/clamp (engine, 0 calls) → narrate (LLM).
      // Clean turns cost at most intent + narrate = 2 provider calls.
      expect(total, `tick ${tick}`).toBeLessThanOrEqual(2);
      // The narrate engine is exactly 1 call on clean turns (no retry loop).
      expect(counts.consequence, `tick ${tick}`).toBe(1);
    }
    expect(logger.store.byEvent("render_accepted")).toHaveLength(3);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });

  it("ACCEPTANCE: garbage old-schema patches in a render response are ignored, turn stays clean", async () => {
    const logger = new Logger({ sessionId: "accept_garbage", writeToFile: false });
    // A render engine stuck on the pre-Phase-4 schema: prose plus garbage
    // actorPatches/objectPatches/effects. The schema strips the unknown
    // keys; the engine never validates them.
    const garbageEngine: ConsequenceEngine = {
      async resolve(): Promise<ConsequenceResult> {
        return {
          narrative: "U waves at N.",
          thoughts: "Friendly.",
          reasoning: "r",
          actorPatches: [{ actorId: "u", x: 999, y: 999, emotion: "evil" }],
          objectPatches: [{ objectId: "ghost", description: "x" }],
          effects: { moved: true, spoke: false },
        } as unknown as ConsequenceResult;
      },
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: garbageEngine,
      getUserAction: async () => "Wave at N.",
    });
    const world = makeTinyWorld();
    const next = await runTurn(world, deps);
    // Turn is clean: exactly one render call, accepted on attempt 1.
    expect(logger.store.byEvent("render_accepted")).toHaveLength(1);
    expect(logger.store.byEvent("render_failed")).toHaveLength(0);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    // The garbage patches changed nothing: no teleport, no emotion change.
    const u = next.actors.find((a) => a.id === "u")!;
    expect([u.x, u.y]).toEqual([1, 1]);
    expect(next.history.at(-1)!.text).toBe("U: U waves at N.");
  });
});
