// Pure config reading + thin factory shells for the Laya decision layer.
// Nothing here touches src/engine, src/llm, or src/config.

import type { SelectionEngine } from "../intelligence/types.js";
import { LayaSelectionEngine } from "./layaSelectionEngine.js";
import { LayaSemanticJudge } from "./layaSemanticJudge.js";
import { LayaClient } from "./layaClient.js";

export type LayaMode = "off" | "static" | "dynamic";

export type LayaToggles = {
  selection: boolean;
  judge: boolean;
  triage: boolean;
  salience: boolean;
  planner: boolean;
};

export type LayaConfig = {
  url: string;
  mode: LayaMode;
  confidenceThreshold: number;
  timeoutMs: number;
  maxOptions: number;
  toggles: LayaToggles;
};

function parseToggle(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

function parseNumber(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/**
 * Read Laya configuration from the environment (pure — pass a fake env in
 * tests). Per LAYA_PLAN.md §5: LAYA_URL, LAYA_MODE, LAYA_CONFIDENCE_THRESHOLD,
 * LAYA_TIMEOUT_MS, LAYA_MAX_OPTIONS, and per-phase toggles.
 */
export function readLayaConfig(env: Record<string, string | undefined> = process.env): LayaConfig {
  const modeRaw = (env["LAYA_MODE"] ?? "static").trim().toLowerCase();
  const mode: LayaMode = modeRaw === "off" || modeRaw === "dynamic" ? modeRaw : "static";
  return {
    url: env["LAYA_URL"] ?? "http://127.0.0.1:8000",
    mode,
    confidenceThreshold: parseNumber(env["LAYA_CONFIDENCE_THRESHOLD"], 0.55),
    timeoutMs: parseNumber(env["LAYA_TIMEOUT_MS"], 5000),
    maxOptions: Math.floor(parseNumber(env["LAYA_MAX_OPTIONS"], 12)),
    toggles: {
      selection: parseToggle(env["LAYA_SELECTION"], true),
      judge: parseToggle(env["LAYA_JUDGE"], true),
      triage: parseToggle(env["LAYA_TRIAGE"], true),
      salience: parseToggle(env["LAYA_SALIENCE"], true),
      planner: parseToggle(env["LAYA_PLANNER"], false),
    },
  };
}

/** Thin shell: build a client from config. */
export function createLayaClient(config: LayaConfig): LayaClient {
  return new LayaClient({ baseUrl: config.url, timeoutMs: config.timeoutMs });
}

/**
 * Probe laya-serve with a trivial noul question. Returns true when the
 * server answers with a sane shape, false on any failure (never throws).
 */
export async function isLayaAvailable(client: LayaClient): Promise<boolean> {
  try {
    const answers = await client.decide("laya availability probe", {
      probe: { type: "noul", instructions: "Is this an availability probe?" },
    });
    const answer = answers["probe"];
    return !!answer && answer.type === "noul";
  } catch {
    return false;
  }
}

export type LayaEngineDeps = {
  client: LayaClient;
  confidenceThreshold?: number;
};

/** Thin shell: Laya selection engine with an injected chat fallback. */
export function createLayaSelectionEngine(
  deps: LayaEngineDeps,
  config: LayaConfig,
  fallback: SelectionEngine,
): LayaSelectionEngine {
  return new LayaSelectionEngine(
    {
      client: deps.client,
      confidenceThreshold: deps.confidenceThreshold ?? config.confidenceThreshold,
    },
    fallback,
  );
}

/** Thin shell: Laya semantic judge (one batched decide per action). */
export function createLayaSemanticJudge(
  deps: LayaEngineDeps,
  _config: LayaConfig,
): LayaSemanticJudge {
  void _config;
  return new LayaSemanticJudge({ client: deps.client });
}
