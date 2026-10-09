// Regression tests for Experiment-3 action items implemented on the
// laya-exp3-fixes branch:
//
// Item 6 (S3):
//   - tick-20 repro: "Dana approaches Tanya's desk and greets her:
//     'Good morning, Tanya. I'm Dana, the new hire.'" applied via salvage
//     with patches intact — no gate fired. The identity-consistency gate
//     must reject it in validateConsequence AND in recheckAcceptedProse.
//   - the speech.invented_dialogue short-greeting escape must not admit
//     arbitrarily long invented quotes.
// Item 3 (S4):
//   - tick-19 repro: Tanya's test-plan offer died 3× on
//     speech.dropped_words; salvage must reinsert the dropped quotes
//     deterministically instead of downgrading to warnings.
// Item 10 (S8):
//   - tick-3 repro: "Giving Dana the pen she requested" — thought-grounding
//     must reject invented people and ungrounded request/grant claims.
// Items 1+4 (model-side):
//   - roster-discipline line bans new proper nouns; proposal/selection
//     suffixes carry the RENDERABILITY line.
import { describe, expect, it } from "vitest";
import { validateConsequence } from "../../src/engine/physicalValidator.js";
import {
  validateIdentityConsistency,
  validateStateLabel,
  validateThoughtGrounding,
} from "../../src/engine/validate/narrative.js";
import { validateSitPoseSeating } from "../../src/engine/validate/objects.js";
import { describePosition } from "../../src/engine/patchApplier.js";
import { suggestionCore } from "../../src/engine/contextBuilder.js";
import { consecutiveIntentFailures } from "../../src/engine/turnLiveness.js";
import {
  fuzzyMatchObjectId,
  rankDestinationObjects,
  resolveDestinationObjectId,
} from "../../src/engine/deterministicSemantics.js";
import { computeMovementOutcome } from "../../src/core/movement.js";
import { validateSpeechPreservation } from "../../src/engine/validate/speech.js";
import { trySalvageConsequence } from "../../src/engine/turnSalvage.js";
import { recheckAcceptedProse } from "../../src/engine/turnSalvageGates.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { buildRosterDisciplineLine } from "../../src/llm/rosterDiscipline.js";
import { proposalSuffix, selectionSuffix } from "../../src/llm/prompts.js";
import { NOT_DONE_SENTINEL } from "../../src/types.js";
import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  World,
} from "../../src/types.js";

function antonWorld(): World {
  return loadScenario({
    version: 1,
    id: "office-anton-test",
    title: "Office: Anton is a new coworker",
    narrative: "Anton enters through the north door of the office on his first day.",
    userActorId: "anton",
    order: ["anton", "tanya", "dana"],
    scene: { width: 20, height: 20, objects: [] },
    actors: [
      {
        id: "anton", name: "Anton", persona: "New backend hire.", x: 16, y: 2,
        state: "standing near the entrance", emotion: "nervous",
        goal: "Introduce himself to Tanya and Dana, find his desk, and settle in for his first day.",
        memories: [], beliefs: [], relationships: [],
      },
      {
        id: "tanya", name: "Tanya", persona: "QA engineer.", x: 8, y: 7,
        state: "sitting at her desk", emotion: "focused",
        goal: "Finish a small testing task before lunch and help Anton settle in.",
        memories: [], beliefs: [], relationships: [],
      },
      {
        id: "dana", name: "Dana", persona: "Recruiter.", x: 15, y: 11,
        state: "sitting at his desk", emotion: "stressed",
        goal: "Finish screening candidates for the urgent backend req before the deadline.",
        memories: [], beliefs: [], relationships: [],
      },
    ],
  });
}

function silentSemantics(): ActionSemantics {
  return { moves: false, speaks: false, quotedSpeech: [] };
}

