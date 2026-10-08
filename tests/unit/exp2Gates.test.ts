// Regression tests for Experiment 2 (experiments/local-laya-7moves-2026-10-08.md)
// action items #6 (S3: narrative.echoes_action vs speech.dropped_words jointly
// unsatisfiable on speech turns) and #8 (S4/S5: word-sense movement verbs —
// "where I should sit?" is a question, "turn to Dan" is facing).
import { describe, expect, it } from "vitest";
import {
  isFacingOnlyTurn,
  isInterrogativeQuestion,
  isNonLocomotionSense,
  validateMovementIntent,
} from "../../src/engine/validate/movement.js";
import {
  quotedSpeechEchoedVerbatim,
  validateNarrativePlaceholder,
} from "../../src/engine/validate/speech.js";
import { validateActingActorPresence } from "../../src/engine/validate/narrative.js";
import { makeTinyWorld, errorText } from "../helpers.js";
import type { Action, ActionSemantics } from "../../src/types.js";

function action(text: string): Action {
  return { actorId: "u", text };
}

/** Judged semantics as the LLM word-sense misses produced them (moves=true). */
function llmMovesSemantics(): ActionSemantics {
  return { moves: true, speaks: true, quotedSpeech: [] };
}

describe("exp2 #6 (S3): echo gate exempts fully-spoken actions", () => {
  it("verbatim quote of a fully-spoken action passes the echo gate (tick 7 repro)", () => {
    // Ana's welcome: the action IS the utterance, so the narrative quoting
    // it verbatim is correct rendering, not an echo.
    const text = `"Hi Jeff, welcome to the team!"`;
    expect(validateNarrativePlaceholder(text, action(text))).toEqual([]);
  });

  it("genuinely echoic non-speech narrative still fails", () => {
    const errors = validateNarrativePlaceholder(
      "Walk to Ana's desk.",
      action("Walk to Ana's desk."),
    );
    expect(errorText(errors)).toContain("narrative.echoes_action");
  });

  it("speech turn with a framed (non-verbatim) narrative is untouched by the echo gate", () => {
    const errors = validateNarrativePlaceholder(
      `Ana says "Hello there."`,
      action(`Say "Hello there."`),
    );
    expect(errors).toEqual([]);
  });

  it("quotedSpeechEchoedVerbatim detects verbatim action quotes in the narrative", () => {
    expect(
      quotedSpeechEchoedVerbatim(`Say "hello world"`, `She says "hello world" and smiles.`),
    ).toBe(true);
    expect(quotedSpeechEchoedVerbatim(`Say "hello world"`, `She says "goodbye world".`)).toBe(
      false,
    );
    // Non-speech turns keep the gate: no quoted segments, no exemption.
    expect(quotedSpeechEchoedVerbatim(`Walk to the desk.`, `Walk to the desk.`)).toBe(false);
    // Curly quotes canonicalize against straight ones (Exp-6 item 2).
    expect(quotedSpeechEchoedVerbatim(`Say \u201chello world\u201d`, `She says "hello world".`)).toBe(
      true,
    );
  });
});

describe("exp2 #8 (S4): interrogative questions are not sitting", () => {
  it("detects pure questions", () => {
    expect(isInterrogativeQuestion("Ana, could you show me where I should sit?")).toBe(true);
    expect(isInterrogativeQuestion("Thanks Ana! Where should I sit? Stay near her desk.")).toBe(
      true,
    );
  });

  it("does not exempt a question attached to a genuine walk clause", () => {
    expect(isInterrogativeQuestion("Walk to Ana and ask where I should sit?")).toBe(false);
  });

  it("does not fire on statements or on 'sit' inside other words", () => {
    expect(isInterrogativeQuestion("I walk to Dan.")).toBe(false);
    expect(isInterrogativeQuestion("Discuss the situation with Ana.")).toBe(false);
    expect(isInterrogativeQuestion("Sit down on the chair.")).toBe(false);
    expect(isNonLocomotionSense("Assess the situation carefully.")).toBe(false);
  });

  it("question turn with moves=true demands no position change (tick 9 repro)", () => {
    const world = makeTinyWorld();
    const errors = validateMovementIntent(
      world,
      { actorPatches: [] },
      action("Ana, where should I sit?"),
      llmMovesSemantics(),
    );
    expect(errors).toEqual([]);
  });
});

describe("exp2 #8 (S5): facing is not locomotion", () => {
  it("detects facing-only turns", () => {
    expect(isFacingOnlyTurn("I turn to Dan and apologize.")).toBe(true);
    expect(isFacingOnlyTurn("Turn toward Ana and introduce yourself.")).toBe(true);
    expect(isFacingOnlyTurn("Face the room and wave.")).toBe(true);
  });

  it("keeps locomotion when a step verb is present", () => {
    expect(isFacingOnlyTurn("I walk to Dan.")).toBe(false);
    expect(isFacingOnlyTurn("Turn to Dan and walk over.")).toBe(false);
    expect(isFacingOnlyTurn("Face the door and leave.")).toBe(false);
    // "return to" is locomotion, not "turn to" (word-boundary check).
    expect(isFacingOnlyTurn("Return to Dan.")).toBe(false);
  });

  it("facing turn with moves=true demands no position change (tick 12 repro)", () => {
    const world = makeTinyWorld();
    const errors = validateMovementIntent(
      world,
      { actorPatches: [] },
      action("I turn to Dan and apologize."),
      llmMovesSemantics(),
    );
    expect(errors).toEqual([]);
  });

  it("a facing turn that relocates is still an unexpected move", () => {
    const world = makeTinyWorld();
    const errors = validateMovementIntent(
      world,
      { actorPatches: [{ actorId: "u", x: 4, y: 4 }] },
      action("I turn to Dan and apologize."),
      llmMovesSemantics(),
    );
    expect(errorText(errors)).toContain("movement.unexpected_move");
  });

  it("genuine locomotion keeps moves=true ('I walk to Dan')", () => {
    const world = makeTinyWorld();
    const errors = validateMovementIntent(
      world,
      { actorPatches: [] },
      action("I walk to Dan."),
      llmMovesSemantics(),
    );
    expect(errorText(errors)).toContain("movement.no_position_change");
  });

  it("'sit down on the chair' keeps sit handling (no exemption)", () => {
    expect(isNonLocomotionSense("Sit down on the chair.")).toBe(false);
  });

  it("facing/speech turn needs no acting-actor patch", () => {
    const errors = validateActingActorPresence(
      { actorPatches: [] },
      action("I turn to Dan and apologize."),
      llmMovesSemantics(),
    );
    expect(errors).toEqual([]);
  });

  it("genuine locomotion still needs the acting-actor patch", () => {
    const errors = validateActingActorPresence(
      { actorPatches: [] },
      action("I walk to Dan."),
      llmMovesSemantics(),
    );
    expect(errorText(errors)).toContain("turn_discipline.acting_actor_not_patched");
  });
});
