// Stage 3 C2/C3/C4: honest telemetry for fallback-delegated decision calls.
//
// The Stage 3 cascade-vs-LLM comparison exposed that the Laya cascade
// engines delegate to their fallback invisibly: the per-turn P/S columns
// read 0/0 while the fallback burned 23 real LLM decision calls, the
// delegation cause was unrecoverable post-hoc, and the renderability
// re-pick through a delegating engine doubled selection spend (14 vs 10).
//
// C2 — a Laya engine delegating to a provider-backed fallback counts one
//      provider call per stage in the turn budget (visible in
//      onTurnTelemetry's breakdown).
// C3 — each delegation logs a `cascade_delegated` event carrying the cause.
// C4 — when the first selection already delegated to a provider-backed
//      fallback, the renderability re-pick goes deterministic instead of
//      burning a second provider call.

import { describe, expect, it } from "vitest";
import type { SelectionResult, World } from "../../src/types.js";
import type { TurnTelemetry } from "../../src/core/telemetry.js";
import { Logger } from "../../src/logging/logger.js";
import { defaultConfig } from "../../src/config.js";
import { runTurn, type EngineDependencies } from "../../src/engine/turnOrchestrator.js";
import { LayaClient } from "../../src/decision/layaClient.js";
import { LayaProposalEngine } from "../../src/decision/layaProposalEngine.js";
import { LayaSelectionEngine } from "../../src/decision/layaSelectionEngine.js";
import { MockProposalEngine } from "../../src/mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../../src/mocks/mockSelectionEngine.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import { makeTinyWorld } from "../helpers.js";

/** Laya client that is always down: every decide() throws, so the Laya engines always delegate. */
function downClient(): LayaClient {
  return new LayaClient({
    baseUrl: "http://stub",
    fetchImpl: (async () => {
      throw new Error("laya down");
    }) as typeof fetch,
  });
}

/** Laya client answering every score question with the given wire score level. */
function scoreClient(score: number): LayaClient {
  return new LayaClient({
    baseUrl: "http://stub",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions ?? {})) {
        answers[id] = { type: "score", score, probabilities: { [String(score)]: 1 } };
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch,
  });
}

/** Mock selection fallback that counts its invocations. */
class CountingSelectionFallback extends MockSelectionEngine {
  calls = 0;
  override async select(
    world: World,
    actorId: string,
    suggestions: string[],
  ): Promise<SelectionResult> {
    this.calls += 1;
    return super.select(world, actorId, suggestions);
  }
}

function layaToggles(renderability: boolean) {
  return {
    selection: true,
    judge: false,
    triage: false,
    salience: false,
    planner: false,
    salvageSelect: false,
    locomotion: false,
    renderability,
  };
}

function makeDeps(
  logger: Logger,
  seen: TurnTelemetry[],
  opts: {
    providerBackedFallbacks: boolean;
    renderability: boolean;
    renderabilityScore?: number;
    selectionFallback?: CountingSelectionFallback;
  },
): EngineDependencies {
  const engineClient = downClient();
  const proposalFallback = new MockProposalEngine(logger, {}, { providerBacked: opts.providerBackedFallbacks });
  const selectionFallback =
    opts.selectionFallback ??
    new MockSelectionEngine(logger, {}, { providerBacked: opts.providerBackedFallbacks });
  const deps: EngineDependencies = {
    proposalEngine: new LayaProposalEngine({ client: engineClient }, proposalFallback),
    selectionEngine: new LayaSelectionEngine({ client: engineClient }, selectionFallback),
    consequenceEngine: new MockConsequenceEngine(logger),
    logger,
    config: { ...defaultConfig, autosaveEnabled: false },
    forceAllNpc: true,
    onTurnTelemetry: (t: TurnTelemetry) => {
      seen.push(t);
    },
  };
  if (opts.renderability) {
    deps.laya = {
      client: scoreClient(opts.renderabilityScore ?? 1),
      config: {
        url: "http://stub",
        mode: "static",
        confidenceThreshold: 0.55,
        timeoutMs: 5000,
        maxOptions: 12,
        toggles: layaToggles(true),
      },
      salienceThreshold: 3,
      plausibility: false,
    };
  }
  return deps;
}