describe("exp3-6 S3 identity-consistency gate: tick-20 repro", () => {
  const action: Action = {
    actorId: "dana",
    text: "Grab a fresh notebook page to jot down notes while reviewing the final candidates.",
  };
  const theft: ConsequenceResult = {
    narrative: "Dana approaches Tanya's desk and greets her: 'Good morning, Tanya. I'm Dana, the new hire.'",
    actorPatches: [
      { actorId: "dana", thoughts: "Hope Tanya is friendly.", x: 15, y: 14 },
      { actorId: "tanya", thoughts: "A new face, wow." },
    ],
    objectPatches: [],
    reasoning: "r",
    effects: { moved: true, spoke: true, quotedSpeech: [] },
  };

  it("rejects 'I'm Dana, the new hire' on Dana's turn (Anton is the newcomer)", () => {
    const world = antonWorld();
    const errors = validateIdentityConsistency(world, theft.narrative, action);
    expect(errors.some((e) => e.code === "narrative.identity_theft")).toBe(true);
  });

  it("fires inside validateConsequence (retry-loop path), not only the accept gate", () => {
    const world = antonWorld();
    // Patches are valid on their own — the S3 hole was prose-only.
    const result = validateConsequence(world, theft, action, {
      moves: true, speaks: true, quotedSpeech: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "narrative.identity_theft")).toBe(true);
  });

  it("fires inside recheckAcceptedProse (every accept path)", () => {
    const world = antonWorld();
    const gateErrors = recheckAcceptedProse(world, action, theft);
    expect(gateErrors.some((e) => e.code === "narrative.identity_theft")).toBe(true);
  });

  it("rejects claiming another roster actor's name ('I'm Tanya' on Dana's turn)", () => {
    const world = antonWorld();
    const errors = validateIdentityConsistency(
      world,
      "Dana grins: 'I'm Tanya, nice to meet you.'",
      action,
    );
    expect(errors.some((e) => e.code === "narrative.identity_theft")).toBe(true);
  });

  it("allows self-introduction ('I'm Dana' on Dana's turn)", () => {
    const world = antonWorld();
    const errors = validateIdentityConsistency(
      world,
      "Dana smiles: 'Hi, I'm Dana, the recruiter.'",
      action,
    );
    expect(errors).toEqual([]);
  });

  it("allows the actual newcomer to claim the role ('I'm the new hire' on Anton's turn)", () => {
    const world = antonWorld();
    const antonAction: Action = { actorId: "anton", text: "Introduce yourself to the room." };
    const errors = validateIdentityConsistency(
      world,
      "Anton waves: 'Hi everyone, I'm the new hire.'",
      antonAction,
    );
    expect(errors).toEqual([]);
  });

  it("does not punish obedience — action text scripts the line", () => {
    const world = antonWorld();
    const scripted: Action = {
      actorId: "dana",
      text: "As a joke, say 'I'm the new hire around here'.",
    };
    const errors = validateIdentityConsistency(
      world,
      "Dana chuckles: 'I'm the new hire around here.'",
      scripted,
    );
    expect(errors).toEqual([]);
  });
});

describe("exp3-6 S3 invented_dialogue escape bound", () => {
  it("rejects long invented quotes when the judge found no action quotes", () => {
    // Tick-20 shape: speaks=true, quotedSpeech=[] (judge misfire), long
    // invented quote in the narrative.
    const errors = validateSpeechPreservation(
      { moves: false, speaks: true, quotedSpeech: [] },
      "Dana approaches Tanya's desk and greets her: 'Good morning, Tanya. I'm Dana, the new hire.'",
    );
    expect(errors.some((e) => e.code === "speech.invented_dialogue")).toBe(true);
  });

  it("still allows short greeting renders ('Say hello' -> 'Hi!')", () => {
    const errors = validateSpeechPreservation(
      { moves: false, speaks: true, quotedSpeech: [] },
      "Anton waves and says 'Hi!'",
    );
    expect(errors).toEqual([]);
  });

  it("still allows 'Good morning' (short, 2 content words)", () => {
    const errors = validateSpeechPreservation(
      { moves: false, speaks: true, quotedSpeech: [] },
      "Dana nods: 'Good morning.'",
    );
    expect(errors).toEqual([]);
  });

  it("treats a verbatim action-text quote as grounded (fully-spoken action, golden-test shape)", () => {
    const errors = validateSpeechPreservation(
      { moves: false, speaks: true, quotedSpeech: [] },
      "Jeff speaks aloud to the office: \"Hey guys, I'm a new team member, my name is Jeff!\"",
      "Hey guys, I'm a new team member, my name is Jeff!",
    );
    expect(errors).toEqual([]);
  });
});

