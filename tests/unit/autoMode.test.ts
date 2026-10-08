import { describe, expect, it } from "vitest";
import { runTurn } from "../../src/engine/turnOrchestrator.js";
import { makeTestDeps, makeTinyWorld } from "../helpers.js";
import { Logger } from "../../src/logging/logger.js";
import { DEFAULT_AUTO_TURNS, parseArgv } from "../../src/ui/text/textUi.js";

describe("autonomous mode (forceAllNpc)", () => {
  it("runs the user actor through the NPC pipeline without prompting", async () => {
    const logger = new Logger({ sessionId: "auto", writeToFile: false });
    const world = makeTinyWorld();
    // Current actor is "u", the scenario's user actor.
    expect(world.userActorId).toBe("u");
    let prompted = false;
    const deps = makeTestDeps(logger, {
      forceAllNpc: true,
      getUserAction: async () => {
        prompted = true;
        throw new Error("must not prompt in auto mode");
      },
    });
    const next = await runTurn(world, deps);
    expect(prompted).toBe(false);
    // NPC pipeline: proposal ran (not skipped) and the turn advanced.
    expect(logger.store.byEvent("proposal_skipped")).toHaveLength(0);
    expect(logger.store.byEvent("proposal_started").length).toBeGreaterThanOrEqual(1);
    expect(next.tick).toBe(world.tick + 1);
    expect(next.history.length).toBeGreaterThan(world.history.length);
  });

  it("without the flag the same world still takes the user path", async () => {
    const logger = new Logger({ sessionId: "auto-user", writeToFile: false });
    const deps = makeTestDeps(logger, {
      getUserAction: async () => "I wave hello.",
    });
    const next = await runTurn(makeTinyWorld(), deps);
    expect(logger.store.byEvent("proposal_skipped")).toHaveLength(1);
    expect(next.history[next.history.length - 1]!.text).toContain("wave hello");
  });

  it("without getUserAction and without the flag the user turn errors (unchanged)", async () => {
    const logger = new Logger({ sessionId: "auto-err", writeToFile: false });
    const { getUserAction: _omit, ...noPrompt } = makeTestDeps(logger);
    await expect(runTurn(makeTinyWorld(), noPrompt)).rejects.toThrow(/getUserAction is required/);
  });
});

describe("text UI --auto / --limit-turns parsing", () => {
  it("parses --auto with the default turn cap", () => {
    const opts = parseArgv(["--auto"]);
    expect(opts.auto).toBe(true);
    expect(opts.limitTurns).toBeUndefined();
    expect(DEFAULT_AUTO_TURNS).toBe(30);
  });

  it("parses --limit-turns in both forms", () => {
    expect(parseArgv(["--auto", "--limit-turns", "50"]).limitTurns).toBe(50);
    expect(parseArgv(["--auto", "--limit-turns=20"]).limitTurns).toBe(20);
  });

  it("rejects --limit-turns without --auto", () => {
    expect(() => parseArgv(["--limit-turns", "5"])).toThrow(/requires --auto/);
  });

  it("rejects non-positive or non-integer limits", () => {
    for (const bad of ["0", "-3", "2.5", "abc"]) {
      expect(() => parseArgv(["--auto", "--limit-turns", bad])).toThrow(/positive integer/);
    }
    expect(() => parseArgv(["--auto", "--limit-turns"])).toThrow(/positive integer/);
  });

  it("leaves existing flags untouched", () => {
    const opts = parseArgv(["--mock", "--auto", "scenarios/office.json"]);
    expect(opts).toMatchObject({ useMock: true, auto: true, scenarioPath: "scenarios/office.json" });
  });
});
