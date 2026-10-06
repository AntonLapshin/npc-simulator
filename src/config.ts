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
};

export function resolveConfig(partial: Partial<EngineConfig> = {}): EngineConfig {
  return { ...defaultConfig, ...partial };
}