describe("exp3-3 S4 deterministic quote reinsertion: tick-19 repro", () => {
  const action: Action = {
    actorId: "tanya",
    text: "I gesture to my laptop on the desk as I say to Anton, 'Feel free to take a look at my current test plan if you'd like to get familiar with our workflows.'",
  };
  // Best attempt: valid patches, narrative dropped the quote.
  const dropped: ConsequenceResult = {
    narrative: "Tanya gestures to her laptop.",
    actorPatches: [
      { actorId: "tanya", thoughts: "He seems eager." },
      { actorId: "anton", thoughts: "A test plan, nice." },
    ],
    objectPatches: [],
    reasoning: "r",
    effects: { moved: false, spoke: true, quotedSpeech: [] },
  };

  it("reinserts the dropped quote deterministically instead of downgrading", () => {
    const world = antonWorld();
    const semantics: ActionSemantics = {
      moves: false,
      speaks: true,
      quotedSpeech: [
        "Feel free to take a look at my current test plan if you'd like to get familiar with our workflows.",
      ],
      addresseeActorId: "anton",
    };
    const salvaged = trySalvageConsequence(world, action, dropped, semantics);
    expect(salvaged).not.toBeNull();
    // The repair is marked honestly: valid turn, engine-intervened prose.
    expect(salvaged!.warnings.some((w) => w.code === "salvage.quote_reinserted")).toBe(true);
    expect(salvaged!.salvaged.narrative).toContain(
      "Feel free to take a look at my current test plan",
    );
    // The model's frame is preserved, quote appended.
    expect(salvaged!.salvaged.narrative).toContain("gestures to her laptop");
    // Fully valid — the warning is the honest-history marker, not a gate failure.
    expect(
      validateConsequence(world, salvaged!.salvaged, action, semantics).valid,
    ).toBe(true);
  });

  it("does not invent quotes when the action has none", () => {
    const world = antonWorld();
    const noQuoteAction: Action = { actorId: "tanya", text: "Take a quiet sip of coffee." };
    const candidate: ConsequenceResult = {
      narrative: "Tanya sips her coffee.",
      actorPatches: [{ actorId: "tanya", thoughts: "Good." }],
      objectPatches: [],
      reasoning: "r",
    };
    const salvaged = trySalvageConsequence(world, noQuoteAction, candidate, silentSemantics());
    expect(salvaged).not.toBeNull();
    expect(salvaged!.salvaged.narrative).toBe("Tanya sips her coffee.");
  });
});

describe("exp3-10 S8 thought grounding", () => {
  const action: Action = { actorId: "anton", text: "Ask Tanya where to sit." };

  it("rejects thoughts naming invented people", () => {
    const world = antonWorld();
    const errors = validateThoughtGrounding(world, action, {
      narrative: "Anton asks Tanya where to sit.",
      actorPatches: [{ actorId: "anton", thoughts: "Another day, same Leon." }],
    });
    expect(errors.some((e) => e.code === "thoughts.unknown_proper_noun")).toBe(true);
  });

  it("rejects ungrounded request claims (tick-3 repro)", () => {
    const world = antonWorld();
    const errors = validateThoughtGrounding(world, action, {
      narrative: "Anton stands nearby.",
      actorPatches: [{ actorId: "anton", thoughts: "Giving Dana the pen she requested." }],
    });
    expect(errors.some((e) => e.code === "thoughts.ungrounded_claim")).toBe(true);
  });

  it("accepts the claim when history supports it", () => {
    const world = antonWorld();
    world.history.push({ text: "Dana: Dana asks Anton for a pen.", perceivers: ["dana", "anton"] });
    const errors = validateThoughtGrounding(world, action, {
      narrative: "Anton stands nearby.",
      actorPatches: [{ actorId: "anton", thoughts: "Giving Dana the pen she requested." }],
    });
    expect(errors).toEqual([]);
  });

  it("passes clean thoughts", () => {
    const world = antonWorld();
    const errors = validateThoughtGrounding(world, action, {
      narrative: "Anton asks Tanya where to sit.",
      actorPatches: [{ actorId: "anton", thoughts: "Hope she points me to my desk." }],
    });
    expect(errors).toEqual([]);
  });

  it("fires inside validateConsequence", () => {
    const world = antonWorld();
    const result = validateConsequence(
      world,
      {
        narrative: "Anton asks Tanya where to sit.",
        actorPatches: [{ actorId: "anton", thoughts: "Giving Dana the pen she requested." }],
        objectPatches: [],
        reasoning: "r",
      },
      action,
      { moves: false, speaks: true, quotedSpeech: [], addresseeActorId: "tanya" },
    );
    expect(result.errors.some((e) => e.code === "thoughts.ungrounded_claim")).toBe(true);
  });
});

