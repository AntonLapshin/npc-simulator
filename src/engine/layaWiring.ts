// PLAN_V2 Phase 6: slim Laya wiring for the v2 turn loop.
//
// The old src/engine/layaTurn.ts (intent cascade + renderability screen)
// is deleted. What remains is everything a v2 turn needs from Laya:
// the client and the runtime config — for the semantic parser
// (parseActionSemantics, fail-open) and the locomotion veto (a genuine
// physics guard on planned moves).

import { LayaClient } from "../decision/layaClient.js";
import { createLayaClient, readLayaConfig, type LayaConfig } from "../decision/wiring.js";

/** Everything a v2 turn needs to talk to Laya. */
export type LayaWiring = {
  client: LayaClient;
  config: LayaConfig;
};

export type LayaWiringEnvOptions = {
  /** Test/embedding seam: use this wiring instead of reading env. */
  injected?: LayaWiring;
  env?: Record<string, string | undefined>;
};

/**
 * Thin shell: resolve the turn's Laya wiring. Returns undefined when Laya
 * is off (LAYA_MODE=off) so callers keep the deterministic path.
 */
export function layaWiringFromEnv(
  opts: LayaWiringEnvOptions = {},
): LayaWiring | undefined {
  if (opts.injected !== undefined) return opts.injected;
  const config = readLayaConfig(opts.env ?? process.env);
  if (config.mode === "off") return undefined;
  return {
    client: createLayaClient(config),
    config,
  };
}

/** Re-export for callers that only need the predicate-free wiring type. */
export type { LayaConfig };
