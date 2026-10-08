// Regression tests for Experiment-2 items 5 (S2) and 7 (S1/S7), plus the
// coordinator follow-up (deterministic retry-feedback directive).
//
// S2: two fully-corrupt consequences passed `validateConsequence`
// outright in the Exp-2 run —
//   tick 10: "Ana: Jeff introduces Ana to Dan." for a silent coffee sip
//            (observer-as-subject hid behind the "Ana: " attribution
//            prefix, and "introduces" is missing from the validator's
//            verb list);
//   tick 11: "Dan walks into the conference room…" for "Stay where you
//            are" (self-declared effects.moved=true dodged
//            movement.unexpected_move through the merged-semantics OR-trust).
// The final accept gate (`recheckAcceptedProse`, wired into every accept
// path) must reject both; salvage must rebuild honest prose from the
// action text instead of keeping the corrupt narrative.
import { describe, expect, it } from "vitest";
import { validateConsequence } from "../../src/engine/physicalValidator.js";
import {
  buildRetryDirective,
  trySalvageConsequence,
} from "../../src/engine/turnSalvage.js";
import {
  findSupplementObserverSubject,
  isExplicitStayAction,
  pickBestAttempt,
  recheckAcceptedProse,
  stripAttributionPrefix,
  type AttemptRecord,
} from "../../src/engine/turnSalvageGates.js";
import { resolveWithValidation } from "../../src/engine/turnOrchestrator.js";
import { FALLBACK_CONSEQUENCE } from "../../src/llm/llmConsequenceEngine.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import { defaultConfig } from "../../src/config.js";
import { loadOfficeScenario, makeTestDeps } from "../helpers.js";
import type {
  ActionSemantics,
  ConsequenceResult,
  ValidationError,
  World,
} from "../../src/types.js";

function stillSemantics(): ActionSemantics {
  return { moves: false, speaks: false, quotedSpeech: [] };
}

function officeWorld(): World {
  const world = loadOfficeScenario();
  // Exp-2 tick-10/11 positions: Ana near her desk, Dan across the room.
  world.actors.find((a) => a.id === "ana")!.x = 7;
  world.actors.find((a) => a.id === "ana")!.y = 8;
  world.actors.find((a) => a.id === "dan")!.x = 15;
  world.actors.find((a) => a.id === "dan")!.y = 8;
  return world;
}

function err(code: string, message = "m"): ValidationError {
  return { code, message };
}

describe("exp2-5 S2 final accept gate: tick-10 wrong-subject narrative", () => {
  const action = { actorId: "ana", text: "Take a quiet sip of coffee." };
  const corrupt: ConsequenceResult = {
    narrative: "Ana: Jeff introduces Ana to Dan.",
    actorPatches: [
      { actorId: "ana", thoughts: "Sipping coffee." },
      { actorId: "jeff", thoughts: "Glad to meet everyone." },
      { actorId: "dan", thoughts: "Sizing up the new hire." },
    ],
    objectPatches: [],
    reasoning: "r",
  };

  it("rejects the Jeff-subject narrative for a silent sip action", () => {
    const world = officeWorld();
    // Sanity: the base validator really does pass this (the S2 hole) —
    // the final gate is what must catch it.
    expect(validateConsequence(world, corrupt, action, stillSemantics()).valid).toBe(true);
    const gateErrors = recheckAcceptedProse(world, action, corrupt);
    expect(gateErrors.some((e) => e.code === "narrative.observer_as_subject")).toBe(true);
  });

  it("also catches the unprefixed form (introduces not in the validator verb list)", () => {
    const world = officeWorld();
    const noPrefix = { ...corrupt, narrative: "Jeff introduces Ana to Dan." };
    const gateErrors = recheckAcceptedProse(world, action, noPrefix);
    expect(gateErrors.some((e) => e.code === "narrative.observer_as_subject")).toBe(true);
  });

  it("salvage rebuilds honest prose from the action text instead of keeping it", () => {
    const world = officeWorld();
    const salvaged = trySalvageConsequence(world, action, corrupt, stillSemantics());
    expect(salvaged).not.toBeNull();
    expect(salvaged!.salvaged.narrative).not.toContain("Jeff introduces");
    expect(salvaged!.salvaged.narrative.toLowerCase()).toContain("sip");
  });

  it("does not false-positive on clean prose with observer landmarks", () => {
    const world = officeWorld();
    const clean: ConsequenceResult = {
      ...corrupt,
      narrative: "Ana takes a quiet sip of her coffee, watching Jeff and Dan.",
      actorPatches: [{ actorId: "ana", thoughts: "Good coffee." }],
    };
    expect(recheckAcceptedProse(world, action, clean)).toEqual([]);
  });

  it("does not false-positive on possessives", () => {
    const world = officeWorld();
    const possessive = { ...corrupt, narrative: "Ana: Jeff's desk is cluttered today." };
    expect(recheckAcceptedProse(world, action, possessive)).toEqual([]);
  });
});

