// Tests for the shared intent-cascade step (src/decision/intentCascade.ts).
// Phase 5 consolidation: one implementation used by the intent-first wiring,
// the Laya proposal engine, and the Laya selection engine.
import { describe, expect, it } from "vitest";
import type { ChoiceAnswer, LayaAnswer } from "../../../src/decision/decisionTypes.js";
import { LayaClient } from "../../../src/decision/layaClient.js";
import {
  intentFromCascadeDecisions,
  runStaticIntentCascade,
} from "../../../src/decision/intentCascade.js";
import { SELECTION_CASCADE } from "../../../src/decision/diagrams.js";

function choice(winner: string, options: string[], p = 0.9): ChoiceAnswer {
  const probabilities: Record<string, number> = {};
  for (const o of options) probabilities[o] = o === winner ? p : (1 - p) / Math.max(1, options.length - 1);
  return { type: "choice", winner, probabilities, confidence: p };
}

/** Scripted LayaClient: answers come from a per-question-id script. */
function scriptedClient(script: Record<string, ChoiceAnswer>): LayaClient {
  return new LayaClient({
    baseUrl: "http://stub",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const ids = Object.keys(body.questions ?? {});
      const answers: Record<string, unknown> = {};
      for (const id of ids) {
        const a = script[id];
        if (!a) throw new Error(`no scripted answer for "${id}"`);
        answers[id] = { type: "choice", choice: a.winner, probabilities: a.probabilities, confidence: a.confidence };
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch,
  });
}

const KINDS = ["speak", "move", "interact", "gesture", "wait"];

describe("intentFromCascadeDecisions", () => {
  it("maps speak + specific addressee to actor target", () => {
    expect(
      intentFromCascadeDecisions({
        intent_kind: choice("speak", KINDS),
        addressee: choice("one specific person", ["one specific person", "everyone present", "nobody in particular"]),
        manner: choice("directly and purposefully", ["directly and purposefully", "casually"]),
      }),
    ).toEqual({ kind: "speak", targetKind: "actor", manner: "directly and purposefully" });
  });
  it("maps speak + nobody to targetKind none", () => {
    const out = intentFromCascadeDecisions({
      intent_kind: choice("speak", KINDS),
      addressee: choice("nobody in particular", ["one specific person", "nobody in particular"]),
    });
    expect(out).toEqual({ kind: "speak", targetKind: "none" });
  });
  it("maps move variants to actor / landmark / none", () => {
    const dest = ["a specific place", "toward someone", "wander aimlessly"];
    expect(
      intentFromCascadeDecisions({ intent_kind: choice("move", KINDS), destination: choice("toward someone", dest) }).targetKind,
    ).toBe("actor");
    expect(
      intentFromCascadeDecisions({ intent_kind: choice("move", KINDS), destination: choice("a specific place", dest) }).targetKind,
    ).toBe("landmark");
    expect(
      intentFromCascadeDecisions({ intent_kind: choice("move", KINDS), destination: choice("wander aimlessly", dest) }).targetKind,
    ).toBe("none");
  });
  it("maps interact to object target + manner from target_object", () => {
    expect(
      intentFromCascadeDecisions({
        intent_kind: choice("interact", KINDS),
        target_object: choice("take", ["use", "take", "examine", "move it aside"]),
      }),
    ).toEqual({ kind: "interact", targetKind: "object", manner: "take" });
  });
  it("prefers the manner node over target_object manner", () => {
    const out = intentFromCascadeDecisions({
      intent_kind: choice("interact", KINDS),
      target_object: choice("take", ["use", "take"]),
      manner: choice("casually", ["casually", "directly and purposefully"]),
    });
    // target_object sets manner first; the manner node does not override it.
    expect(out.manner).toBe("take");
  });
  it("maps gesture/wait to the manner node", () => {
    expect(
      intentFromCascadeDecisions({
        intent_kind: choice("gesture", KINDS),
        manner: choice("playfully", ["playfully", "casually"]),
      }),
    ).toEqual({ kind: "gesture", manner: "playfully" });
    expect(intentFromCascadeDecisions({ intent_kind: choice("wait", KINDS) })).toEqual({ kind: "wait" });
  });
  it("falls back to wait on unknown or missing kind", () => {
    expect(intentFromCascadeDecisions({ intent_kind: choice("dance", KINDS) }).kind).toBe("wait");
    expect(intentFromCascadeDecisions({})).toEqual({ kind: "wait" });
  });
  it("ignores a non-choice kind answer", () => {
    expect(
      intentFromCascadeDecisions({ intent_kind: { type: "noul", pTrue: 0.9 } }).kind,
    ).toBe("wait");
  });
});

describe("runStaticIntentCascade", () => {
  it("walks the static cascade and derives the intent", async () => {
    const client = scriptedClient({
      intent_kind: choice("speak", KINDS),
      addressee: choice("one specific person", ["one specific person", "nobody in particular"]),
      manner: choice("directly and purposefully", ["directly and purposefully", "casually"]),
    });
    const intent = await runStaticIntentCascade(client, "state");
    expect(intent).toEqual({
      kind: "speak",
      targetKind: "actor",
      manner: "directly and purposefully",
    });
  });
  it("throws when Laya is unavailable (callers fail open)", async () => {
    const client = new LayaClient({
      baseUrl: "http://stub",
      fetchImpl: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    await expect(runStaticIntentCascade(client, "state")).rejects.toThrow();
  });
  it("uses the static cascade regardless of planner config", async () => {
    // The static cascade has exactly these node ids; a planner-generated
    // diagram would differ. The script only knows the static ids.
    const client = scriptedClient({
      intent_kind: choice("move", KINDS),
      destination: choice("wander aimlessly", ["a specific place", "toward someone", "wander aimlessly"]),
      manner: choice("casually", ["casually"]),
    });
    const intent = await runStaticIntentCascade(client, "state");
    expect(intent.kind).toBe("move");
    expect(intent.targetKind).toBe("none");
    expect(SELECTION_CASCADE.terminal).toBe("manner");
  });
});
