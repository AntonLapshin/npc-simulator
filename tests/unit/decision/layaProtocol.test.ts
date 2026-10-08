import { describe, expect, it } from "vitest";
import {
  buildSystemOnePayload,
  LayaProtocolError,
  parseSystemOneResponse,
} from "../../../src/decision/utils/layaProtocol.js";
import type { LayaQuestion } from "../../../src/decision/decisionTypes.js";

const QUESTIONS: Record<string, LayaQuestion> = {
  q_choice: {
    type: "choice",
    instructions: "Pick one.",
    options: ["alpha", "beta"],
  },
  q_noul: { type: "noul", instructions: "Is it true?" },
  q_score: { type: "score", instructions: "Rate it.", levels: ["1", "2", "3"] },
};

describe("buildSystemOnePayload", () => {
  it("builds the Jev-compatible body with a document state", () => {
    const payload = buildSystemOnePayload("hello world", QUESTIONS);
    expect(payload.state).toEqual({ document: "hello world" });
    expect(payload.questions["q_choice"]).toEqual({
      type: "choice",
      instructions: "Pick one.",
      criteria: { alpha: "alpha", beta: "beta" },
    });
    expect(payload.questions["q_noul"]).toEqual({
      type: "noul",
      instructions: "Is it true?",
    });
    expect(payload.questions["q_score"]).toEqual({
      type: "score",
      instructions: "Rate it.",
      criteria: ["1", "2", "3"],
    });
  });

  it("handles an empty question map", () => {
    const payload = buildSystemOnePayload("s", {});
    expect(payload.questions).toEqual({});
  });
});

describe("parseSystemOneResponse", () => {
  const body = {
    model: "laya",
    answers: {
      q_choice: {
        type: "choice",
        choice: "beta",
        probabilities: { alpha: 0.3, beta: 0.7 },
        confidence: 0.55,
      },
      q_noul: { type: "noul", noul: 0.82 },
      q_score: {
        type: "score",
        score: 1.4,
        legend: { 0: "1", 1: "2", 2: "3" },
        probabilities: { 0: 0.6, 1: 0.3, 2: 0.1 },
        confidence: 0.5,
      },
    },
    usage: { input_tokens: 10, output_tokens: 0 },
  };

  it("normalizes choice/noul/score answers", () => {
    const answers = parseSystemOneResponse(body, QUESTIONS);
    expect(answers["q_choice"]).toEqual({
      type: "choice",
      winner: "beta",
      probabilities: { alpha: 0.3, beta: 0.7 },
      confidence: 0.55,
    });
    expect(answers["q_noul"]).toEqual({ type: "noul", pTrue: 0.82 });
    expect(answers["q_score"]).toEqual({
      type: "score",
      expected: 1.4,
      distribution: { 0: 0.6, 1: 0.3, 2: 0.1 },
    });
  });

  it("computes the expected score from the distribution when no score field", () => {
    const noScore = {
      answers: {
        q_score: {
          type: "score",
          probabilities: { 0: 0.0, 1: 1.0, 2: 0.0 },
        },
      },
    };
    const answers = parseSystemOneResponse(noScore, { q_score: QUESTIONS["q_score"]! });
    expect(answers["q_score"]!.type).toBe("score");
    if (answers["q_score"]!.type === "score") {
      expect(answers["q_score"]!.expected).toBeCloseTo(1, 5);
    }
  });

  it("accepts a bare answers map without the envelope", () => {
    const answers = parseSystemOneResponse(body.answers, {
      q_noul: QUESTIONS["q_noul"]!,
    });
    expect(answers["q_noul"]).toEqual({ type: "noul", pTrue: 0.82 });
  });

  it("throws LayaProtocolError when an answer is missing", () => {
    expect(() => parseSystemOneResponse({ answers: {} }, QUESTIONS)).toThrow(LayaProtocolError);
  });

  it("throws LayaProtocolError on a non-object body", () => {
    expect(() => parseSystemOneResponse("nope", QUESTIONS)).toThrow(LayaProtocolError);
  });

  it("throws LayaProtocolError when choice has no winner", () => {
    const bad = { answers: { q_choice: { type: "choice", probabilities: {} } } };
    expect(() =>
      parseSystemOneResponse(bad, { q_choice: QUESTIONS["q_choice"]! }),
    ).toThrow(LayaProtocolError);
  });

  it("throws LayaProtocolError when noul has no numeric field", () => {
    const bad = { answers: { q_noul: { type: "noul" } } };
    expect(() =>
      parseSystemOneResponse(bad, { q_noul: QUESTIONS["q_noul"]! }),
    ).toThrow(LayaProtocolError);
  });

  it("clamps out-of-range probabilities into [0,1]", () => {
    const answers = parseSystemOneResponse(
      { answers: { q_noul: { type: "noul", noul: 7 } } },
      { q_noul: QUESTIONS["q_noul"]! },
    );
    expect(answers["q_noul"]).toEqual({ type: "noul", pTrue: 1 });
  });
});
