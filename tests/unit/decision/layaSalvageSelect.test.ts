import { describe, expect, it } from "vitest";
import type { Action, ConsequenceResult } from "../../../src/types.js";
import type { LayaAnswer } from "../../../src/decision/decisionTypes.js";
import { LayaClient } from "../../../src/decision/layaClient.js";
import {
  buildSalvageChoiceQuestion,
  buildSalvageState,
  deterministicSalvageOrder,
  rankByChoiceProbabilities,
  rankSalvageCandidates,
  salvageCandidateLabel,
  type SalvageCandidate,
} from "../../../src/decision/layaSalvageSelect.js";

function candidate(
  narrative: string,
  hardErrors: number,
): SalvageCandidate {
  return {
    result: { narrative } as ConsequenceResult,
    hardErrors,
  };
}

describe("deterministicSalvageOrder", () => {
  it("orders fewest hard errors first", () => {
    const cs = [candidate("a", 3), candidate("b", 0), candidate("c", 1)];
    expect(deterministicSalvageOrder(cs)).toEqual([1, 2, 0]);
  });

  it("breaks ties toward the earlier attempt", () => {
    const cs = [candidate("a", 2), candidate("b", 2), candidate("c", 2)];
    expect(deterministicSalvageOrder(cs)).toEqual([0, 1, 2]);
  });

  it("returns [] for no candidates", () => {
    expect(deterministicSalvageOrder([])).toEqual([]);
  });
});

describe("salvageCandidateLabel", () => {
  it("names the attempt, error count, and a narrative excerpt", () => {
    const label = salvageCandidateLabel(0, candidate("Jeff walks east.", 2));
    expect(label).toBe("Attempt 1 (2 hard errors): Jeff walks east.");
  });
});

describe("buildSalvageChoiceQuestion", () => {
  it("builds one choice question over the candidate labels", () => {
    const cs = [candidate("walks east", 0), candidate("sits", 2)];
    const q = buildSalvageChoiceQuestion("walk east", cs);
    expect(Object.keys(q)).toEqual(["salvage_pick"]);
    const pick = q["salvage_pick"]!;
    expect(pick.type).toBe("choice");
    if (pick.type === "choice") {
      expect(pick.options).toHaveLength(2);
      expect(pick.options[0]).toContain("Attempt 1");
      expect(pick.instructions).toContain("walk east");
    }
  });
});

describe("buildSalvageState", () => {
  it("contains the action and numbered candidates", () => {
    const s = buildSalvageState("walk east", [candidate("goes east", 0)]);
    expect(s).toContain("walk east");
    expect(s).toContain("1. Attempt 1");
  });
});

describe("rankByChoiceProbabilities", () => {
  it("sorts options by descending probability", () => {
    const ranked = rankByChoiceProbabilities(
      { a: 0.2, b: 0.7, c: 0.1 },
      ["a", "b", "c"],
    );
    expect(ranked).toEqual(["b", "a", "c"]);
  });

  it("sends options missing from the map to the end", () => {
    const ranked = rankByChoiceProbabilities({ b: 0.7 }, ["a", "b"]);
    expect(ranked).toEqual(["b", "a"]);
  });
});

/** Scripted LayaClient answering the salvage_pick question from a script. */
function scriptedClient(script: Record<string, LayaAnswer>): LayaClient {
  return new LayaClient({
    baseUrl: "http://stub",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const ids = Object.keys(body.questions ?? {});
      const answers: Record<string, unknown> = {};
      for (const id of ids) {
        const a = script[id];
        if (!a) throw new Error(`no scripted answer for "${id}"`);
        answers[id] = {
          type: "choice",
          choice: (a as { winner: string }).winner,
          probabilities: (a as { probabilities: Record<string, number> })
            .probabilities,
          confidence: 0.9,
        };
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch,
  });
}

function choiceAnswer(
  winner: string,
  options: string[],
  p = 0.9,
): LayaAnswer {
  const probabilities: Record<string, number> = {};
  for (const o of options)
    probabilities[o] = o === winner ? p : (1 - p) / Math.max(1, options.length - 1);
  return { type: "choice", winner, probabilities, confidence: p };
}

describe("rankSalvageCandidates", () => {
  const action = { text: "walk east" } as Action;

  it("returns the Laya probability order over candidates", async () => {
    const cs = [
      candidate("Jeff walks east toward Ana.", 1),
      candidate("Jeff sits and thinks.", 1),
    ];
    const labels = cs.map((c, i) => salvageCandidateLabel(i, c));
    const client = scriptedClient({
      salvage_pick: choiceAnswer(labels[1]!, labels),
    });
    expect(await rankSalvageCandidates(client, action, cs)).toEqual([1, 0]);
  });

  it("degrades to undefined when the client throws", async () => {
    const client = new LayaClient({
      baseUrl: "http://stub",
      fetchImpl: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    const cs = [candidate("a", 0), candidate("b", 1)];
    expect(await rankSalvageCandidates(client, action, cs)).toBeUndefined();
  });

  it("returns the trivial order for a single candidate without calling Laya", async () => {
    let called = false;
    const client = new LayaClient({
      baseUrl: "http://stub",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(await rankSalvageCandidates(client, action, [candidate("a", 0)])).toEqual([0]);
    expect(called).toBe(false);
  });
});
