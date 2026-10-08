// Laya locomotion supplement (Exp-2-E item b).
//
// Word-sense disambiguation for the moves=true gate: "turn to face Dan"
// and "where should I sit?" must not count as relocation, while "walk to
// Ana's desk" must. Deterministic semantics decide first; this module
// only ever VETOES a moves=true (never promotes a moves=false), and only
// when Laya is confident the action needs no relocation. Any Laya failure
// keeps the deterministic verdict (fail open).

import type { LayaAnswer, LayaQuestion } from "./decisionTypes.js";
import { truncateToChars } from "./decisionState.js";
import { LayaClient } from "./layaClient.js";

/** pTrue at or below this means "confidently no relocation" — veto. */
export const LOCOMOTION_VETO_THRESHOLD = 0.35;

const LOCOMOTION_INSTRUCTIONS =
  "Does the action require the actor to physically relocate to a different spot (a new x,y position)? " +
  "Answer NO when the action only: faces or turns toward someone, asks about moving " +
  '("where should I sit?"), resumes a stationary activity (typing, sitting back down to work), ' +
  "or stays in place. " +
  "Answer YES for walking, running, going somewhere, approaching, or leaving.";

/** Single noul question; the action text rides in the state. Pure. */
export function buildLocomotionQuestion(): Record<string, LayaQuestion> {
  return { locomotion: { type: "noul", instructions: LOCOMOTION_INSTRUCTIONS } };
}

/** Slim state: just the action text. Pure. */
export function buildLocomotionState(actionText: string): string {
  return truncateToChars(`Action: ${actionText}`, 400);
}

/**
 * True when the answer confidently says "no relocation" (veto the
 * deterministic moves=true). False or unknown otherwise. Pure.
 */
export function shouldVetoMovement(answer: LayaAnswer | undefined): boolean {
  return (
    !!answer &&
    answer.type === "noul" &&
    answer.pTrue <= LOCOMOTION_VETO_THRESHOLD
  );
}

/**
 * Ask Laya whether the action requires relocation. Returns true = veto
 * (confidently no relocation), false = keep the deterministic moves=true,
 * undefined = Laya unavailable (fail open: keep deterministic). Never throws.
 */
export async function checkLocomotionVeto(
  client: LayaClient,
  actionText: string,
): Promise<boolean | undefined> {
  try {
    const answers = await client.decide(
      buildLocomotionState(actionText),
      buildLocomotionQuestion(),
    );
    return shouldVetoMovement(answers["locomotion"]);
  } catch {
    return undefined;
  }
}
