import type { EngineConfig } from "./types.js";

export const defaultConfig: EngineConfig = {
  maxMemoriesPerActor: 50,
  maxHistoryEntries: 200,
  defaultPerceptionRadius: 12,
  maxRetries: 3,
  logDir: "logs",
  saveDir: "saves",
  autosaveEnabled: true,
  proposalHistoryLimit: 20,
  maxProposalSuggestions: 10,
  // Phase 5 (longevity: compounding memory + context budget). Prompt-side
  // rendering summarizes instead of trimming, so per-turn tokens stay flat
  // while the stored world keeps full detail up to the caps above.
  /** Stored-world cap for beliefs/relationships per actor (memories use maxMemoriesPerActor). */
  maxBeliefsPerActor: 30,
  maxRelationshipsPerActor: 30,
  /** Newest memory/belief/relationship entries rendered verbatim in prompts; older ones fold into a one-line digest. */
  memorySummaryKeepNewest: 8,
  /** Char budget per memories/beliefs/relationships prompt section (older entries summarized, never dropped silently). */
  promptListBudgetChars: 1200,
  /** Char budget for the recent-history block in prompts (head-truncated with a note). */
  promptHistoryBudgetChars: 2000,
  /** History entries scanned for unanswered questions (persist until the addressee responds). */
  openQuestionScanWindow: 60,
  /** Radius around the acting actor for the slim consequence snapshot (nearby actors/objects + named targets). */
  consequenceSnapshotRadius: 12,
  /**
   * Exp-5 item 6 (NPC liveness floor): an actor that falls back this many
   * consecutive own turns gets a deterministic minimal applied turn
   * (thoughts-only reaction) instead of another "Nothing changes.", so
   * dialogue threads can advance by words even when bodies cannot.
   */
  livenessFallbackThreshold: 3,
  /**
   * Exp-6 item 3: wall-clock budget for one turn's consequence phase.
   * A turn burned 47 minutes in Exp-6 with no circuit breaker.
   */
  turnTimeoutMs: 600_000,
};

export function resolveConfig(partial: Partial<EngineConfig> = {}): EngineConfig {
  return { ...defaultConfig, ...partial };
}
