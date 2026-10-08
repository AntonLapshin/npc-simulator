import { beforeEach, describe, expect, it, vi } from "vitest";
import type { World } from "../../../src/types.js";
import type { LayaAnswer } from "../../../src/decision/decisionTypes.js";
import { LayaClient } from "../../../src/decision/layaClient.js";
import {
  LayaSelectionEngine,
  NONE_FIT_OPTION,
} from "../../../src/decision/layaSelectionEngine.js";
import { LayaSemanticJudge } from "../../../src/decision/layaSemanticJudge.js";
import type { SelectionEngine } from "../../../src/intelligence/types.js";

/**
 * Scripted LayaClient: answers come from a per-question-id script instead of
 * the network, so engine behavior is tested without HTTP.
 */
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
        answers[id] =
          a.type === "choice"
            ? {
                type: "choice",
                choice: a.winner,
                probabilities: a.probabilities,
                confidence: a.confidence,
              }
            : a.type === "noul"
              ? { type: "noul", noul: a.pTrue }
              : {
                  type: "score",
                  score: a.expected,
                  probabilities: a.distribution,
                  confidence: 0.5,
                };
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch,
  });
}

function choice(winner: string, p: number, options: string[]): LayaAnswer {
  const probabilities: Record<string, number> = {};
  for (const o of options) probabilities[o] = o === winner ? p : (1 - p) / Math.max(1, options.length - 1);
  return { type: "choice", winner, probabilities, confidence: p };
}

function makeWorld(): World {
  return {
    version: 1,
    id: "w1",
    title: "Office",
    narrative: "",
    userActorId: "a1",
    order: ["a1", "a2"],
    tick: 1,
    turnIndex: 1,
    history: [],
    scene: {
      width: 10,
      height: 10,
      objects: [
        { id: "o1", name: "whiteboard", description: "", x: 1, y: 1, w: 2, h: 1, passable: false, blocksVision: false, blocksSound: false },
      ],
    },
    actors: [
      {
        id: "a1", name: "Anton", persona: "A careful engineer.", x: 1, y: 1,
        state: "working", emotion: "focused", goal: "Ship it.",
        thoughts: "", memories: [], beliefs: [], relationships: [],
      },
      {
        id: "a2", name: "Dana", persona: "A manager.", x: 2, y: 2,
        state: "waiting", emotion: "calm", goal: "Update.",
        thoughts: "", memories: [], beliefs: [], relationships: [],
      },
    ],
  };
}

const stubFallback: SelectionEngine = {
  select: vi.fn(async (_w, _a, suggestions) => ({
    action: suggestions[0] ?? "idle",
    reasoning: "chat fallback",
  })),
};

