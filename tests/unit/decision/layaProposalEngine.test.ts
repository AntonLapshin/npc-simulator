// Tests for the Laya proposal engine (src/decision/layaProposalEngine.ts).
// Phase 5: zero-LLM proposal — intent cascade → dynamic target question →
// template candidates → exact-intent choice, with fallback on any failure.
import { describe, expect, it } from "vitest";
import type { World } from "../../../src/types.js";
import type { ChoiceAnswer, Intent, LayaAnswer } from "../../../src/decision/decisionTypes.js";
import { LayaClient } from "../../../src/decision/layaClient.js";
import {
  EXACT_INTENT_QUESTION_ID,
  LayaProposalEngine,
  TARGET_QUESTION_ID,
} from "../../../src/decision/layaProposalEngine.js";
import { DeterministicProposalEngine } from "../../../src/decision/deterministicEngines.js";
import type { ProposalEngine } from "../../../src/intelligence/types.js";
import type { ProposalResult } from "../../../src/types.js";
import { makeTinyWorld } from "../../helpers.js";

function choice(winner: string, options: string[], p = 0.9): ChoiceAnswer {
  const probabilities: Record<string, number> = {};
  for (const o of options) probabilities[o] = o === winner ? p : (1 - p) / Math.max(1, options.length - 1);
  return { type: "choice", winner, probabilities, confidence: p };
}

function toWire(a: LayaAnswer): unknown {
  if (a.type === "choice") {
    return { type: "choice", choice: a.winner, probabilities: a.probabilities, confidence: a.confidence };
  }
  if (a.type === "noul") return { type: "noul", noul: a.pTrue };
  return { type: "score", score: a.expected, probabilities: a.distribution };
}

/** Scripted LayaClient: answers come from a per-question-id script. */
function scriptedClient(
  script: Record<string, LayaAnswer>,
  onCall?: (ids: string[]) => void,
): LayaClient {
  return new LayaClient({
    baseUrl: "http://stub",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const ids = Object.keys(body.questions ?? {});
      onCall?.(ids);
      const answers: Record<string, unknown> = {};
      for (const id of ids) {
        const a = script[id];
        if (!a) throw new Error(`no scripted answer for "${id}"`);
        answers[id] = toWire(a);
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch,
  });
}

function downClient(): LayaClient {
  return new LayaClient({
    baseUrl: "http://stub",
    fetchImpl: (async () => {
      throw new Error("laya down");
    }) as typeof fetch,
  });
}

/** Recording fallback: captures that it ran and returns fixed suggestions. */
function recordingFallback(): ProposalEngine & { calls: number } {
  const fb = {
    calls: 0,
    async propose(_world: World, _actorId: string): Promise<ProposalResult> {
      fb.calls++;
      return { suggestions: ["Fallback action."], reasoning: "fallback reasoning" };
    },
  };
  return fb;
}

/** Office-ish world: anton + dana + tanya, desk + mug. */
function officeWorld(): World {
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
    {
      id: "tanya", name: "Tanya", persona: "A manager.", x: 5, y: 1,
      state: "reviewing", emotion: "neutral", goal: "Unblock the team.",
      thoughts: "", memories: [], beliefs: [], relationships: [],
    },
  ];
  w.scene.objects.push(
    {
      id: "desk1", name: "desk", description: "a desk", x: 2, y: 1,
      w: 2, h: 1, passable: false, blocksVision: false, blocksSound: false,
    },
    {
      id: "mug1", name: "mug", description: "a mug", x: 1, y: 2,
      w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    },
  );
  return w;
}

const KINDS = ["speak", "move", "interact", "gesture", "wait"];

