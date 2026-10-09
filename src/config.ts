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
// entry point below wraps it with Phase-5 defaults: the cascade is the
// default decision path (the chat path is one LAYA_MODE=off away).
// Direction is one-way: config -> decision/wiring, never the reverse.
// ---------------------------------------------------------------------------

/**
 * Laya config as the engine consumes it.
 *
 * Phase 5: the Laya decision cascade is the DEFAULT proposal/selection
 * path — LAYA_MODE defaults to "static" and the decision toggles
 * (selection, renderability screen, locomotion veto) default on. The LLM
 * proposal/selection engines stay available as the fallback (see
 * readLlmDecisionFallback). Explicit env values win; LAYA_MODE=off
 * restores the pure chat path.
 *
 * Pure — pass a fake env in tests.
 */
export function readLayaRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): LayaConfig {
  return readLayaConfig({
    ...env,
    LAYA_MODE: env["LAYA_MODE"] ?? "static",
    LAYA_SELECTION: env["LAYA_SELECTION"] ?? "1",
    LAYA_JUDGE: env["LAYA_JUDGE"] ?? "0",
    LAYA_TRIAGE: env["LAYA_TRIAGE"] ?? "0",
    LAYA_SALIENCE: env["LAYA_SALIENCE"] ?? "0",
    LAYA_PLANNER: env["LAYA_PLANNER"] ?? "0",
    // Exp-2-E salvageSelect: machinery deleted in Phase 4 — stays off.
    LAYA_SALVAGE_SELECT: env["LAYA_SALVAGE_SELECT"] ?? "0",
    // Phase 5: validated as part of the default cascade.
    LAYA_LOCOMOTION: env["LAYA_LOCOMOTION"] ?? "1",
    // Phase 5: the renderability screen is part of the default cascade.
    LAYA_RENDERABILITY: env["LAYA_RENDERABILITY"] ?? "1",
  });
}

/**
 * Phase 5: when the Laya cascade fails or is under-confident, fall back
 * to the LLM proposal/selection engines (1, default during transition)
 * or to the deterministic stub engines (0 — zero LLM calls anywhere in
 * the decision path). The fallback stays until the cascade beats the LLM
 * path on the eval harness for 3 consecutive runs. Pure.
 */
export function readLlmDecisionFallback(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseEnvToggle(env["LLM_DECISION_FALLBACK"], true);
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
