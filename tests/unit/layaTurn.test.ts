// Laya turn wiring tests (LAYA_PLAN.md phases 3–4): pure intent derivation,
// triage/salience/plausibility utils, diagram fallback, and the proposal
// prompt narrowing. LayaClient calls go through a stub fetch — no network.
import { describe, expect, it } from "vitest";
import type { LayaAnswer } from "../../src/decision/decisionTypes.js";
import { SELECTION_CASCADE } from "../../src/decision/diagrams.js";
import { LayaClient } from "../../src/decision/layaClient.js";
import { createTestLogger } from "../../src/logging/logger.js";
import {
  buildNarrowedProposalPrompt,
  intentDirective,
  LLMProposalEngine,
} from "../../src/llm/llmProposalEngine.js";
import type { LLMProvider } from "../../src/llm/index.js";
import { createLlmEngines } from "../../src/llm/index.js";
import { LayaSelectionEngine } from "../../src/decision/layaSelectionEngine.js";
import { LLMSelectionEngine } from "../../src/llm/llmSelectionEngine.js";
import {
  isLayaIntentFirst,
  readLayaPlausibility,
  readLayaRuntimeConfig,
  readLayaSalienceThreshold,
} from "../../src/config.js";
import {
  buildPlausibilityQuestions,
  buildTriageQuestions,
  classifyIntentKind,
  describePatchesForPlausibility,
  filterObserverPatches,
  gateMemoryAppendsOnSalience,
  intentFromCascadeDecisions,
  intentFromDiagramRun,
  layaWiringFromEnv,
  parseTriageAnswers,
  plausibilityAdvisoryForRetry,
  plausibilityAdvisoryNote,
  resolveIntentDiagram,
  resolveIntentDiagramDetailed,
  runIntentCascade,
  scoreAnswerToLevel,
  stripModelMemoryAppends,
  triageQuestionId,
  type LayaTurnWiring,
} from "../../src/engine/layaTurn.js";
import { clearDiagramCache } from "../../src/decision/questionPlanner.js";
import type {
  Action,
  ActorPatch,
  ConsequenceResult,
} from "../../src/types.js";
import { makeTinyWorld } from "../helpers.js";

// ---------------------------------------------------------------------------
// Config readers
// ---------------------------------------------------------------------------

describe("readLayaRuntimeConfig", () => {
  it("defaults to off with every toggle disabled", () => {
    const cfg = readLayaRuntimeConfig({});
    expect(cfg.mode).toBe("off");
    expect(cfg.toggles).toEqual({
      selection: false,
      judge: false,
      triage: false,
      salience: false,
      planner: false,
      // Exp-2-E additions: also off by default.
      salvageSelect: false,
      locomotion: false,
    });
    expect(cfg.url).toBe("http://127.0.0.1:8000");
    expect(cfg.confidenceThreshold).toBe(0.55);
    expect(cfg.timeoutMs).toBe(5000);
  });

  it("honors explicit env values", () => {
    const cfg = readLayaRuntimeConfig({
      LAYA_MODE: "dynamic",
      LAYA_SELECTION: "1",
      LAYA_JUDGE: "true",
      LAYA_TRIAGE: "0",
      LAYA_SALIENCE: "yes",
      LAYA_PLANNER: "1",
      LAYA_SALVAGE_SELECT: "1",
      LAYA_LOCOMOTION: "1",
      LAYA_URL: "http://example:9000",
      LAYA_CONFIDENCE_THRESHOLD: "0.7",
    });
    expect(cfg.mode).toBe("dynamic");
    expect(cfg.toggles.selection).toBe(true);
    expect(cfg.toggles.judge).toBe(true);
    expect(cfg.toggles.triage).toBe(false);
    expect(cfg.toggles.salience).toBe(true);
    expect(cfg.toggles.planner).toBe(true);
    expect(cfg.toggles.salvageSelect).toBe(true);
    expect(cfg.toggles.locomotion).toBe(true);
    expect(cfg.url).toBe("http://example:9000");
    expect(cfg.confidenceThreshold).toBe(0.7);
  });

  it("normalizes an unknown mode to static", () => {
    expect(readLayaRuntimeConfig({ LAYA_MODE: "bogus" }).mode).toBe("static");
  });
});

