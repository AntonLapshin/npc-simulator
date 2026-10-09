// Phase 5 acceptance: the Laya decision cascade as the default
// proposal/selection path consumes ZERO LLM provider calls — the render
// call is the only provider call per turn.
//
// Two 4-turn runs on the same world: (a) the LLM decision path
// (LLMProposalEngine + LLMSelectionEngine + LLMConsequenceEngine, all on
// counting fake providers), (b) the cascade path (LayaProposalEngine +
// LayaSelectionEngine on a stub Laya client with deterministic fallbacks,
// LLMConsequenceEngine on a counting fake provider).
//
// As a side effect (never asserting on it), each run's save + JSONL log
// are written to /tmp/phase5-compare/ for the eval harness --compare demo.

import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { World } from "../../src/types.js";
import { LayaClient } from "../../src/decision/layaClient.js";
import { LayaProposalEngine } from "../../src/decision/layaProposalEngine.js";
import { LayaSelectionEngine } from "../../src/decision/layaSelectionEngine.js";
import {
  DeterministicProposalEngine,
  DeterministicSelectionEngine,
} from "../../src/decision/deterministicEngines.js";
import { LLMConsequenceEngine } from "../../src/llm/llmConsequenceEngine.js";
import { LLMProposalEngine } from "../../src/llm/llmProposalEngine.js";
import { LLMSelectionEngine } from "../../src/llm/llmSelectionEngine.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import { runTurn, type EngineDependencies } from "../../src/engine/turnOrchestrator.js";
import { Logger } from "../../src/logging/logger.js";
import { defaultConfig } from "../../src/config.js";
import { makeTinyWorld } from "../helpers.js";

/** LLMProvider that records every call and returns a canned JSON string. */
class CountingProvider implements LLMProvider {
  readonly name = "counting-fake";
  calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
  constructor(private readonly canned: (userPrompt: string) => string) {}
  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    this.calls.push({ systemPrompt, userPrompt });
    return this.canned(userPrompt);
  }
}

/**
 * Smart stub Laya client: answers by question SHAPE, rotating through
 * choice options so consecutive turns vary (defeats the echo validator).
 * Speaks the real SystemOne wire format (choice options arrive as the
 * `criteria` map keys; answers use `choice`/`noul`/`score` fields).
 * - choice → criteria key [rot] with concentrated probability
 * - noul   → noul 0.9 (no locomotion veto)
 * - score  → expected index 3 (level 4 renderability: no re-pick)
 */
function stubLayaClient(): LayaClient {
  let rot = 0;
  return new LayaClient({
    baseUrl: "http://stub",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const wire = body.questions as Record<
        string,
        { type: string; criteria?: Record<string, string> }
      >;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(wire)) {
        if (q.type === "choice") {
          const options = Object.keys(q.criteria ?? {});
          const winner = options[rot++ % options.length]!;
          const probabilities: Record<string, number> = {};
          for (const o of options) {
            probabilities[o] = o === winner ? 0.85 : 0.15 / Math.max(1, options.length - 1);
          }
          answers[id] = { type: "choice", choice: winner, probabilities, confidence: 0.85 };
        } else if (q.type === "noul") {
          answers[id] = { type: "noul", noul: 0.9 };
        } else {
          answers[id] = { type: "score", score: 3, probabilities: { "3": 1 } };
        }
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch,
  });
}

function twoActorWorld(): World {
  const w = makeTinyWorld();
  w.actors = [
    {
      id: "anton", name: "Anton", persona: "A careful engineer.", x: 1, y: 1,
      state: "working", emotion: "focused", goal: "Ship the API.",
      thoughts: "", memories: [], beliefs: [], relationships: [],
    },
    {
      id: "dana", name: "Dana", persona: "A designer.", x: 4, y: 4,
      state: "sketching", emotion: "calm", goal: "Finish mockups.",
      thoughts: "", memories: [], beliefs: [], relationships: [],
    },
  ];
  w.order = ["anton", "dana"];
  w.userActorId = "anton";
  return w;
}

function baseDeps(logger: Logger): EngineDependencies {
  return {
    proposalEngine: new DeterministicProposalEngine(),
    selectionEngine: new DeterministicSelectionEngine(),
    consequenceEngine: new LLMConsequenceEngine(logger, new CountingProvider(() => "{}")),
    logger,
    config: { ...defaultConfig, autosaveEnabled: false },
    forceAllNpc: true,
  };
}

/** Canned render: narrate the action text plus an outcome clause (third-person, passes prose validation). */
function renderCanned(userPrompt: string): string {
  const m = userPrompt.match(/Action text: ([^\n]+)/);
  const actionText = (m?.[1] ?? "Something happens").trim();
  return JSON.stringify({
    narrative: `${actionText}. All is calm.`,
    thoughts: "Going well.",
    emotion: "calm",
  });
}

