import { describe, expect, it, vi } from "vitest";
import { runTurn, resolveWithValidation } from "../../src/engine/turnOrchestrator.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import { MockProposalEngine } from "../../src/mocks/mockProposalEngine.js";
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

  it("user actor waits for input (getUserAction receives suggestions)", async () => {
    const logger = new Logger({ sessionId: "turn2", writeToFile: false });
    const getUserAction = vi.fn(async (_actorId: string, suggestions: string[]) => {
      expect(suggestions.length).toBeGreaterThan(0);
      return "Free-form user text.";
    });
    const deps = makeTestDeps(logger, { getUserAction });
    const world = await runTurn(makeTinyWorld(), deps);
    expect(getUserAction).toHaveBeenCalledOnce();
    expect(world.history[0]).toContain("Free-form user text.");
    expect(logger.store.byEvent("useractionsubmitted")).toHaveLength(1);
  });

  it("NPC actor uses proposal and selection", async () => {
    const logger = new Logger({ sessionId: "turn3", writeToFile: false });
    const deps = makeTestDeps(logger, { getUserAction: async () => "user act" });
    let world = makeTinyWorld();
    world = await runTurn(world, deps); // user turn
    world = await runTurn(world, deps); // NPC turn
    expect(logger.store.byEvent("proposal_completed").length).toBeGreaterThanOrEqual(2);
    expect(logger.store.byEvent("selection_completed").length).toBeGreaterThanOrEqual(1);
    expect(world.history.join("\n")).toContain("N acts:");
  });

  it("invalid consequence retries with feedback then falls back safely", async () => {
    const logger = new Logger({ sessionId: "turn4", writeToFile: false });
    const bad: ConsequenceResult = {
      narrative: "Teleport!",
      actorPatches: [{ actorId: "u", x: 999, y: 999 }],
      objectPatches: [],
      reasoning: "bad",
    };
    const consequenceEngine = new MockConsequenceEngine(logger, {
      "user does something.": bad,
    });
    const deps = makeTestDeps(logger, {
      consequenceEngine,
      getUserAction: async () => "User does something.",
      config: { ...(makeTestDeps(logger).config!), maxRetries: 1, autosaveEnabled: false },
    });
    const world = await runTurn(makeTinyWorld(), deps);
    expect(logger.store.byEvent("validation_failed").length).toBeGreaterThanOrEqual(1);
    expect(logger.store.byEvent("retry_started").length).toBeGreaterThanOrEqual(1);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(1);
    expect(world.history[world.history.length - 1]).toContain("Nothing changes.");
  });

  it("history appends action and narrative", async () => {
    const logger = new Logger({ sessionId: "turn5", writeToFile: false });
    const deps = makeTestDeps(logger, { getUserAction: async () => "Say hello." });
    const world = await runTurn(makeTinyWorld(), deps);
    expect(world.history).toHaveLength(2);
    expect(world.history[0]).toContain("Say hello.");
    expect(typeof world.history[1]).toBe("string");
  });

  it("resolveWithValidation returns valid output without retry", async () => {
    const logger = new Logger({ sessionId: "turn6", writeToFile: false });
    const deps = makeTestDeps(logger);
    const world = makeTinyWorld();
    const result = await resolveWithValidation(
      world,
      { actorId: "u", text: "Wave." },
      deps,
    );
    expect(result.narrative.length).toBeGreaterThan(0);
    expect(logger.store.byEvent("validation_passed")).toHaveLength(1);
  });

  it("retry logs parent action and validator logs success and failure", async () => {
    const logger = new Logger({ sessionId: "turn7", writeToFile: false });
    let calls = 0;
    const flaky: ConsequenceEngine = {
      async resolve(_world: World, action: Action): Promise<ConsequenceResult> {
        calls++;
        if (calls === 1) {
          return { narrative: "bad", actorPatches: [{ actorId: "nope", x: 1, y: 1 }], objectPatches: [], reasoning: "bad" };
        }
        return { narrative: "good", actorPatches: [], objectPatches: [], reasoning: "ok" };
      },
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: flaky,
      getUserAction: async () => "act",
    });
    await runTurn(makeTinyWorld(), deps);
    expect(logger.store.byEvent("validation_failed")).toHaveLength(1);
    expect(logger.store.byEvent("validation_passed")).toHaveLength(1);
    expect(logger.store.byEvent("retry_started")).toHaveLength(1);
  });

  it("engine error paths: proposal failure surfaces as error_occurred via throw", async () => {
    const logger = new Logger({ sessionId: "turn8", writeToFile: false });
    const failingProposal = {
      async propose() {
        throw new Error("provider down");
      },
    };
    const deps = makeTestDeps(logger, {
      proposalEngine: failingProposal as unknown as MockProposalEngine,
      getUserAction: async () => "act",
    });
    await expect(runTurn(makeTinyWorld(), deps)).rejects.toThrow("provider down");
  });
});