describe("exp3 model-side items 1+4: prompt lines", () => {
  it("roster-discipline line bans new proper nouns (item 1)", () => {
    const line = buildRosterDisciplineLine(["anton", "tanya", "dana"]);
    expect(line).toContain("Leon");
    expect(line).toMatch(/proper noun/i);
    expect(line).toContain('"anton", "tanya", "dana"');
  });

  it("proposal suffix carries the RENDERABILITY line (item 4)", () => {
    expect(proposalSuffix()).toMatch(/RENDERABILITY/);
  });

  it("selection suffix carries the RENDERABILITY line (item 4)", () => {
    expect(selectionSuffix()).toMatch(/RENDERABILITY/);
  });
});

describe("exp3 item 6 (S2): per-intent failure memory", () => {
  it("suggestionCore keys chair-push as push|chair (not other|)", () => {
    const world = antonWorld();
    expect(suggestionCore(world, "Push the chair in neatly.", "dana")).toBe("push|chair");
    expect(suggestionCore(world, "Shake Anton's hand warmly.", "tanya")).toBe("shake|anton");
  });

  it("consecutiveIntentFailures counts per-intent streaks from history", () => {
    const world = antonWorld();
    const tanya = world.actors.find((a) => a.id === "tanya")!;
    const fail = (text: string): string =>
      `${tanya.name} tried: ${text} (not done)${NOT_DONE_SENTINEL}`;
    world.history.push(
      { text: fail("Shake Anton's hand warmly."), tick: 1, turnIndex: 0 } as never,
      { text: fail("Offer Anton a firm handshake."), tick: 2, turnIndex: 1 } as never,
      // Interleaved other-actor turn does not break the streak.
      { text: "Dana: Dana reviews resumes.", tick: 3, turnIndex: 2 } as never,
      { text: fail("Push the chair in neatly."), tick: 4, turnIndex: 3 } as never,
    );
    expect(consecutiveIntentFailures(world, "tanya", "shake|anton")).toBe(2);
    expect(consecutiveIntentFailures(world, "tanya", "push|chair")).toBe(1);
    expect(consecutiveIntentFailures(world, "tanya", "greet|anton")).toBe(0);
    // An applied own turn breaks the streak.
    world.history.push({ text: "Tanya: Tanya walks to the lounge.", tick: 5, turnIndex: 4 } as never);
    expect(consecutiveIntentFailures(world, "tanya", "shake|anton")).toBe(0);
  });
});