describe("LayaSelectionEngine", () => {
  beforeEach(() => vi.clearAllMocks());
  const cascadeScript = (): Record<string, LayaAnswer> => ({
    intent_kind: choice("speak", 0.9, ["speak", "move", "interact", "gesture", "wait"]),
    addressee: choice("one specific person", 0.85, [
      "one specific person",
      "everyone present",
      "nobody in particular",
    ]),
    manner: choice("directly and purposefully", 0.8, [
      "directly and purposefully",
      "casually",
      "hesitantly",
      "playfully",
    ]),
  });

  it("picks the Laya winner when confident", async () => {
    const candidates = ["Say hello to Dana.", "Keep typing."];
    const client = scriptedClient({
      ...cascadeScript(),
      candidate_fit: choice(candidates[0]!, 0.9, [...candidates, NONE_FIT_OPTION]),
    });
    const engine = new LayaSelectionEngine({ client }, stubFallback);
    const result = await engine.select(makeWorld(), "a1", candidates);
    expect(result.action).toBe(candidates[0]);
    expect(result.reasoning).toContain("laya");
    expect(result.reasoning).toContain("intent=speak");
    expect(stubFallback.select).not.toHaveBeenCalled();
  });

  it("delegates to the fallback when the winner is 'none fit'", async () => {
    const candidates = ["Say hello.", "Keep typing."];
    const client = scriptedClient({
      ...cascadeScript(),
      candidate_fit: choice(NONE_FIT_OPTION, 0.95, [...candidates, NONE_FIT_OPTION]),
    });
    const engine = new LayaSelectionEngine({ client }, stubFallback);
    const result = await engine.select(makeWorld(), "a1", candidates);
    expect(stubFallback.select).toHaveBeenCalledOnce();
    expect(result.action).toBe(candidates[0]);
    expect(result.reasoning).toContain("chat fallback");
  });

  it("delegates to the fallback below the confidence threshold", async () => {
    const candidates = ["Say hello.", "Keep typing."];
    const client = scriptedClient({
      ...cascadeScript(),
      candidate_fit: choice(candidates[1]!, 0.4, [...candidates, NONE_FIT_OPTION]),
    });
    const engine = new LayaSelectionEngine(
      { client, confidenceThreshold: 0.55 },
      stubFallback,
    );
    await engine.select(makeWorld(), "a1", candidates);
    expect(stubFallback.select).toHaveBeenCalledOnce();
  });

  it("delegates to the fallback when Laya is unavailable", async () => {
    const client = new LayaClient({
      baseUrl: "http://stub",
      fetchImpl: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    const engine = new LayaSelectionEngine({ client }, stubFallback);
    const result = await engine.select(makeWorld(), "a1", ["Wave."]);
    expect(stubFallback.select).toHaveBeenCalledOnce();
    expect(result.action).toBe("Wave.");
  });

  it("survives an actor without thoughts when Laya is down (diagnose-ai stub path, S9)", async () => {
    // scripts/diagnose-ai.ts builds its stub world without `thoughts`
    // (scripts/ are not typechecked); with LAYA_MODE/LAYA_SELECTION on,
    // select() routes through buildIntentState BEFORE the fail-open
    // try/catch, so a missing field used to crash the whole check with
    // "Cannot read properties of undefined (reading 'trim')".
    const client = new LayaClient({
      baseUrl: "http://stub",
      fetchImpl: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    const world = makeWorld();
    delete (world.actors[0] as unknown as Record<string, unknown>)["thoughts"];
    const engine = new LayaSelectionEngine({ client }, stubFallback);
    const result = await engine.select(world, "a1", ["Stay where you are."]);
    expect(stubFallback.select).toHaveBeenCalledOnce();
    expect(result.action).toBe("Stay where you are.");
  });
});

describe("LayaSemanticJudge", () => {
  it("merges one batched decide into ActionSemantics with deterministic quotes", async () => {
    const client = scriptedClient({
      q_moves: { type: "noul", pTrue: 0.92 },
      q_speaks: { type: "noul", pTrue: 0.95 },
      q_addressee: choice("Dana", 0.9, ["Anton", "Dana", "nobody in particular"]),
      q_destination: choice("whiteboard", 0.88, [
        "whiteboard",
        "Anton",
        "Dana",
        "stays put / nowhere",
      ]),
      q_contact: choice("no physical contact", 0.97, ["Anton", "Dana", "no physical contact"]),
    });
    const judge = new LayaSemanticJudge({ client });
    const semantics = await judge.classify(makeWorld(), {
      actorId: "a1",
      text: 'Anton walks to the whiteboard and tells Dana: "Look at this diagram."',
    });
    expect(semantics.moves).toBe(true);
    expect(semantics.speaks).toBe(true);
    expect(semantics.quotedSpeech).toEqual(["Look at this diagram."]);
    expect(semantics.addresseeActorId).toBe("a2");
    expect(semantics.destinationObjectId).toBe("o1");
    expect(semantics.destinationActorId).toBeUndefined();
    expect(semantics.contactActorId).toBeUndefined();
  });

  it("leaves optional fields unset when winners are the none-tokens", async () => {
    const client = scriptedClient({
      q_moves: { type: "noul", pTrue: 0.05 },
      q_speaks: { type: "noul", pTrue: 0.02 },
      q_addressee: choice("nobody in particular", 0.99, ["Anton", "Dana", "nobody in particular"]),
      q_destination: choice("stays put / nowhere", 0.99, [
        "whiteboard",
        "Anton",
        "Dana",
        "stays put / nowhere",
      ]),
      q_contact: choice("no physical contact", 0.99, ["Anton", "Dana", "no physical contact"]),
    });
    const judge = new LayaSemanticJudge({ client });
    const semantics = await judge.classify(makeWorld(), {
      actorId: "a1",
      text: "Anton keeps typing.",
    });
    expect(semantics.moves).toBe(false);
    expect(semantics.speaks).toBe(false);
    expect(semantics.quotedSpeech).toEqual([]);
    expect(semantics.addresseeActorId).toBeUndefined();
    expect(semantics.destinationObjectId).toBeUndefined();
    expect(semantics.contactActorId).toBeUndefined();
  });

  it("resolves a destination actor id when the winner is a person", async () => {
    const client = scriptedClient({
      q_moves: { type: "noul", pTrue: 0.9 },
      q_speaks: { type: "noul", pTrue: 0.1 },
      q_addressee: choice("nobody in particular", 0.9, ["Anton", "Dana", "nobody in particular"]),
      q_destination: choice("Dana", 0.85, ["whiteboard", "Anton", "Dana", "stays put / nowhere"]),
      q_contact: choice("no physical contact", 0.9, ["Anton", "Dana", "no physical contact"]),
    });
    const judge = new LayaSemanticJudge({ client });
    const semantics = await judge.classify(makeWorld(), {
      actorId: "a1",
      text: "Anton walks over to Dana.",
    });
    expect(semantics.destinationActorId).toBe("a2");
    expect(semantics.destinationObjectId).toBeUndefined();
  });
});
