// PLAN_V2 Phase 6 (measure): the scripted-provider cost proxy.
//
// No GPU here, so no live 14B run. This test measures the v2 turn's
// scripted cost directly: with provider-backed stub engines and a
// counting Laya client, a clean NPC turn must cost exactly
// 2 LLM calls (intent + narrate) + 1 Laya decide (the batched parse).
import { describe, expect, it } from "vitest";
import { runTurn } from "../../src/engine/turnOrchestrator.js";
import { Logger } from "../../src/logging/logger.js";
import { LayaClient } from "../../src/decision/layaClient.js";
import { readLayaConfig } from "../../src/decision/wiring.js";
import type { LayaAnswer } from "../../src/decision/decisionTypes.js";
import { MockIntentEngine } from "../../src/mocks/mockIntentEngine.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import { makeTestDeps, makeTinyWorld } from "../helpers.js";

function countingLayaClient(): { client: LayaClient; decideCalls: () => number } {
  const client = new LayaClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 1000 });
  let calls = 0;
  client.decide = async (): Promise<Record<string, LayaAnswer>> => {
    calls++;
    // "Wave." — no movement, no speech, no addressee/destination/contact.
    return {
      q_moves: { type: "noul", pTrue: 0.0 },
      q_speaks: { type: "noul", pTrue: 0.0 },
      q_addressee: { type: "choice", winner: "nobody in particular", probabilities: {}, confidence: 1 },
      q_destination: { type: "choice", winner: "stays put / nowhere", probabilities: {}, confidence: 1 },
      q_contact: { type: "choice", winner: "no physical contact", probabilities: {}, confidence: 1 },
    };
  };
  return { client, decideCalls: () => calls };
}

describe("v2 turn cost (scripted proxy)", () => {
  it("a clean NPC turn costs exactly 2 LLM calls + 1 Laya decide", async () => {
    const logger = new Logger({ sessionId: "v2-cost", writeToFile: false });
    const { client, decideCalls } = countingLayaClient();
    const deps = makeTestDeps(logger, {
      // providerBacked: true — these stubs stand in for real provider
      // calls, so the turn's ProviderCallCounter counts them.
      intentEngine: new MockIntentEngine(
        logger,
        { n: { action: "Wave.", quote: "" } },
        { providerBacked: true },
      ),
      consequenceEngine: new MockConsequenceEngine(
        logger,
        { "wave.": { narrative: "N waves.", thoughts: "Calm.", reasoning: "r" } },
        { providerBacked: true },
      ),
      laya: { client, config: readLayaConfig({}) },
    });
    const world = makeTinyWorld();
    world.turnIndex = 1; // n's turn (u is the user actor)

    await runTurn(world, deps);

    // The two LLM legs each fired exactly once…
    expect(logger.store.byEvent("intent_started")).toHaveLength(1);
    expect(logger.store.byEvent("intent_completed")).toHaveLength(1);
    expect(logger.store.byEvent("consequence_started")).toHaveLength(1);
    expect(logger.store.byEvent("consequence_completed")).toHaveLength(1);
    // …the Laya parse fired exactly once (one batched decide)…
    expect(decideCalls()).toBe(1);
    expect(logger.store.byEvent("parser_completed")).toHaveLength(1);
    expect(logger.store.byEvent("parser_fallback")).toHaveLength(0);
    // …and the turn telemetry agrees: intent occupies the proposal slot,
    // narrate the render slot, nothing in selection.
    const telemetry = logger.store.byEvent("turn_telemetry")[0]!.output as {
      calls: { proposal: number; selection: number; render: number };
    };
    expect(telemetry.calls).toMatchObject({ proposal: 1, selection: 0, render: 1 });
    // Clean path: no retries, no fallbacks, no liveness.
    expect(logger.store.byEvent("render_failed")).toHaveLength(0);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    expect(logger.store.byEvent("liveness_applied")).toHaveLength(0);
  });

  it("a user turn costs exactly 1 LLM call + 1 Laya decide (intent skipped)", async () => {
    const logger = new Logger({ sessionId: "v2-cost-user", writeToFile: false });
    const { client, decideCalls } = countingLayaClient();
    const deps = makeTestDeps(logger, {
      intentEngine: new MockIntentEngine(logger, {}, { providerBacked: true }),
      consequenceEngine: new MockConsequenceEngine(
        logger,
        { "wave.": { narrative: "U waves.", thoughts: "Calm.", reasoning: "r" } },
        { providerBacked: true },
      ),
      laya: { client, config: readLayaConfig({}) },
      getUserAction: async () => "Wave.",
    });

    await runTurn(makeTinyWorld(), deps); // u's turn (the user actor)

    expect(logger.store.byEvent("intent_started")).toHaveLength(0);
    expect(logger.store.byEvent("consequence_completed")).toHaveLength(1);
    expect(decideCalls()).toBe(1);
    const telemetry = logger.store.byEvent("turn_telemetry")[0]!.output as {
      calls: { proposal: number; selection: number; render: number };
    };
    expect(telemetry.calls).toMatchObject({ proposal: 0, selection: 0, render: 1 });
  });
});
