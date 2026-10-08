import type { EngineConfig } from "./types.js";
import {
  readLayaConfig,
  type LayaConfig,
  type LayaMode,
  type LayaToggles,
} from "./decision/wiring.js";

export type { LayaConfig, LayaMode, LayaToggles };

export const defaultConfig: EngineConfig = {
  maxMemoriesPerActor: 50,
  maxHistoryEntries: 200,
  defaultPerceptionRadius: 12,
  maxRetries: 3,
  // Exp-7: outer consequence attempts per turn, capped at 2 (see
  // EngineConfig.consequenceMaxAttempts) — retries demonstrably don't
  // steer the model, they just burn 60-120 s each.
  consequenceMaxAttempts: 2,
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
   * Exp-3 item 6 (S2): consecutive own-turn fallbacks of the same intent
   * key before that intent is banned from selection. Default 2.
   */
  intentFailureBanThreshold: 2,
  /**
   * Exp-6 item 3: wall-clock budget for one turn's consequence phase.
   * A turn burned 47 minutes in Exp-6 with no circuit breaker.
   */
  turnTimeoutMs: 600_000,
};

export function resolveConfig(partial: Partial<EngineConfig> = {}): EngineConfig {
  return { ...defaultConfig, ...partial };
}

// ---------------------------------------------------------------------------
// Laya decision-layer configuration (LAYA_PLAN.md phases 3–5).
//
// decision/wiring's readLayaConfig is the single parser; the engine-facing
// entry point below wraps it with OFF-by-default values so the chat path
// stays the default until Phase 5 validates Laya end to end. Direction is
// one-way: config -> decision/wiring, never the reverse.
// ---------------------------------------------------------------------------

/**
 * Laya config as the engine consumes it: LAYA_MODE defaults to "off" and
 * every per-phase toggle defaults to 0 (disabled). Explicit env values win.
 * Pure — pass a fake env in tests.
 */
export function readLayaRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): LayaConfig {
  return readLayaConfig({
    ...env,
    LAYA_MODE: env["LAYA_MODE"] ?? "off",
    LAYA_SELECTION: env["LAYA_SELECTION"] ?? "0",
    LAYA_JUDGE: env["LAYA_JUDGE"] ?? "0",
    LAYA_TRIAGE: env["LAYA_TRIAGE"] ?? "0",
    LAYA_SALIENCE: env["LAYA_SALIENCE"] ?? "0",
    LAYA_PLANNER: env["LAYA_PLANNER"] ?? "0",
    // Exp-2-E additions: OFF by default until Phase 5 validates them.
    LAYA_SALVAGE_SELECT: env["LAYA_SALVAGE_SELECT"] ?? "0",
    LAYA_LOCOMOTION: env["LAYA_LOCOMOTION"] ?? "0",
    // Exp-3 item 6 (S2): OFF by default until Phase 5 validates it.
    LAYA_RENDERABILITY: env["LAYA_RENDERABILITY"] ?? "0",
  });
}

/** True when the intent-first ordering applies: Laya on + selection routing on. */
export function isLayaIntentFirst(config: LayaConfig): boolean {
  return config.mode !== "off" && config.toggles.selection;
}

function parsePositiveNumber(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

function parseEnvToggle(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

/**
 * Salience gate (Phase 3): model-emitted memoriesAppend/beliefsAppend apply
 * only when the turn's salience score (1–5) reaches this threshold.
 * Default 3, clamped to 1–5. Pure.
 */
export function readLayaSalienceThreshold(
  env: Record<string, string | undefined> = process.env,
): number {
  return Math.min(5, Math.max(1, Math.round(parsePositiveNumber(env["LAYA_SALIENCE_THRESHOLD"], 3))));
}

/**
 * Patch-plausibility advisory (Phase 4): when 1, each object/position patch
 * gets a 1–5 Laya plausibility score and scores ≤2 append an advisory note
 * to retry feedback. Advisory only — never blocks or invalidates. Default 0.
 * Pure.
 */
export function readLayaPlausibility(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseEnvToggle(env["LAYA_PLAUSIBILITY"], false);
}