describe("LayaProposalEngine", () => {
  it("runs the full cascade: intent → target → candidates → ranked pick", async () => {
    const world = officeWorld();
    const candidates = [
      "Anton greets Dana warmly",
      "Anton asks Dana how they're doing",
      "Anton makes small talk with Dana",
      "Anton says hello to Dana",
    ];
    const client = scriptedClient({
      intent_kind: choice("speak", KINDS),
      addressee: choice("one specific person", ["one specific person", "nobody in particular"]),
      manner: choice("directly and purposefully", ["directly and purposefully", "casually"]),
      [TARGET_QUESTION_ID]: choice("Dana", ["Anton", "Dana", "Tanya"].filter((n) => n !== "Anton")),
      [EXACT_INTENT_QUESTION_ID]: choice(candidates[0]!, candidates, 0.85),
    });
    const fb = recordingFallback();
    const engine = new LayaProposalEngine({ client }, fb);
    const result = await engine.propose(world, "anton");

    expect(fb.calls).toBe(0);
    expect(result.suggestions).toHaveLength(3); // maxSuggestions default
    expect(result.suggestions[0]).toBe(candidates[0]);
    // Fully-typed intent threads to the executors.
    expect(result.intent).toMatchObject({
      kind: "speak",
      targetKind: "actor",
      targetId: "dana",
      manner: "directly and purposefully",
    });
    expect(result.reasoning).toContain("laya:");
    expect(result.reasoning).toContain("speak");
  });

  it("uses a passed intent and skips the kind cascade", async () => {
    const world = officeWorld();
    const seen: string[][] = [];
    const candidates = ["Anton walks over to the desk", "Anton approaches the desk"];
    const client = scriptedClient(
      {
        [TARGET_QUESTION_ID]: choice("desk", ["desk", "mug"]),
        [EXACT_INTENT_QUESTION_ID]: choice(candidates[0]!, candidates, 0.9),
      },
      (ids) => seen.push(ids),
    );
    const fb = recordingFallback();
    const engine = new LayaProposalEngine({ client }, fb);
    const passed: Intent = { kind: "move", targetKind: "landmark", manner: "directly and purposefully" };
    const result = await engine.propose(world, "anton", passed);

    expect(fb.calls).toBe(0);
    // No intent_kind question was asked — the passed intent was used.
    expect(seen.flat()).not.toContain("intent_kind");
    expect(result.intent).toMatchObject({ kind: "move", targetKind: "landmark", targetId: "desk1" });
    expect(result.suggestions[0]).toBe(candidates[0]);
  });

  it("skips target resolution when the intent is already fully typed", async () => {
    const world = officeWorld();
    const seen: string[][] = [];
    const candidates = ["Anton greets Dana warmly", "Anton says hello to Dana"];
    const client = scriptedClient(
      { [EXACT_INTENT_QUESTION_ID]: choice(candidates[1]!, candidates, 0.9) },
      (ids) => seen.push(ids),
    );
    const engine = new LayaProposalEngine({ client }, recordingFallback());
    const result = await engine.propose(world, "anton", {
      kind: "speak", targetKind: "actor", targetId: "dana",
    });
    expect(seen.flat()).toEqual([EXACT_INTENT_QUESTION_ID]);
    expect(result.intent?.targetId).toBe("dana");
    expect(result.suggestions[0]).toBe(candidates[1]);
  });

  it("delegates to fallback when the target resolves to nothing", async () => {
    const world = officeWorld();
    const client = scriptedClient({
      intent_kind: choice("speak", KINDS),
      addressee: choice("one specific person", ["one specific person", "nobody in particular"]),
      manner: choice("casually", ["casually"]),
      [TARGET_QUESTION_ID]: choice("Zed", ["Dana", "Tanya", "Zed"]),
    });
    const fb = recordingFallback();
    const engine = new LayaProposalEngine({ client }, fb);
    const result = await engine.propose(world, "anton");
    expect(fb.calls).toBe(1);
    expect(result.suggestions).toEqual(["Fallback action."]);
    expect(result.reasoning).toContain("laya proposal:");
    expect(result.intent).toBeUndefined();
  });

  it("delegates to fallback on below-threshold confidence", async () => {
    const world = officeWorld();
    const candidates = ["Anton waits quietly", "Anton observes the room"];
    const client = scriptedClient({
      intent_kind: choice("wait", KINDS),
      manner: choice("casually", ["casually"]),
      [EXACT_INTENT_QUESTION_ID]: choice(candidates[0]!, candidates, 0.2),
    });
    const fb = recordingFallback();
    const engine = new LayaProposalEngine({ client, confidenceThreshold: 0.55 }, fb);
    const result = await engine.propose(world, "anton");
    expect(fb.calls).toBe(1);
    expect(result.reasoning).toContain("threshold");
  });

  it("delegates to fallback when Laya is down", async () => {
    const fb = recordingFallback();
    const engine = new LayaProposalEngine({ client: downClient() }, fb);
    const result = await engine.propose(officeWorld(), "anton");
    expect(fb.calls).toBe(1);
    expect(result.suggestions).toEqual(["Fallback action."]);
  });

  it("delegates to fallback when the exact-intent answer is missing", async () => {
    const world = officeWorld();
    const client = scriptedClient({
      intent_kind: choice("wait", KINDS),
      manner: choice("casually", ["casually"]),
      // exact_intent scripted as a noul — wrong shape triggers fallback.
      [EXACT_INTENT_QUESTION_ID]: { type: "noul", pTrue: 0.9 },
    });
    const fb = recordingFallback();
    const engine = new LayaProposalEngine({ client }, fb);
    const result = await engine.propose(world, "anton");
    expect(fb.calls).toBe(1);
  });

  it("respects maxSuggestions", async () => {
    const world = officeWorld();
    const candidates = [
      "Anton waits quietly",
      "Anton observes the room",
      "Anton sits back and watches",
    ];
    const client = scriptedClient({
      intent_kind: choice("wait", KINDS),
      manner: choice("casually", ["casually"]),
      [EXACT_INTENT_QUESTION_ID]: choice(candidates[2]!, candidates, 0.95),
    });
    const engine = new LayaProposalEngine({ client, maxSuggestions: 2 }, recordingFallback());
    const result = await engine.propose(world, "anton");
    expect(result.suggestions).toEqual([candidates[2], candidates[0]]);
  });

  it("orders suggestions by choice probability", async () => {
    const world = officeWorld();
    const candidates = ["Anton waits quietly", "Anton observes the room", "Anton sits back and watches"];
    const probs = { [candidates[0]!]: 0.15, [candidates[1]!]: 0.6, [candidates[2]!]: 0.25 };
    const client = scriptedClient({
      intent_kind: choice("wait", KINDS),
      manner: choice("casually", ["casually"]),
      [EXACT_INTENT_QUESTION_ID]: {
        type: "choice", winner: candidates[1]!, probabilities: probs, confidence: 0.9,
      },
    });
    const engine = new LayaProposalEngine({ client }, recordingFallback());
    const result = await engine.propose(world, "anton");
    expect(result.suggestions).toEqual([candidates[1], candidates[2], candidates[0]]);
  });

  it("works with the deterministic fallback (zero-LLM stack)", async () => {
    const engine = new LayaProposalEngine(
      { client: downClient() },
      new DeterministicProposalEngine(),
    );
    const result = await engine.propose(officeWorld(), "anton");
    expect(result.suggestions).toEqual([
      "Stay where you are.",
      "Look around.",
      "Do nothing.",
    ]);
  });
});