describe("Stage 3 C2/C3: delegated fallback calls are honest", () => {
  it("counts one provider call per stage when the fallback is provider-backed", async () => {
    const logger = new Logger({ sessionId: "s3-c2", writeToFile: false });
    const seen: TurnTelemetry[] = [];
    const deps = makeDeps(logger, seen, { providerBackedFallbacks: true, renderability: false });

    await runTurn(makeTinyWorld(), deps);

    // The old lie was P/S = 0/0 while the fallback burned real calls.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.calls.proposal).toBe(1);
    expect(seen[0]!.calls.selection).toBe(1);
  });

  it("logs a cascade_delegated event with the cause per stage", async () => {
    const logger = new Logger({ sessionId: "s3-c3", writeToFile: false });
    const seen: TurnTelemetry[] = [];
    const deps = makeDeps(logger, seen, { providerBackedFallbacks: true, renderability: false });

    await runTurn(makeTinyWorld(), deps);

    const delegated = logger.store.byEvent("cascade_delegated");
    expect(delegated).toHaveLength(2);
    const stages = delegated.map((e) => (e.input as { stage: string }).stage).sort();
    expect(stages).toEqual(["proposal", "selection"]);
    for (const e of delegated) {
      const output = e.output as { cause: string; providerBacked: boolean };
      expect(output.cause).toContain("laya");
      expect(output.providerBacked).toBe(true);
    }
  });

  it("counts nothing when the fallback is local (zero-LLM stack stays zero)", async () => {
    const logger = new Logger({ sessionId: "s3-c2-local", writeToFile: false });
    const seen: TurnTelemetry[] = [];
    const deps = makeDeps(logger, seen, { providerBackedFallbacks: false, renderability: false });

    await runTurn(makeTinyWorld(), deps);

    // The Phase-5 zero-call proof still holds with deterministic fallbacks.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.calls.proposal).toBe(0);
    expect(seen[0]!.calls.selection).toBe(0);
    // ...but the delegation is still observable.
    const delegated = logger.store.byEvent("cascade_delegated");
    expect(delegated).toHaveLength(2);
    for (const e of delegated) {
      expect((e.output as { providerBacked: boolean }).providerBacked).toBe(false);
    }
  });
});

describe("Stage 3 C4: renderability re-pick does not double provider spend", () => {
  it("goes deterministic when the first selection already delegated to a provider fallback", async () => {
    const logger = new Logger({ sessionId: "s3-c4", writeToFile: false });
    const seen: TurnTelemetry[] = [];
    const selectionFallback = new CountingSelectionFallback(logger, {}, { providerBacked: true });
    const deps = makeDeps(logger, seen, {
      providerBackedFallbacks: true,
      renderability: true,
      renderabilityScore: 1, // level 2 -> rescored -> re-pick
      selectionFallback,
    });

    const world = await runTurn(makeTinyWorld(), deps);

    // The re-pick must NOT invoke the (delegating) selection engine again.
    expect(selectionFallback.calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.calls.selection).toBe(1);
    const substituted = logger.store.byEvent("selection_substituted");
    expect(substituted.length).toBeGreaterThanOrEqual(1);
    const repick = substituted[substituted.length - 1]!;
    expect((repick.input as { deterministic?: boolean }).deterministic).toBe(true);
    expect(world.history.length).toBeGreaterThan(0);
  });

  it("still re-runs the engine when nothing delegated (healthy/LLM paths unchanged)", async () => {
    const logger = new Logger({ sessionId: "s3-c4-healthy", writeToFile: false });
    const seen: TurnTelemetry[] = [];
    // Plain provider-backed selection engine: no wrapper, no delegation.
    const selectionEngine = new MockSelectionEngine(logger, {}, { providerBacked: true });
    (selectionEngine as unknown as { calls?: number }).calls = 0;
    const deps: EngineDependencies = {
      proposalEngine: new MockProposalEngine(logger, {}, { providerBacked: true }),
      selectionEngine,
      consequenceEngine: new MockConsequenceEngine(logger),
      logger,
      config: { ...defaultConfig, autosaveEnabled: false },
      forceAllNpc: true,
      onTurnTelemetry: (t: TurnTelemetry) => {
        seen.push(t);
      },
      laya: {
        client: scoreClient(1),
        config: {
          url: "http://stub",
          mode: "static",
          confidenceThreshold: 0.55,
          timeoutMs: 5000,
          maxOptions: 12,
          toggles: layaToggles(true),
        },
        salienceThreshold: 3,
        plausibility: false,
      },
    };

    await runTurn(makeTinyWorld(), deps);

    // Unchanged behavior: the engine re-pick runs (second provider call).
    expect(seen).toHaveLength(1);
    expect(seen[0]!.calls.selection).toBe(2);
    const substituted = logger.store.byEvent("selection_substituted");
    const repick = substituted[substituted.length - 1]!;
    expect((repick.input as { deterministic?: boolean }).deterministic).toBe(false);
  });
});