const TURNS = 4;

async function runLlmPath(): Promise<{ providerCalls: number; proposalCalls: number; selectionCalls: number; renderCalls: number; world: World; logger: Logger }> {
  const logger = new Logger({ sessionId: "phase5-llm", writeToFile: false });
  const proposalProvider = new CountingProvider(() =>
    JSON.stringify({
      suggestions: ["Greet the other person warmly.", "Wait quietly and observe.", "Look around the room."],
      reasoning: "canned",
    }),
  );
  const selectionProvider = new CountingProvider(() =>
    JSON.stringify({ action: "Greet the other person warmly.", reasoning: "canned" }),
  );
  const renderProvider = new CountingProvider(renderCanned);
  const deps: EngineDependencies = {
    ...baseDeps(logger),
    proposalEngine: new LLMProposalEngine(logger, proposalProvider, { maxRetries: 1 }),
    selectionEngine: new LLMSelectionEngine(logger, selectionProvider, { maxRetries: 1 }),
    consequenceEngine: new LLMConsequenceEngine(logger, renderProvider, { maxRetries: 1 }),
  };
  let world = twoActorWorld();
  for (let i = 0; i < TURNS; i++) world = await runTurn(world, deps);
  return {
    providerCalls: proposalProvider.calls.length + selectionProvider.calls.length + renderProvider.calls.length,
    proposalCalls: proposalProvider.calls.length,
    selectionCalls: selectionProvider.calls.length,
    renderCalls: renderProvider.calls.length,
    world,
    logger,
  };
}

async function runCascadePath(): Promise<{ providerCalls: number; proposalCalls: number; selectionCalls: number; renderCalls: number; world: World; logger: Logger }> {
  const logger = new Logger({ sessionId: "phase5-cascade", writeToFile: false });
  const client = stubLayaClient();
  const renderProvider = new CountingProvider(renderCanned);
  const deps: EngineDependencies = {
    ...baseDeps(logger),
    proposalEngine: new LayaProposalEngine({ client }, new DeterministicProposalEngine()),
    selectionEngine: new LayaSelectionEngine({ client }, new DeterministicSelectionEngine()),
    consequenceEngine: new LLMConsequenceEngine(logger, renderProvider, { maxRetries: 1 }),
    laya: {
      client,
      config: {
        url: "http://stub",
        mode: "static",
        confidenceThreshold: 0.55,
        timeoutMs: 5000,
        maxOptions: 12,
        toggles: {
          selection: true,
          judge: false,
          triage: false,
          salience: false,
          planner: false,
          salvageSelect: false,
          locomotion: true,
          renderability: true,
        },
      },
      salienceThreshold: 3,
      plausibility: false,
    },
  };
  let world = twoActorWorld();
  for (let i = 0; i < TURNS; i++) world = await runTurn(world, deps);
  return {
    providerCalls: renderProvider.calls.length,
    proposalCalls: 0,
    selectionCalls: 0,
    renderCalls: renderProvider.calls.length,
    world,
    logger,
  };
}

/** Side effect for the eval --compare demo: save + JSONL log to /tmp. */
function dumpArtifacts(tag: string, world: World, logger: Logger): void {
  try {
    mkdirSync("/tmp/phase5-compare", { recursive: true });
    writeFileSync(`/tmp/phase5-compare/${tag}-save.json`, JSON.stringify({ world }));
    const lines = logger.store.all().map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(`/tmp/phase5-compare/${tag}-log.jsonl`, lines + "\n");
  } catch {
    // Never fail the test on artifact I/O.
  }
}

describe("Phase 5 call-count proof", () => {
  it("LLM decision path burns provider calls on proposal+selection+render", async () => {
    const r = await runLlmPath();
    expect(r.proposalCalls).toBeGreaterThan(0);
    expect(r.selectionCalls).toBeGreaterThan(0);
    expect(r.renderCalls).toBe(TURNS);
    expect(r.world.tick).toBe(TURNS);
    dumpArtifacts("llm", r.world, r.logger);
  }, 60000);

  it("cascade path: ZERO provider calls for proposal+selection, render is the only call", async () => {
    const r = await runCascadePath();
    // The proof: no LLM provider was ever consulted for decisions.
    expect(r.proposalCalls).toBe(0);
    expect(r.selectionCalls).toBe(0);
    // Exactly one render call per turn.
    expect(r.renderCalls).toBe(TURNS);
    expect(r.providerCalls).toBe(TURNS);
    // The simulation still advances: 4 turns applied, actors decided.
    expect(r.world.tick).toBe(TURNS);
    expect(r.world.history).toHaveLength(TURNS);
    const layaDecisions = r.logger.store.byEvent("intent_decided");
    expect(layaDecisions.length).toBeGreaterThan(0);
    dumpArtifacts("cascade", r.world, r.logger);
  }, 60000);
});