describe("exp2-5 S2 final accept gate: tick-11 stay-action teleport", () => {
  const action = { actorId: "dan", text: "Stay where you are." };
  function teleport(): { world: World; corrupt: ConsequenceResult } {
    const world = officeWorld();
    const dan = world.actors.find((a) => a.id === "dan")!;
    const corrupt: ConsequenceResult = {
      narrative: "Dan walks into the conference room and greets everyone.",
      actorPatches: [{ actorId: "dan", x: dan.x - 3, y: dan.y, thoughts: "Time to mingle." }],
      objectPatches: [],
      reasoning: "r",
      // The OR-trust dodge: the consequence declares moved=true.
      effects: { moved: true, spoke: false, quotedSpeech: [] },
    };
    return { world, corrupt };
  }

  it("rejects movement on an explicit stay action, even with effects.moved=true", () => {
    const { world, corrupt } = teleport();
    expect(isExplicitStayAction(action.text)).toBe(true);
    // Sanity: with the self-declared effects the base validator passes (the S2 hole).
    const movedSemantics: ActionSemantics = { moves: true, speaks: false, quotedSpeech: [] };
    expect(validateConsequence(world, corrupt, action, movedSemantics).valid).toBe(true);
    const gateErrors = recheckAcceptedProse(world, action, corrupt);
    expect(gateErrors.some((e) => e.code === "movement.unexpected_move")).toBe(true);
  });

  it("salvage refuses the stay-teleport (no honest movement to keep)", () => {
    const { world, corrupt } = teleport();
    const movedSemantics: ActionSemantics = { moves: true, speaks: false, quotedSpeech: [] };
    expect(trySalvageConsequence(world, action, corrupt, movedSemantics)).toBeNull();
  });

  it("end-to-end: the retry loop never applies the stay-teleport narrative", async () => {
    const logger = createTestLogger();
    const world = officeWorld();
    const dan = world.actors.find((a) => a.id === "dan")!;
    const scripted: ConsequenceResult = {
      narrative: "Dan walks into the conference room and greets everyone.",
      actorPatches: [{ actorId: "dan", x: dan.x - 3, y: dan.y, thoughts: "Time to mingle." }],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: true, spoke: false, quotedSpeech: [] },
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: new MockConsequenceEngine(logger, {
        "stay where you are.": scripted,
      }),
      config: { ...defaultConfig, autosaveEnabled: false, maxRetries: 1 },
    });
    const out = await resolveWithValidation(world, action, deps);
    expect(out.narrative).toBe(FALLBACK_CONSEQUENCE.narrative);
    expect(out.narrative).not.toContain("conference room");
    // Dan never moved.
    expect(world.actors.find((a) => a.id === "dan")!.x).toBe(15);
  });
});

describe("exp2-5 attribution prefix stripping", () => {
  it("strips the acting actor's Name: prefix, never an observer's", () => {
    expect(stripAttributionPrefix("Ana: Jeff introduces Ana to Dan.", "Ana", "ana")).toBe(
      "Jeff introduces Ana to Dan.",
    );
    expect(stripAttributionPrefix("ana - takes a sip.", "Ana", "ana")).toBe("takes a sip.");
    expect(stripAttributionPrefix("Jeff: hello there.", "Ana", "ana")).toBe(
      "Jeff: hello there.",
    );
    expect(stripAttributionPrefix("Ana stands up.", "Ana", "ana")).toBe("Ana stands up.");
  });

  it("the stripped narrative exposes observer subjects to the validator list too", () => {
    const world = officeWorld();
    const action = { actorId: "ana", text: "Take a quiet sip of coffee." };
    // "greets" IS in the validator's verb list — the only hole was the prefix.
    const errors = findSupplementObserverSubject(
      world,
      stripAttributionPrefix("Ana: Jeff greets Dan.", "Ana", "ana"),
      action,
    );
    expect(errors.some((e) => e.code === "narrative.observer_as_subject")).toBe(true);
  });
});