describe("readLayaSalienceThreshold / readLayaPlausibility", () => {
  it("defaults: threshold 3, plausibility off", () => {
    expect(readLayaSalienceThreshold({})).toBe(3);
    expect(readLayaPlausibility({})).toBe(false);
  });

  it("parses and clamps the threshold to 1–5", () => {
    expect(readLayaSalienceThreshold({ LAYA_SALIENCE_THRESHOLD: "4" })).toBe(4);
    expect(readLayaSalienceThreshold({ LAYA_SALIENCE_THRESHOLD: "99" })).toBe(5);
    expect(readLayaSalienceThreshold({ LAYA_SALIENCE_THRESHOLD: "bogus" })).toBe(3);
  });

  it("parses the plausibility toggle", () => {
    expect(readLayaPlausibility({ LAYA_PLAUSIBILITY: "1" })).toBe(true);
    expect(readLayaPlausibility({ LAYA_PLAUSIBILITY: "0" })).toBe(false);
  });
});

describe("isLayaIntentFirst", () => {
  it("requires mode≠off and the selection toggle", () => {
    const base = readLayaRuntimeConfig({});
    expect(isLayaIntentFirst(base)).toBe(false);
    const sel = readLayaRuntimeConfig({ LAYA_MODE: "static", LAYA_SELECTION: "1" });
    expect(isLayaIntentFirst(sel)).toBe(true);
    const noSel = readLayaRuntimeConfig({ LAYA_MODE: "static" });
    expect(isLayaIntentFirst(noSel)).toBe(false);
  });
});

describe("layaWiringFromEnv", () => {
  it("returns undefined when Laya is off (default)", () => {
    expect(layaWiringFromEnv({ env: {} })).toBeUndefined();
  });

  it("builds wiring when the mode is on", () => {
    const wiring = layaWiringFromEnv({ env: { LAYA_MODE: "static" } });
    expect(wiring).toBeDefined();
    expect(wiring!.config.mode).toBe("static");
    expect(wiring!.client).toBeInstanceOf(LayaClient);
    expect(wiring!.salienceThreshold).toBe(3);
    expect(wiring!.plausibility).toBe(false);
  });

  it("prefers injected wiring", () => {
    const injected = layaWiringFromEnv({ env: { LAYA_MODE: "static" } })!;
    expect(layaWiringFromEnv({ injected, env: {} })).toBe(injected);
  });
});

// ---------------------------------------------------------------------------
// Intent derivation
// ---------------------------------------------------------------------------

function choice(winner: string, options: string[] = [winner, "other"]): LayaAnswer {
  const probabilities: Record<string, number> = {};
  for (const o of options) probabilities[o] = o === winner ? 0.9 : 0.1;
  return { type: "choice", winner, probabilities, confidence: 0.9 };
}

describe("intentFromCascadeDecisions", () => {
  it("derives speak + addressee + manner", () => {
    const intent = intentFromCascadeDecisions({
      intent_kind: choice("speak", ["speak", "move", "wait"]),
      addressee: choice("one specific person", ["one specific person", "nobody in particular"]),
      manner: choice("casually", ["casually", "directly and purposefully"]),
    });
    expect(intent).toEqual({ kind: "speak", targetKind: "actor", manner: "casually" });
  });

  it("maps 'nobody in particular' to targetKind none", () => {
    const intent = intentFromCascadeDecisions({
      intent_kind: choice("speak"),
      addressee: choice("nobody in particular", ["one specific person", "nobody in particular"]),
      manner: choice("hesitantly"),
    });
    expect(intent.targetKind).toBe("none");
  });

  it("derives move toward a landmark and interact with manner", () => {
    const move = intentFromCascadeDecisions({
      intent_kind: choice("move"),
      destination: choice("a specific place", ["a specific place", "wander aimlessly"]),
      manner: choice("directly and purposefully"),
    });
    expect(move).toEqual({ kind: "move", targetKind: "landmark", manner: "directly and purposefully" });

    const interact = intentFromCascadeDecisions({
      intent_kind: choice("interact"),
      target_object: choice("examine", ["use", "examine"]),
      manner: choice("casually"),
    });
    expect(interact).toEqual({ kind: "interact", targetKind: "object", manner: "examine" });
  });

  it("falls back to wait on missing or garbage decisions", () => {
    expect(intentFromCascadeDecisions({})).toEqual({ kind: "wait" });
    expect(
      intentFromCascadeDecisions({ intent_kind: choice("dance", ["dance"]) }),
    ).toEqual({ kind: "wait" });
  });
});