describe("exp3 item 7 (S5): movement destination fixes", () => {
  function deskWorld(): World {
    const world = antonWorld();
    world.scene.objects.push(
      { id: "anton_desk", name: "Anton's desk", description: "d", x: 3, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false },
      { id: "tanya_desk", name: "Tanya's desk", description: "d", x: 7, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false },
      { id: "anton_chair", name: "Anton's chair", description: "c", x: 4, y: 7, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    );
    return world;
  }

  it("tick-24 repro: 'my chair … waiting for her to show me' scopes to MY objects", () => {
    const world = deskWorld();
    const candidates = world.scene.objects.map((o) => ({
      id: o.id, name: o.name, x: o.x, y: o.y, w: o.w, h: o.h,
    }));
    const picked = rankDestinationObjects(
      world,
      candidates,
      "Sit down on my chair at my new desk and look at Tanya, waiting for her to show me the test plan.",
      "anton",
      "walk",
    );
    // "her" is a bare object pronoun, not a possessive of "desk" — it must
    // not hijack ownership from "my".
    expect(picked).toBe("anton_chair");
  });

  it("third-person attached possessive still scopes correctly ('his desk' → anton's)", () => {
    const world = deskWorld();
    // End-to-end through the real resolver (explicit clause match first,
    // then the possessive-ranked fallback).
    const picked = resolveDestinationObjectId(
      world,
      "Lead Anton toward his desk.",
      "tanya",
    );
    expect(picked).toBe("anton_desk");
  });

  it("tick-28 repro: the engine always steps toward the narrative's approach target", () => {
    // Phase 1: the veto-away-from-narrative-target machinery is deleted.
    // The engine computes movement directly from the resolved destination,
    // so a step AWAY from the target is impossible by construction.
    const world = deskWorld();
    const anton = world.actors.find((a) => a.id === "anton")!;
    anton.x = 14; anton.y = 7;
    const tanya = world.actors.find((a) => a.id === "tanya")!;
    tanya.x = 11; tanya.y = 6;
    // "Tanya walks over to Anton and greets him warmly, offering her hand."
    // resolves destinationActorId=anton; the engine step must be strictly
    // closer to Anton (the old vetoed repair suggested (8,10): 1.0 → 4.2).
    const o = computeMovementOutcome(world, "tanya", { destinationActorId: "anton" });
    expect(o).not.toBeNull();
    const oldDist = Math.hypot(11 - 14, 6 - 7);
    expect(Math.hypot(o!.x - 14, o!.y - 7)).toBeLessThan(oldDist);
  });

  it("fuzzyMatchObjectId resolves unambiguous invented ids, rejects ambiguous ones", () => {
    const world = deskWorld();
    world.scene.objects.push(
      { id: "tanya_laptop", name: "Tanya's laptop", description: "l", x: 7, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
      { id: "coffee_mug", name: "Coffee mug", description: "m", x: 2, y: 1, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    );
    expect(fuzzyMatchObjectId("tanya's laptop", world)).toBe("tanya_laptop");
    expect(fuzzyMatchObjectId("the coffee cup", world)).toBe("coffee_mug");
    // "anton's coffee cup" is unambiguous here (no anton-owned mug) →
    // coffee_mug is the reasonable match.
    expect(fuzzyMatchObjectId("anton's coffee cup", world)).toBe("coffee_mug");
    // Genuinely ambiguous: "the desk" matches anton_desk and tanya_desk
    // equally → undefined, the id is dropped rather than guessed.
    expect(fuzzyMatchObjectId("the desk", world)).toBeUndefined();
    expect(fuzzyMatchObjectId("the thingamajig", world)).toBeUndefined();
  });
});

describe("exp3 item 8 (S6): state labels and sit pose", () => {
  function chairWorld(): World {
    const world = antonWorld();
    world.scene.objects.push(
      { id: "tanya_desk", name: "Tanya's desk", description: "d", x: 7, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false },
      { id: "tanya_mug", name: "Tanya's mug", description: "m", x: 7, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
      { id: "tanya_chair", name: "Tanya's chair", description: "c", x: 8, y: 7, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
      { id: "dana_desk_sign", name: "Dana's desk sign", description: "s", x: 14, y: 12, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    );
    return world;
  }

  it("describePosition: possessives keep caps, no stacked article; at vs near", () => {
    const world = chairWorld();
    // (8,9): 1.4 from tanya_desk center (8.5,9) → "at"; possessive, no "the".
    expect(describePosition(world, 8, 9)).toBe("at Tanya's desk");
    // Signs are never landmarks: standing ON dana_desk_sign (14,12) does
    // not label "near the dana's desk sign" — and with tanya_desk 6.3
    // cells away (outside the radius), the label falls back to coords.
    expect(describePosition(world, 14, 12)).toBe("at (14, 12)");
    // Furniture tier beats props: (6,9) is 1.6 from tanya_mug but the
    // desk wins the furniture tier at 2.5 cells.
    expect(describePosition(world, 6, 9)).toBe("near Tanya's desk");
    // Nothing within 6 → coordinates.
    expect(describePosition(world, 0, 0)).toBe("at (0, 0)");
  });

  it("describePosition prefers the action's named destination object", () => {
    const world = chairWorld();
    world.scene.objects.push(
      { id: "coffee_machine", name: "Coffee machine", description: "m", x: 2, y: 1, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
      { id: "water_cooler", name: "Water cooler", description: "w", x: 5, y: 1, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false },
    );
    // Standing nearer the cooler but walking to the machine → machine wins.
    expect(describePosition(world, 4, 2, "coffee_machine")).toBe("at the coffee machine");
  });

  it("validateSitPoseSeating: tick-11 repro — sit far from any chair is rejected", () => {
    const world = chairWorld();
    const dana = world.actors.find((a) => a.id === "dana")!;
    dana.x = 13; dana.y = 11;
    const action: Action = { actorId: "dana", text: "Sit at her desk and organize papers." };
    const bad = validateSitPoseSeating(
      world,
      { actorPatches: [{ actorId: "dana", x: 12, y: 11, pose: "sit" }] },
      action,
    );
    expect(bad.some((e) => e.code === "pose.sit_no_chair")).toBe(true);
    // Next to the chair → clean.
    const tanya = world.actors.find((a) => a.id === "tanya")!;
    tanya.x = 8; tanya.y = 8;
    const good = validateSitPoseSeating(
      world,
      { actorPatches: [{ actorId: "tanya", x: 8, y: 7, pose: "sit" }] },
      { actorId: "tanya", text: "Sit down." },
    );
    expect(good).toEqual([]);
  });

  it("validateStateLabel: stacked article on possessive is rejected", () => {
    const world = chairWorld();
    const errors = validateStateLabel(
      world,
      { actorPatches: [{ actorId: "tanya", x: 8, y: 9, state: "near the tanya's mug" }] },
      { actorId: "tanya", text: "Look at the mug." },
    );
    expect(errors.some((e) => e.code === "state.grammar_stacked_article")).toBe(true);
    const clean = validateStateLabel(
      world,
      { actorPatches: [{ actorId: "tanya", x: 8, y: 9, state: "at Tanya's desk" }] },
      { actorId: "tanya", text: "Sit at the desk." },
    );
    expect(clean).toEqual([]);
  });
});

describe("exp3 item 5 (S3): identity gate in salvage prose rebuild", () => {
  it("tick-20 repro: salvage rebuilds prose from the action text instead of falling back", () => {
    const world = antonWorld();
    const action: Action = {
      actorId: "dana",
      text: "Grab a fresh notebook page to jot down notes while reviewing the final candidates.",
    };
    const corrupt: ConsequenceResult = {
      narrative:
        "Dana approaches Tanya's desk and greets her: 'Good morning, Tanya. I'm Dana, the new hire.'",
      actorPatches: [
        { actorId: "dana", x: 14, y: 11, thoughts: "Time to review candidates." },
        { actorId: "tanya", thoughts: "Dana seems friendly." },
      ],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: true, spoke: true, addresseeActorId: "tanya" },
    };
    const semantics: ActionSemantics = {
      moves: true,
      speaks: true,
      quotedSpeech: [],
      addresseeActorId: "tanya",
    };
    const out = trySalvageConsequence(world, action, corrupt, semantics);
    // The prose gate must catch the identity theft and rebuild from the
    // action text — the turn advances honestly instead of dying.
    expect(out).not.toBeNull();
    expect(out!.salvaged.narrative).not.toMatch(/new hire/i);
    expect(out!.salvaged.narrative).toMatch(/notebook/i);
  });
});