describe("exp2-7 pickBestAttempt (S7)", () => {
  function rec(attempt: number, hardErrors: number): AttemptRecord {
    return {
      result: { narrative: `n${attempt}`, actorPatches: [], objectPatches: [] },
      semantics: stillSemantics(),
      hardErrors,
      attempt,
    };
  }

  it("picks the attempt with the fewest hard errors, not the last", () => {
    const attempts = [rec(1, 1), rec(2, 4), rec(3, 3)];
    expect(pickBestAttempt(attempts)!.attempt).toBe(1);
  });

  it("breaks ties toward the earliest attempt (retry divergence)", () => {
    const attempts = [rec(1, 2), rec(2, 1), rec(3, 1)];
    expect(pickBestAttempt(attempts)!.attempt).toBe(2);
  });

  it("returns undefined for no attempts", () => {
    expect(pickBestAttempt([])).toBeUndefined();
  });
});

describe("exp2-7 salvage never implants thoughts naming stripped actors (S1/S7)", () => {
  it("sanitizes thoughts that mention a stripped actor id", () => {
    const world = officeWorld();
    const action = { actorId: "ana", text: "Take a quiet sip of coffee." };
    const result: ConsequenceResult = {
      narrative: "Ana: takes a quiet sip of coffee.",
      actorPatches: [
        { actorId: "ana", thoughts: "Liam is late again, whatever." },
        { actorId: "liam", thoughts: "Hello everyone." },
      ],
      objectPatches: [],
      reasoning: "r",
    };
    const salvaged = trySalvageConsequence(world, action, result, stillSemantics());
    expect(salvaged).not.toBeNull();
    const ana = salvaged!.salvaged.actorPatches.find((p) => p.actorId === "ana")!;
    expect(ana.thoughts).not.toMatch(/liam/i);
    expect(salvaged!.salvaged.actorPatches.some((p) => p.actorId === "liam")).toBe(false);
  });

  it("salvaged narrative re-checks observer-subject after stripping", () => {
    const world = officeWorld();
    const action = { actorId: "ana", text: "Take a quiet sip of coffee." };
    const result: ConsequenceResult = {
      narrative: "Ana: Jeff greets Dan.",
      actorPatches: [
        { actorId: "ana", thoughts: "Sipping." },
        { actorId: "liam", thoughts: "Hi." },
      ],
      objectPatches: [],
      reasoning: "r",
    };
    const salvaged = trySalvageConsequence(world, action, result, stillSemantics());
    expect(salvaged).not.toBeNull();
    // The corrupt prose was rebuilt from the action text, not kept.
    expect(salvaged!.salvaged.narrative).not.toContain("Jeff greets");
    expect(salvaged!.salvaged.narrative.toLowerCase()).toContain("sip");
  });
});

describe("coordinator follow-up: deterministic retry-feedback directive (M4)", () => {
  it("ranks hard gates above tier-2 wording above speech nits", () => {
    const d = buildRetryDirective([
      err("speech.dropped_words", "dropped quote"),
      err("movement.over_step_cap", "moved 13 cells"),
    ]);
    expect(d).toContain("[movement.over_step_cap]");
    expect(d).not.toContain("speech.dropped_words");
  });

  it("ranks tier-2 wording above speech nits", () => {
    const d = buildRetryDirective([
      err("speech.dropped_words", "dropped quote"),
      err("object_grounding.sip_no_prop", "sip without prop"),
    ]);
    expect(d).toContain("[object_grounding.sip_no_prop]");
  });

  it("emits a single line with the fix-first directive", () => {
    const d = buildRetryDirective([err("actor.unknown_id", "unknown actor id: liam\nsecond line")]);
    expect(d.startsWith("Fix this first: [actor.unknown_id]")).toBe(true);
    expect(d).not.toContain("\n");
  });

  it("keeps original order among equal severity (stable)", () => {
    const d = buildRetryDirective([
      err("actor.out_of_bounds", "first"),
      err("actor.blocked_position", "second"),
    ]);
    expect(d).toContain("[actor.out_of_bounds]");
  });

  it("handles the empty case", () => {
    expect(buildRetryDirective([])).toContain("[unknown]");
  });
});