describe("classifyIntentKind", () => {
  it("maps free-form text to intent kinds", () => {
    expect(classifyIntentKind("Dana walks over to Anton")).toBe("move");
    expect(classifyIntentKind("She asks about the deadline")).toBe("speak");
    expect(classifyIntentKind("He picks up the coffee mug")).toBe("interact");
    expect(classifyIntentKind("She nods thoughtfully")).toBe("gesture");
    expect(classifyIntentKind("stares out the window")).toBe("wait");
  });
});

describe("intentFromDiagramRun", () => {
  it("uses the cascade reader for static diagrams", () => {
    const intent = intentFromDiagramRun(SELECTION_CASCADE, {
      decisions: {
        intent_kind: choice("gesture"),
        manner: choice("playfully"),
      },
      path: ["intent_kind", "manner"],
    });
    expect(intent).toEqual({ kind: "gesture", manner: "playfully" });
  });

  it("classifies the terminal winner for dynamic diagrams", () => {
    const intent = intentFromDiagramRun(
      { nodes: [], edges: [], terminal: "q2" },
      { decisions: { q2: choice("walk to the whiteboard") }, path: ["q1", "q2"] },
    );
    expect(intent).toEqual({ kind: "move" });
  });
});

// ---------------------------------------------------------------------------
// Observer triage
// ---------------------------------------------------------------------------

describe("triage questions/answers", () => {
  it("builds one noul per observer keyed by actor id", () => {
    const qs = buildTriageQuestions([
      { id: "dana", name: "Dana" },
      { id: "anton", name: "Anton" },
    ]);
    expect(Object.keys(qs).sort()).toEqual(["triage_anton", "triage_dana"]);
    expect(qs[triageQuestionId("dana")]!.type).toBe("noul");
    expect(qs[triageQuestionId("dana")]!.instructions).toContain("Dana");
  });

  it("parses pTrue >= 0.5 as notable; missing answers are not notable", () => {
    const notable = parseTriageAnswers(
      {
        triage_dana: { type: "noul", pTrue: 0.8 },
        triage_anton: { type: "noul", pTrue: 0.2 },
      },
      ["dana", "anton", "ghost"],
    );
    expect(notable).toEqual({ dana: true, anton: false, ghost: false });
  });
});

describe("filterObserverPatches", () => {
  const patches: ActorPatch[] = [
    { actorId: "dana", thoughts: "Wow.", emotion: "surprised", x: 1, y: 2 },
    { actorId: "tanya", thoughts: "Meh." },
    { actorId: "anton", thoughts: "Hmm." },
  ];

  it("drops thoughts/emotion for triaged-out observers only", () => {
    const out = filterObserverPatches(patches, { dana: true, tanya: false, anton: false }, undefined);
    expect(out[0]).toEqual(patches[0]); // notable: untouched
    expect(out[1]).toEqual({ actorId: "tanya" }); // thoughts dropped
    expect(out[2]).toEqual({ actorId: "anton" });
  });

  it("always keeps patches for the directly-addressed observer", () => {
    const out = filterObserverPatches(patches, { dana: false, tanya: false, anton: false }, "anton");
    expect(out[2]).toEqual(patches[2]);
    expect(out[0]).toEqual({ actorId: "dana", x: 1, y: 2 }); // position kept, thoughts dropped
  });
});

// ---------------------------------------------------------------------------
// Salience
// ---------------------------------------------------------------------------

