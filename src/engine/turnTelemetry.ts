// Phase 6: per-turn provider-call counting (orchestration half).
//
// The pure types, budget predicate, and report formatting live in
// src/core/telemetry.ts. This module holds the tiny mutable counter the
// turn orchestrator threads through the engine call sites. One
// invocation of a provider-backed engine counts as one provider call —
// the honest, engine-agnostic approximation of turn cost (the engines'
// own usage logs carry per-call token detail; the budget tracks turn
// shape, which is what blew up in exp-7).
//
// Only engines that declare `providerBacked === true` are counted: the
// Laya cascade, deterministic stubs, and (by default) mocks are local and
// cost nothing. Telemetry only — never aborts or alters a turn.

import type { TurnCallBreakdown } from "../core/telemetry.js";

export type ProviderCallStage = "proposal" | "selection" | "render";

/** Anything with the Phase-6 opt-in marker (see src/intelligence/types.ts). */
export type ProviderBacked = { providerBacked?: boolean };

/**
 * Counts provider-backed engine invocations for one turn. Create fresh
 * per turn in runTurn; pass into resolveRender via its opts.
 */
export class ProviderCallCounter {
  private readonly counts: Record<ProviderCallStage, number> = {
    proposal: 0,
    selection: 0,
    render: 0,
  };

  /**
   * Record one engine invocation. No-op unless the engine declares
   * itself provider-backed — local engines never touch the budget.
   */
  note(stage: ProviderCallStage, engine: ProviderBacked | undefined): void {
    if (engine?.providerBacked === true) {
      this.counts[stage] += 1;
    }
  }

  breakdown(): TurnCallBreakdown {
    return { ...this.counts };
  }

  total(): number {
    return this.counts.proposal + this.counts.selection + this.counts.render;
  }
}
