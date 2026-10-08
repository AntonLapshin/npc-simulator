import { describe, expect, it } from "vitest";
import type { LayaAnswer } from "../../../src/decision/decisionTypes.js";
import { LayaClient } from "../../../src/decision/layaClient.js";
import {
  buildLocomotionQuestion,
  buildLocomotionState,
  checkLocomotionVeto,
  LOCOMOTION_VETO_THRESHOLD,
  shouldVetoMovement,
} from "../../../src/decision/layaLocomotion.js";

/** Scripted LayaClient answering the locomotion noul from a script. */
function scriptedClient(pTrue: number): LayaClient {
  return new LayaClient({
    baseUrl: "http://stub",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const ids = Object.keys(body.questions ?? {});
      const answers: Record<string, unknown> = {};
      for (const id of ids) answers[id] = { type: "noul", noul: pTrue };
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch,
  });
}

describe("buildLocomotionQuestion", () => {
  it("builds a single word-sense-aware noul question", () => {
    const q = buildLocomotionQuestion();
    expect(Object.keys(q)).toEqual(["locomotion"]);
    const loc = q["locomotion"]!;
    expect(loc.type).toBe("noul");
    expect(loc.instructions).toContain("relocate");
    expect(loc.instructions).toContain("turns toward");
  });
});

describe("buildLocomotionState", () => {
  it("carries the action text in a slim state", () => {
    expect(buildLocomotionState("turn to face Dan")).toContain(
      "turn to face Dan",
    );
  });
});

describe("shouldVetoMovement", () => {
  it("vetoes at or below the threshold", () => {
    expect(
      shouldVetoMovement({ type: "noul", pTrue: LOCOMOTION_VETO_THRESHOLD }),
    ).toBe(true);
    expect(shouldVetoMovement({ type: "noul", pTrue: 0.1 })).toBe(true);
  });

  it("keeps the deterministic verdict above the threshold", () => {
    expect(shouldVetoMovement({ type: "noul", pTrue: 0.36 })).toBe(false);
    expect(shouldVetoMovement({ type: "noul", pTrue: 0.9 })).toBe(false);
  });

  it("returns false for missing or non-noul answers", () => {
    expect(shouldVetoMovement(undefined)).toBe(false);
    const choice = {
      type: "choice",
      winner: "x",
      probabilities: {},
      confidence: 1,
    } as LayaAnswer;
    expect(shouldVetoMovement(choice)).toBe(false);
  });
});

describe("checkLocomotionVeto", () => {
  it("returns true when Laya confidently says no relocation", async () => {
    expect(await checkLocomotionVeto(scriptedClient(0.1), "turn to face Dan")).toBe(true);
  });

  it("returns false when Laya says relocation is needed", async () => {
    expect(await checkLocomotionVeto(scriptedClient(0.9), "walk to Ana")).toBe(false);
  });

  it("returns undefined (fail open) when Laya is down", async () => {
    const down = new LayaClient({
      baseUrl: "http://stub",
      fetchImpl: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    expect(await checkLocomotionVeto(down, "walk to Ana")).toBeUndefined();
  });
});