describe("scoreAnswerToLevel", () => {
  it("maps a 0-based expected index to a 1-based level", () => {
    expect(
      scoreAnswerToLevel({ type: "score", expected: 3.6, distribution: {} }, 5),
    ).toBe(5);
    expect(
      scoreAnswerToLevel({ type: "score", expected: 0.2, distribution: {} }, 5),
    ).toBe(1);
  });

  it("returns undefined for missing or non-score answers", () => {
    expect(scoreAnswerToLevel(undefined)).toBeUndefined();
    expect(scoreAnswerToLevel({ type: "noul", pTrue: 0.9 })).toBeUndefined();
  });
});

describe("stripModelMemoryAppends", () => {
  const result: ConsequenceResult = {
    narrative: "Dana waves.",
    actorPatches: [
      { actorId: "dana", memoriesAppend: ["Dana waved."], beliefsAppend: ["Waving is nice."] },
      { actorId: "anton", relationshipsAppend: ["trusts Dana"] },
    ],
    objectPatches: [],
    reasoning: "r",
  };

  it("drops memoriesAppend/beliefsAppend but keeps other appends", () => {
    const out = stripModelMemoryAppends(result);
    expect(out.actorPatches[0]).toEqual({ actorId: "dana" });
    expect(out.actorPatches[1]).toEqual({ actorId: "anton", relationshipsAppend: ["trusts Dana"] });
    // input untouched
    expect(result.actorPatches[0]!.memoriesAppend).toHaveLength(1);
  });

  it("returns the input unchanged when there is nothing to strip", () => {
    const clean: ConsequenceResult = { ...result, actorPatches: [{ actorId: "dana" }] };
    expect(stripModelMemoryAppends(clean)).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// Plausibility
// ---------------------------------------------------------------------------

describe("plausibility utils", () => {
  const result: ConsequenceResult = {
    narrative: "Dana teleports.",
    actorPatches: [{ actorId: "dana", x: 99, y: 99 }],
    objectPatches: [{ objectId: "mug", description: "now golden" }],
    reasoning: "r",
  };

  it("labels actor position and object patches", () => {
    expect(describePatchesForPlausibility(result)).toEqual([
      'actor "dana" moves to (99, 99)',
      'object "mug" description changes',
    ]);
    expect(describePatchesForPlausibility({
      narrative: "x", actorPatches: [{ actorId: "a", thoughts: "t" }],
      objectPatches: [], reasoning: "r",
    })).toEqual([]);
  });

  it("builds one score question per label", () => {
    const qs = buildPlausibilityQuestions(["a", "b"]);
    expect(Object.keys(qs)).toEqual(["plaus_0", "plaus_1"]);
    expect(qs["plaus_0"]!.type).toBe("score");
  });

  it("emits an advisory note only for scores ≤2", () => {
    expect(
      plausibilityAdvisoryNote([
        { label: "actor \"dana\" moves to (99, 99)", level: 2 },
        { label: "object \"mug\" description changes", level: 4 },
      ]),
    ).toContain("plausibility 2/5");
    expect(
      plausibilityAdvisoryNote([{ label: "x", level: 3 }]),
    ).toBeUndefined();
    expect(plausibilityAdvisoryNote([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Diagram resolution (dynamic planner fallback)
// ---------------------------------------------------------------------------

const VALID_DIAGRAM_JSON = JSON.stringify({
  nodes: [
    { id: "q1", type: "choice", instructions: "What does Dana do?", options: ["speak", "wait"] },
    { id: "q2", type: "noul", instructions: "Is it urgent?" },
  ],
  edges: [{ from: "q1", to: "q2" }],
  terminal: "q2",
});

describe("resolveIntentDiagram", () => {
  it("uses the static cascade in static mode", async () => {
    const d = await resolveIntentDiagram({
      mode: "static", plannerEnabled: true, goal: "g", state: "s",
      chatComplete: async () => VALID_DIAGRAM_JSON,
    });
    expect(d).toBe(SELECTION_CASCADE);
  });

  it("falls back to the static diagram on ANY planner failure", async () => {
    const throwing = async () => { throw new Error("planner down"); };
    const d = await resolveIntentDiagram({
      mode: "dynamic", plannerEnabled: true, goal: "g", state: "s", chatComplete: throwing,
    });
    expect(d).toBe(SELECTION_CASCADE);

    const invalid = async () => "not json at all";
    const d2 = await resolveIntentDiagram({
      mode: "dynamic", plannerEnabled: true, goal: "g", state: "s", chatComplete: invalid,
    });
    expect(d2).toBe(SELECTION_CASCADE);
  });

  it("uses the planned diagram when the planner succeeds", async () => {
    const d = await resolveIntentDiagram({
      mode: "dynamic", plannerEnabled: true, goal: "g", state: "s",
      chatComplete: async () => VALID_DIAGRAM_JSON,
    });
    expect(d).not.toBe(SELECTION_CASCADE);
    expect(d.terminal).toBe("q2");
  });

  it("ignores the planner when the toggle is off or no hook is wired", async () => {
    const d = await resolveIntentDiagram({
      mode: "dynamic", plannerEnabled: false, goal: "g", state: "s",
      chatComplete: async () => VALID_DIAGRAM_JSON,
    });
    expect(d).toBe(SELECTION_CASCADE);
    const d2 = await resolveIntentDiagram({ mode: "dynamic", plannerEnabled: true, goal: "g", state: "s" });
    expect(d2).toBe(SELECTION_CASCADE);
  });
});

// ---------------------------------------------------------------------------
// runIntentCascade with a stub Laya server
// ---------------------------------------------------------------------------

/** Stub fetch answering each question id with a seeded winner (choice) / pTrue (noul). */
function stubLayaFetch(winners: Record<string, string>, noulTrue = true) {
  return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, { type: string; criteria?: Record<string, string> }>;
    };
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === "choice") {
        const options = Object.keys(q.criteria ?? {});
        const winner = winners[id] ?? options[0]!;
        const probabilities: Record<string, number> = {};
        for (const o of options) probabilities[o] = o === winner ? 0.95 : 0.05 / Math.max(1, options.length - 1);
        answers[id] = { choice: winner, probabilities, confidence: 0.95 };
      } else if (q.type === "noul") {
        answers[id] = { noul: noulTrue ? 0.9 : 0.1 };
      } else {
        answers[id] = { score: 3 };
      }
    }
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };
}

function stubClient(winners: Record<string, string>): LayaClient {
  return new LayaClient({
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl: stubLayaFetch(winners) as typeof fetch,
  });
}

describe("runIntentCascade", () => {
  it("runs the static cascade and derives the intent", async () => {
    const world = makeTinyWorld();
    const actorId = world.order[0]!;
    const intent = await runIntentCascade(
      stubClient({
        intent_kind: "speak",
        addressee: "one specific person",
        manner: "casually",
      }),
      world,
      actorId,
      { mode: "static", plannerEnabled: false, goal: "decide intent" },
      createTestLogger(),
    );
    expect(intent).toEqual({ kind: "speak", targetKind: "actor", manner: "casually" });
  });

  it("fails open to undefined when Laya is down", async () => {
    const world = makeTinyWorld();
    const client = new LayaClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch,
    });
    const intent = await runIntentCascade(
      client, world, world.order[0]!,
      { mode: "static", plannerEnabled: false, goal: "decide intent" },
    );
    expect(intent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Proposal prompt narrowing
// ---------------------------------------------------------------------------

describe("intentDirective / buildNarrowedProposalPrompt", () => {
  it("narrates each intent kind", () => {
    expect(intentDirective({ kind: "speak", targetKind: "actor", manner: "casually" }))
      .toContain("SAY to one specific person present (casually)");
    expect(intentDirective({ kind: "move", targetKind: "landmark" }))
      .toContain("MOVE toward a specific place");
    expect(intentDirective({ kind: "interact", targetKind: "object", manner: "use" }))
      .toContain("USE a nearby object (use)");
    expect(intentDirective({ kind: "gesture" })).toContain("gesture");
    expect(intentDirective({ kind: "wait" })).toContain("waiting");
  });

  it("prepends the decided-intent header and keeps the base prompt", () => {
    const out = buildNarrowedProposalPrompt({ kind: "speak" }, "BASE PROMPT");
    expect(out).toContain("DECIDED INTENT");
    expect(out.endsWith("BASE PROMPT")).toBe(true);
  });
});

class StubProvider implements LLMProvider {
  readonly name = "stub";
  calls: Array<{ system: string; user: string }> = [];
  constructor(private readonly script: string[]) {}
  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    this.calls.push({ system: systemPrompt, user: userPrompt });
    const next = this.script.shift();
    if (next === undefined) throw new Error("stub provider exhausted");
    return next;
  }
}

const proposalJson = JSON.stringify({
  suggestions: ["Say hello to everyone.", "Wave at Dana."],
  reasoning: "Friendly.",
});

describe("LLMProposalEngine.propose with intent", () => {
  it("narrows the prompt when an intent is passed", async () => {
    const world = makeTinyWorld();
    const provider = new StubProvider([proposalJson]);
    const engine = new LLMProposalEngine(createTestLogger(), provider);
    const actorId = world.order[0]!;
    const result = await engine.propose(world, actorId, { kind: "speak", targetKind: "actor" });
    expect(result.suggestions).toHaveLength(2);
    expect(provider.calls[0]!.user).toContain("DECIDED INTENT");
    expect(provider.calls[0]!.user).toContain("SAY to one specific person present");
  });

  it("keeps the existing prompt when intent is undefined", async () => {
    const world = makeTinyWorld();
    const provider = new StubProvider([proposalJson]);
    const engine = new LLMProposalEngine(createTestLogger(), provider);
    const result = await engine.propose(world, world.order[0]!);
    expect(result.suggestions).toHaveLength(2);
    expect(provider.calls[0]!.user).not.toContain("DECIDED INTENT");
  });
});

// ---------------------------------------------------------------------------
// createLlmEngines Laya sourcing
// ---------------------------------------------------------------------------

describe("createLlmEngines Laya sourcing", () => {
  // Stub providers so no real backend (and no API key) is needed; the Laya
  // flags come from `env` while providers are caller-owned.
  const stubProviders = () => {
    const p = new StubProvider(["{}"]);
    return { proposal: p, selection: p, consequence: p, semantic: p };
  };

  it("wires the Laya selection engine with the chat engine as fallback when enabled", () => {
    const engines = createLlmEngines(createTestLogger(), {
      providers: stubProviders(),
      env: { LAYA_MODE: "static", LAYA_SELECTION: "1", LAYA_JUDGE: "1" },
    });
    const turn = engines.getEnginesForTurn(false);
    expect(turn.selection).toBeInstanceOf(LayaSelectionEngine);
    expect(turn.plannerChatComplete).toBeDefined();
  });

  it("keeps chat engines by default (Laya off)", () => {
    const engines = createLlmEngines(createTestLogger(), {
      providers: stubProviders(),
      env: {},
    });
    const turn = engines.getEnginesForTurn(false);
    expect(turn.selection).toBeInstanceOf(LLMSelectionEngine);
    expect(turn.selection).not.toBeInstanceOf(LayaSelectionEngine);
    expect(turn.plannerChatComplete).toBeUndefined();
  });

  it("leaves the chat selection engine when only the judge toggle is on", () => {
    const engines = createLlmEngines(createTestLogger(), {
      providers: stubProviders(),
      env: { LAYA_MODE: "static", LAYA_JUDGE: "1" },
    });
    expect(engines.getEnginesForTurn(false).selection).toBeInstanceOf(LLMSelectionEngine);
  });
});

// ---------------------------------------------------------------------------
// Exp-2 S6: per-phase Laya observability — one event per phase per turn,
// even on no-op, through module="laya" (the Phase-5 layaEvents histogram
// counts those).
// ---------------------------------------------------------------------------

/** LayaClient stub answering every question id with a fixed score level index. */
function stubScoreClient(score: number): LayaClient {
  return new LayaClient({
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ answers: { salience: { score } } }), {
        status: 200,
      })) as typeof fetch,
  });
}

function stubWiring(client: LayaClient, salienceThreshold = 3): LayaTurnWiring {
  return {
    client,
    config: readLayaRuntimeConfig({ LAYA_MODE: "static", LAYA_SALIENCE: "1" }),
    salienceThreshold,
    plausibility: false,
  };
}

function stubAction(): Action {
  return { actorId: "u", text: "U waves hello." };
}

function stubResult(patches: ActorPatch[] = []): ConsequenceResult {
  return {
    narrative: "U waves hello.",
    actorPatches: patches,
    objectPatches: [],
    reasoning: "test",
  };
}

describe("resolveIntentDiagramDetailed (S6 planner outcome)", () => {
  it("reports static in static mode", async () => {
    const r = await resolveIntentDiagramDetailed({
      mode: "static", plannerEnabled: true, goal: "g", state: "s",
      chatComplete: async () => VALID_DIAGRAM_JSON,
    });
    expect(r.diagram).toBe(SELECTION_CASCADE);
    expect(r.outcome).toBe("static");
    expect(r.reason).toContain("static");
  });

  it("reports skipped when the planner toggle is off or no hook is wired", async () => {
    const r = await resolveIntentDiagramDetailed({
      mode: "dynamic", plannerEnabled: false, goal: "g", state: "s",
      chatComplete: async () => VALID_DIAGRAM_JSON,
    });
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toContain("LAYA_PLANNER=0");
    const r2 = await resolveIntentDiagramDetailed({
      mode: "dynamic", plannerEnabled: true, goal: "g", state: "s",
    });
    expect(r2.outcome).toBe("skipped");
    expect(r2.reason).toContain("no planner chat hook");
  });

  it("reports fallback when the planner throws", async () => {
    clearDiagramCache(); // the ("g","s") key is cached by the resolveIntentDiagram tests above
    const r = await resolveIntentDiagramDetailed({
      mode: "dynamic", plannerEnabled: true, goal: "s6-fallback-goal", state: "s6-fallback-state",
      chatComplete: async () => { throw new Error("planner down"); },
    });
    expect(r.diagram).toBe(SELECTION_CASCADE);
    expect(r.outcome).toBe("fallback");
    expect(r.reason).toContain("planner failed");
  });

  it("reports planned then cache_hit on a repeated goal+state", async () => {
    clearDiagramCache();
    const opts = {
      mode: "dynamic" as const, plannerEnabled: true,
      goal: "s6-unique-goal", state: "s6-unique-state",
      chatComplete: async () => VALID_DIAGRAM_JSON,
    };
    const first = await resolveIntentDiagramDetailed(opts);
    expect(first.outcome).toBe("planned");
    expect(first.diagram).not.toBe(SELECTION_CASCADE);
    const second = await resolveIntentDiagramDetailed(opts);
    expect(second.outcome).toBe("cache_hit");
    expect(second.diagram).toBe(first.diagram);
    clearDiagramCache();
  });
});

describe("runIntentCascade planner observability (S6)", () => {
  it("logs planner_diagram_resolved with module=laya on every cascade run", async () => {
    const logger = createTestLogger();
    const world = makeTinyWorld();
    await runIntentCascade(
      stubClient({ intent_kind: "wait", manner: "casually" }),
      world,
      world.order[0]!,
      { mode: "static", plannerEnabled: false, goal: "decide intent" },
      logger,
    );
    const events = logger.store.byModule("laya");
    const planner = events.find((e) => e.event === "planner_diagram_resolved");
    expect(planner).toBeDefined();
    expect(planner!.output).toMatchObject({ outcome: "static" });
  });
});

describe("gateMemoryAppendsOnSalience observability (S6)", () => {
  it("logs salience_scored with a no-op reason when there is nothing to gate", async () => {
    const logger = createTestLogger();
    const world = makeTinyWorld();
    const out = await gateMemoryAppendsOnSalience(
      stubWiring(stubScoreClient(0)),
      world,
      stubAction(),
      stubResult(),
      logger,
    );
    expect(out.actorPatches).toEqual([]);
    const scored = logger.store.byEvent("salience_scored");
    expect(scored).toHaveLength(1);
    expect(scored[0]!.module).toBe("laya");
    expect(scored[0]!.output).toMatchObject({
      scored: false,
      reason: expect.stringContaining("no model memory/belief appends"),
    });
  });

  it("logs scored=true and gates below the threshold", async () => {
    const logger = createTestLogger();
    const world = makeTinyWorld();
    const patches: ActorPatch[] = [
      { actorId: "u", memoriesAppend: ["met Ana"] },
    ];
    const out = await gateMemoryAppendsOnSalience(
      stubWiring(stubScoreClient(0)), // level 1 < threshold 3
      world,
      stubAction(),
      stubResult(patches),
      logger,
    );
    expect(out.actorPatches[0]!.memoriesAppend).toBeUndefined();
    const scored = logger.store.byEvent("salience_scored");
    expect(scored).toHaveLength(1);
    expect(scored[0]!.output).toMatchObject({
      scored: true, score: 1, threshold: 3, gated: true,
    });
  });

  it("logs scored=true and keeps appends at/above the threshold", async () => {
    const logger = createTestLogger();
    const world = makeTinyWorld();
    const patches: ActorPatch[] = [
      { actorId: "u", memoriesAppend: ["met Ana"] },
    ];
    const out = await gateMemoryAppendsOnSalience(
      stubWiring(stubScoreClient(4)), // level 5 >= threshold 3
      world,
      stubAction(),
      stubResult(patches),
      logger,
    );
    expect(out.actorPatches[0]!.memoriesAppend).toEqual(["met Ana"]);
    expect(logger.store.byEvent("salience_scored")[0]!.output).toMatchObject({
      scored: true, score: 5, gated: false,
    });
  });
});

describe("plausibilityAdvisoryForRetry observability (S6)", () => {
  it("logs plausibility_scored with a no-op reason when there is nothing to score", async () => {
    const logger = createTestLogger();
    const world = makeTinyWorld();
    const note = await plausibilityAdvisoryForRetry(
      stubScoreClient(0),
      stubAction(),
      stubResult(),
      { logger, tick: world.tick, turnIndex: world.turnIndex, attempt: 2 },
    );
    expect(note).toBeUndefined();
    const events = logger.store.byEvent("plausibility_scored");
    expect(events).toHaveLength(1);
    expect(events[0]!.module).toBe("laya");
    expect(events[0]!.input).toMatchObject({ attempt: 2 });
    expect(events[0]!.output).toMatchObject({
      scored: false,
      reason: expect.stringContaining("no object/position patches"),
    });
  });

  it("logs scored=true with the advisory outcome when patches score low", async () => {
    const logger = createTestLogger();
    const world = makeTinyWorld();
    // Plausibility scores per patch label via plaus_<i> ids; answer all low.
    const lowClient = new LayaClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: (async (url: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String((init as { body: string }).body)) as {
          questions: Record<string, unknown>;
        };
        const answers: Record<string, unknown> = {};
        for (const id of Object.keys(body.questions)) answers[id] = { score: 0 };
        return new Response(JSON.stringify({ answers }), { status: 200 });
      }) as typeof fetch,
    });
    const note = await plausibilityAdvisoryForRetry(
      lowClient,
      stubAction(),
      {
        ...stubResult(),
        actorPatches: [{ actorId: "u", x: 99, y: 99 }],
      },
      { logger, tick: world.tick, turnIndex: world.turnIndex },
    );
    expect(note).toContain("plausibility 1/5");
    const events = logger.store.byEvent("plausibility_scored");
    expect(events).toHaveLength(1);
    expect(events[0]!.output).toMatchObject({
      scored: true, patchCount: 1, lowScoreCount: 1, advisoryNote: true,
    });
  });

  it("stays silent without obs (backward compatible)", async () => {
    const logger = createTestLogger();
    const note = await plausibilityAdvisoryForRetry(
      stubScoreClient(0),
      stubAction(),
      stubResult(),
    );
    expect(note).toBeUndefined();
    expect(logger.store.all()).toHaveLength(0);
  });
});
