// PLAN_V2 Phase 6: the batched judge question set for the Laya semantic
// parser. Extracted verbatim from src/decision/diagrams.ts (deleted with
// the static decision diagrams) — this is the only piece the parser
// needs: q_moves / q_speaks / q_addressee / q_destination / q_contact run
// in ONE decide() call over the action sentence.

import type { LayaQuestion } from "./decisionTypes.js";

/**
 * Batched judge set: two noul questions (moves? speaks?) plus choice
 * questions over the roster/landmarks. Run in ONE decide() call.
 */
export function buildJudgeQuestions(
  roster: string[],
  landmarks: string[],
): Record<string, LayaQuestion> {
  const nobody = "nobody in particular";
  const nowhere = "stays put / nowhere";
  const noContact = "no physical contact";
  return {
    q_moves: {
      type: "noul",
      instructions:
        "Does this action involve the actor physically relocating — walking, running, going somewhere? Resuming a stationary activity (typing, sitting back down to work) does NOT count as moving.",
    },
    q_speaks: {
      type: "noul",
      instructions:
        "Does this action include the actor uttering words aloud or explicitly intending to speak? Thinking or gesturing silently does NOT count.",
    },
    q_addressee: {
      type: "choice",
      instructions: "Who is the actor speaking directly to?",
      options: [...roster, nobody],
    },
    q_destination: {
      type: "choice",
      instructions: "Where does the actor move to, or toward whom?",
      options: [...landmarks, ...roster, nowhere],
    },
    q_contact: {
      type: "choice",
      instructions: "Who does the actor physically touch or hand something to?",
      options: [...roster, noContact],
    },
  };
}
