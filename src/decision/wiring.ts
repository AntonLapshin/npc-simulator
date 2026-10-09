// Pure config reading + thin factory shells for the Laya layer.
// PLAN_V2 Phase 6: the decision cascade (proposal/selection engines,
// intent cascade, static diagrams, renderability screen) is deleted —
// Laya survives only as the semantic parser (one batched decide over the
// action sentence) plus the locomotion veto (a physics guard on planned
// moves). Nothing here touches src/engine, src/llm, or src/config.

import { LayaSemanticJudge } from "./layaSemanticJudge.js";
import { LayaClient } from "./layaClient.js";

export type LayaMode = "off" | "on";

export type LayaToggles = {
  /**
   * Exp-2-E (b): Laya word-sense veto on deterministic moves=true.
   * A genuine physics guard — Laya only ever VETOES a planned move when
   * it is confident the action needs no relocation; failure or low
   * confidence keeps the deterministic verdict. Kept in Phase 6.
   */
  locomotion: boolean;
};

export type LayaConfig = {
  url: string;
  mode: LayaMode;
  timeoutMs: number;
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
 * tests). LAYA_MODE: "off" disables Laya entirely (the parser falls back
 * to deterministic text parsing); anything else (including the legacy
 * "static"/"dynamic" values) enables it. LAYA_URL, LAYA_TIMEOUT_MS, and
 * LAYA_LOCOMOTION (the move veto, default on) complete the surface.
 */
export function readLayaConfig(env: Record<string, string | undefined> = process.env): LayaConfig {
  const modeRaw = (env["LAYA_MODE"] ?? "on").trim().toLowerCase();
  const mode: LayaMode = modeRaw === "off" ? "off" : "on";
  return {
    url: env["LAYA_URL"] ?? "http://127.0.0.1:8000",
    mode,
    timeoutMs: parseNumber(env["LAYA_TIMEOUT_MS"], 5000),
    toggles: {
      locomotion: parseToggle(env["LAYA_LOCOMOTION"], true),
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
};

/** Thin shell: Laya semantic judge (one batched decide per action). */
export function createLayaSemanticJudge(
  deps: LayaEngineDeps,
): LayaSemanticJudge {
  return new LayaSemanticJudge({ client: deps.client });
}
