// Laya-assisted salvage candidate ranking (Exp-2-E item a).
//
// The retry loop keeps every failed attempt; the deterministic base order
// is fewest hard-gate errors first (attempt 1 wins ties — it is
// systematically the best). When LAYA_SALVAGE_SELECT=1, a single Laya
// `choice` over the attempt narratives refines that order by prose
// quality: "which candidate narrative best matches the action?" The
// salvage ladder then tries candidates in the ranked order and applies
// the first salvageable one. Any Laya failure degrades to the
// deterministic order — never to a worse one.

import type { Action, ConsequenceResult } from "../types.js";
import type { LayaAnswer, LayaQuestion } from "./decisionTypes.js";
import { truncateToChars } from "./decisionState.js";
import { LayaClient } from "./layaClient.js";

export type SalvageCandidate = {
  result: ConsequenceResult;
  /** Non-speech-nit validation error count (countHardErrors). */
  hardErrors: number;
};

/**
 * Deterministic base order: fewest hard errors first; ties go to the
 * earlier attempt. Pure.
 */
export function deterministicSalvageOrder(
  candidates: SalvageCandidate[],
): number[] {
  return candidates
    .map((c, i) => ({ i, hardErrors: c.hardErrors }))
    .sort((a, b) => a.hardErrors - b.hardErrors || a.i - b.i)
    .map((e) => e.i);
}

/** One-line label for a candidate in the choice question. Pure. */
export function salvageCandidateLabel(
  index: number,
  candidate: SalvageCandidate,
): string {
  const narrative = truncateToChars(candidate.result.narrative ?? "", 160);
  return `Attempt ${index + 1} (${candidate.hardErrors} hard errors): ${narrative}`;
}

/**
 * Single `choice` question over the candidate labels: which narrative
 * best matches the action? Prose quality only — salvage eligibility is
 * still decided by the deterministic salvage ladder. Pure.
 */
export function buildSalvageChoiceQuestion(
  actionText: string,
  candidates: SalvageCandidate[],
): Record<string, LayaQuestion> {
  const options = candidates.map((c, i) => salvageCandidateLabel(i, c));
  return {
    salvage_pick: {
      type: "choice",
      instructions:
        "Which candidate narrative best describes the action below? " +
        "Judge only how faithfully each describes the action — not style or detail. " +
        `Action: "${truncateToChars(actionText, 200)}"`,
      options,
    },
  };
}

/** Slim state: the action + the numbered candidate labels (budgeted). Pure. */
export function buildSalvageState(
  actionText: string,
  candidates: SalvageCandidate[],
): string {
  const lines = candidates.map(
    (c, i) => `${i + 1}. ${salvageCandidateLabel(i, c)}`,
  );
  return truncateToChars(
    `Action: ${actionText}\n\nCandidate narratives:\n${lines.join("\n")}`,
    1500,
  );
}

/**
 * Full ranking from a choice answer's probability map (descending).
 * Options missing from the map sort last, preserving original order. Pure.
 */
export function rankByChoiceProbabilities(
  probabilities: Record<string, number>,
  options: string[],
): string[] {
  return [...options].sort((a, b) => {
    const pa = probabilities[a];
    const pb = probabilities[b];
    if (pa === undefined && pb === undefined) return 0;
    if (pa === undefined) return 1;
    if (pb === undefined) return -1;
    return pb - pa;
  });
}

/**
 * Rank candidate indices by narrative-to-action match. Returns undefined
 * on ANY failure — the caller falls back to deterministicSalvageOrder.
 * Never throws.
 */
export async function rankSalvageCandidates(
  client: LayaClient,
  action: Action,
  candidates: SalvageCandidate[],
): Promise<number[] | undefined> {
  if (candidates.length <= 1) return candidates.map((_, i) => i);
  try {
    const options = candidates.map((c, i) => salvageCandidateLabel(i, c));
    const answers = await client.decide(
      buildSalvageState(action.text, candidates),
      buildSalvageChoiceQuestion(action.text, candidates),
    );
    const answer: LayaAnswer | undefined = answers["salvage_pick"];
    if (!answer || answer.type !== "choice") return undefined;
    const rankedOptions = rankByChoiceProbabilities(
      answer.probabilities,
      options,
    );
    const order = rankedOptions
      .map((o) => options.indexOf(o))
      .filter((i) => i >= 0);
    // Defensive: every candidate exactly once, in ranked order.
    const seen = new Set(order);
    for (let i = 0; i < options.length; i++) {
      if (!seen.has(i)) order.push(i);
    }
    return order;
  } catch {
    return undefined;
  }
}
