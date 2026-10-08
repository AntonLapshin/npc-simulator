// Pure wire-protocol helpers for the Jev-compatible /v1/systemone endpoint.
// No I/O here — the thin LayaClient shell in layaClient.ts does the fetching.

import type {
  LayaAnswer,
  LayaQuestion,
} from "../decisionTypes.js";

export type SystemOneRequest = {
  state: unknown;
  questions: Record<string, SystemOneQuestionWire>;
};

export type SystemOneQuestionWire =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

/** Marker for "the server answered, but the payload is not usable". */
export class LayaProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayaProtocolError";
  }
}

/**
 * Build the POST body for /v1/systemone from a state string and typed
 * questions. Choice options become a criteria map (id -> id, self-describing);
 * score levels become an ordered criteria list.
 */
export function buildSystemOnePayload(
  state: string,
  questions: Record<string, LayaQuestion>,
): SystemOneRequest {
  const wire: Record<string, SystemOneQuestionWire> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const criteria: Record<string, string | null> = {};
      for (const opt of q.options) criteria[opt] = opt;
      wire[id] = { type: "choice", instructions: q.instructions, criteria };
    } else if (q.type === "score") {
      wire[id] = { type: "score", instructions: q.instructions, criteria: [...q.levels] };
    } else {
      wire[id] = { type: "noul", instructions: q.instructions };
    }
  }
  return { state: { document: state }, questions: wire };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseProbabilities(raw: unknown, label: string): Record<string, number> {
  if (!isRecord(raw)) throw new LayaProtocolError(`answer "${label}": probabilities is not an object`);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new LayaProtocolError(`answer "${label}": probability for "${k}" is not a number`);
    }
    out[k] = v;
  }
  return out;
}

function parseChoiceAnswer(id: string, raw: unknown): LayaAnswer {
  if (!isRecord(raw)) throw new LayaProtocolError(`answer "${id}": not an object`);
  const winner = raw["choice"];
  if (typeof winner !== "string" || winner.length === 0) {
    throw new LayaProtocolError(`answer "${id}": missing string "choice" field`);
  }
  const probabilities = parseProbabilities(raw["probabilities"], id);
  const confidence = raw["confidence"];
  const answerConfidence = raw["answer_confidence"];
  const conf = typeof confidence === "number" ? confidence
    : typeof answerConfidence === "number" ? answerConfidence
    : probabilities[winner];
  if (typeof conf !== "number" || Number.isNaN(conf)) {
    throw new LayaProtocolError(`answer "${id}": no usable confidence`);
  }
  return {
    type: "choice",
    winner,
    probabilities,
    confidence: Math.min(1, Math.max(0, conf)),
  };
}

function parseNoulAnswer(id: string, raw: unknown): LayaAnswer {
  if (!isRecord(raw)) throw new LayaProtocolError(`answer "${id}": not an object`);
  // Jev shape is {type:"noul", noul: 0.73}; accept p_true / value aliases.
  const pTrue = raw["noul"] ?? raw["p_true"] ?? raw["value"];
  if (typeof pTrue !== "number" || Number.isNaN(pTrue)) {
    throw new LayaProtocolError(`answer "${id}": missing numeric noul/p_true field`);
  }
  return { type: "noul", pTrue: Math.min(1, Math.max(0, pTrue)) };
}

function parseScoreAnswer(id: string, raw: unknown, levels: string[]): LayaAnswer {
  if (!isRecord(raw)) throw new LayaProtocolError(`answer "${id}": not an object`);
  const distribution = parseProbabilities(raw["probabilities"] ?? {}, id);
  let expected: number;
  const scoreField = raw["score"];
  if (typeof scoreField === "number" && !Number.isNaN(scoreField)) {
    expected = scoreField;
  } else {
    // Expected level index from the distribution (keys are stringified indices).
    let total = 0;
    let weighted = 0;
    for (const [k, p] of Object.entries(distribution)) {
      const idx = Number(k);
      if (!Number.isNaN(idx)) {
        total += p;
        weighted += idx * p;
      }
    }
    expected = total > 0 ? weighted / total : (levels.length - 1) / 2;
  }
  return { type: "score", expected, distribution };
}

/**
 * Normalize a /v1/systemone response body into typed answers keyed by
 * question id. Accepts the Jev envelope `{answers: {...}}` and, defensively,
 * a bare answers map. Throws LayaProtocolError on anything unusable.
 */
export function parseSystemOneResponse(
  body: unknown,
  questions: Record<string, LayaQuestion>,
): Record<string, LayaAnswer> {
  if (!isRecord(body)) throw new LayaProtocolError("response body is not an object");
  const envelope = isRecord(body["answers"]) ? body["answers"] : body;
  if (!isRecord(envelope)) throw new LayaProtocolError('response has no "answers" map');
  const out: Record<string, LayaAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const raw = (envelope as Record<string, unknown>)[id];
    if (raw === undefined) throw new LayaProtocolError(`missing answer for question "${id}"`);
    if (q.type === "choice") out[id] = parseChoiceAnswer(id, raw);
    else if (q.type === "noul") out[id] = parseNoulAnswer(id, raw);
    else out[id] = parseScoreAnswer(id, raw, q.levels);
  }
  return out;
}