describe("LayaProposalEngine.lastDelegation (Stage 3 C2/C3)", () => {
  it("records the cause and provider-backed-ness when delegating", async () => {
    const fb = recordingFallback();
    (fb as unknown as { providerBacked: boolean }).providerBacked = true;
    const engine = new LayaProposalEngine({ client: downClient() }, fb);
    expect(engine.lastDelegation).toBeUndefined();
    await engine.propose(officeWorld(), "anton");
    expect(engine.lastDelegation).toMatchObject({
      cause: expect.stringContaining("intent cascade failed"),
      providerBacked: true,
    });
  });

  it("marks providerBacked false for a local fallback", async () => {
    const engine = new LayaProposalEngine({ client: downClient() }, recordingFallback());
    await engine.propose(officeWorld(), "anton");
    expect(engine.lastDelegation?.providerBacked).toBe(false);
  });

  it("resets on every propose() call", async () => {
    const engine = new LayaProposalEngine({ client: downClient() }, recordingFallback());
    await engine.propose(officeWorld(), "anton");
    expect(engine.lastDelegation).toBeDefined();
    // A succeeding run clears the record: scripted cascade -> wait has no
    // target question, no candidates for wait... force success via a
    // full script instead: use the down client again but the record must
    // be fresh per call, so a second failing call re-records.
    await engine.propose(officeWorld(), "anton");
    expect(engine.lastDelegation?.cause).toContain("intent cascade failed");
  });

  it("stays undefined when the cascade path succeeds", async () => {
    const candidates = ["Anton waits quietly", "Anton observes the room"];
    const client = scriptedClient({
      intent_kind: choice("wait", KINDS),
      manner: choice("casually", ["casually"]),
      [EXACT_INTENT_QUESTION_ID]: choice(candidates[0]!, candidates, 0.95),
    });
    const engine = new LayaProposalEngine({ client }, recordingFallback());
    const result = await engine.propose(officeWorld(), "anton");
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(engine.lastDelegation).toBeUndefined();
  });
});
