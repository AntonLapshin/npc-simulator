// Phase 6: turn-economics integration — the rigged run.
//
// A provider-backed mock stack (proposal + selection + a render engine
// that fails prose validation once, forcing the single render retry)
// against a turnCallBudget of 2 must log a loud `budget_exceeded` event
// and a `turn_telemetry` event that shows exactly where the calls went.
// The same run at the default budget must stay quiet.

import { describe, expect, it } from "vitest";
import type { Action, ConsequenceResult, World } from "../../src/types.js";
import type {
  ConsequenceEngine,
  ConsequenceResolveOpts,
} from "../../src/intelligence/types.js";
import { Logger } from "../../src/logging/logger.js";
import { defaultConfig } from "../../src/config.js";
import { runTurn } from "../../src/engine/turnOrchestrator.js";
import { MockProposalEngine } from "../../src/mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../../src/mocks/mockSelectionEngine.js";
import type { TurnTelemetry } from "../../src/core/telemetry.js";
import { makeTinyWorld } from "../helpers.js";

/**
 * Rigged render engine: first resolve() returns first-person prose
 * (trips the voice gate → one deterministic retry), every later call
 * returns clean third-person prose. Declares itself provider-backed so
 * the turn budget counts its invocations like real provider calls.
 */
class FlakyRenderEngine implements ConsequenceEngine {
  readonly providerBacked = true;
  private calls = 0;

  async resolve(
    _world: World,
    action: Action,
    _feedback?: string,
    _opts?: ConsequenceResolveOpts,
  ): Promise<ConsequenceResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        narrative: "I stretch my arms and look around the room.",
        thoughts: "Just stretching.",
        emotion: "calm",
      };
    }
    return {
      narrative: "U stretches and looks around the room, taking it in.",
      thoughts: "Just stretching.",
      emotion: "calm",
    };
  }
}

function makeRiggedDeps(logger: Logger, turnCallBudget: number) {
  const seen: TurnTelemetry[] = [];
  return {
    deps: {
      proposalEngine: new MockProposalEngine(logger, {}, { providerBacked: true }),
      selectionEngine: new MockSelectionEngine(logger, {}, { providerBacked: true }),
      consequenceEngine: new FlakyRenderEngine(),
      logger,
      config: { ...defaultConfig, autosaveEnabled: false, turnCallBudget },
      // forceAllNpc: the tiny world's first actor is the user actor —
      // autonomous mode runs it through proposal/selection/render.
      forceAllNpc: true,
      onTurnTelemetry: (t: TurnTelemetry) => {
        seen.push(t);
      },
    },
    seen,
  };
}

describe("turn economics (Phase 6)", () => {
  it("rigged run: 4 provider calls against budget 2 logs budget_exceeded + turn_telemetry", async () => {
    const logger = new Logger({ writeToFile: false });
    const { deps, seen } = makeRiggedDeps(logger, 2);

    const next = await runTurn(makeTinyWorld(), deps);

    // The turn itself still resolves cleanly — the budget never aborts.
    expect(next.history.length).toBeGreaterThan(0);

    const budgetEvents = logger.store.byEvent("budget_exceeded");
    expect(budgetEvents).toHaveLength(1);
    const output = budgetEvents[0]!.output as {
      providerCalls: number;
      budget: number;
      calls: { proposal: number; selection: number; render: number };
    };
    // 1 proposal + 1 selection + 2 render (initial + the forced retry).
    expect(output.providerCalls).toBe(4);
    expect(output.budget).toBe(2);
    expect(output.calls).toEqual({ proposal: 1, selection: 1, render: 2 });
    expect(budgetEvents[0]!.error).toContain("BUDGET EXCEEDED");

    const telemetryEvents = logger.store.byEvent("turn_telemetry");
    expect(telemetryEvents).toHaveLength(1);
    const telemetry = telemetryEvents[0]!.output as TurnTelemetry;
    expect(telemetry.providerCalls).toBe(4);
    expect(telemetry.budgetExceeded).toBe(true);
    expect(telemetry.calls).toEqual({ proposal: 1, selection: 1, render: 2 });
    expect(telemetry.outcome).toBe("clean");
    expect(telemetry.actorId).toBe("u");

    // The UI hook saw the same record.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(telemetry);
  });

  it("same rigged run at the default budget stays quiet", async () => {
    const logger = new Logger({ writeToFile: false });
    const { deps, seen } = makeRiggedDeps(logger, 4);

    await runTurn(makeTinyWorld(), deps);

    expect(logger.store.byEvent("budget_exceeded")).toHaveLength(0);
    const telemetry = logger.store.byEvent("turn_telemetry")[0]!.output as TurnTelemetry;
    expect(telemetry.budgetExceeded).toBe(false);
    expect(telemetry.providerCalls).toBe(4);
    expect(seen).toHaveLength(1);
  });

  it("local (non-provider-backed) engines cost nothing against the budget", async () => {
    const logger = new Logger({ writeToFile: false });
    const seen: TurnTelemetry[] = [];
    // Default mocks are local — providerBacked unset.
    const { makeTestDeps } = await import("../helpers.js");
    const deps = makeTestDeps(logger, {
      forceAllNpc: true,
      config: { ...defaultConfig, autosaveEnabled: false, turnCallBudget: 1 },
      onTurnTelemetry: (t: TurnTelemetry) => {
        seen.push(t);
      },
    });

    await runTurn(makeTinyWorld(), deps);

    expect(logger.store.byEvent("budget_exceeded")).toHaveLength(0);
    const telemetry = logger.store.byEvent("turn_telemetry")[0]!.output as TurnTelemetry;
    expect(telemetry.providerCalls).toBe(0);
    expect(seen).toHaveLength(1);
  });
});
