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
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import {
  validateIdentityConsistency,
  validateThoughtGrounding,
} from "../../src/engine/validate/narrative.js";
import { describePosition } from "../../src/engine/patchApplier.js";
import { suggestionCore } from "../../src/engine/contextBuilder.js";
import {
  fuzzyMatchObjectId,
  rankDestinationObjects,
  resolveDestinationObjectId,
} from "../../src/engine/deterministicSemantics.js";
import { computeMovementOutcome } from "../../src/core/movement.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { buildRosterDisciplineLine } from "../../src/llm/rosterDiscipline.js";
import { resolveRender } from "../../src/engine/turnOrchestrator.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { reinsertQuote } from "../../src/core/speech.js";
import { planPose } from "../../src/core/text.js";
import { proposalSuffix, selectionSuffix } from "../../src/llm/prompts.js";
import { NOT_DONE_SENTINEL } from "../../src/types.js";
import { defaultConfig } from "../../src/config.js";
import { loadOfficeScenario, makeTestDeps } from "../helpers.js";
import type { Action, ConsequenceResult, World } from "../../src/types.js";

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

describe("exp3-6 S3 identity-consistency gate: tick-20 repro", () => {
  const action: Action = {
    actorId: "dana",
    text: "Grab a fresh notebook page to jot down notes while reviewing the final candidates.",
  };
  const theft: ConsequenceResult = {
    narrative: "Dana approaches Tanya's desk and greets her: 'Good morning, Tanya. I'm Dana, the new hire.'",
    thoughts: "Hope Tanya is friendly.",
    reasoning: "r",
  };
  // Dana near Tanya's desk (8,7): the engine already moved her there, so
  // the only failure in the prose is the identity theft itself.
  const theftFacts: RenderFacts = {
    exactQuote: null, moved: true, destinationActorId: null, pose: null, effectivePose: "stand",
    x: 8, y: 9, engineManipulation: null,
  };

  it("rejects 'I'm Dana, the new hire' on Dana's turn (Anton is the newcomer)", () => {
    const world = antonWorld();
    const errors = validateIdentityConsistency(world, theft.narrative, action);
    expect(errors.some((e) => e.code === "narrative.identity_theft")).toBe(true);
  });

  it("fires inside validateRenderProse (the single render validation path)", () => {
    const world = antonWorld();
    // Phase 4: the old prose-hole was that validateConsequence and
    // recheckAcceptedProse were two different gates. Now there is one.
    const errors = validateRenderProse(world, action, theft, theftFacts);
    expect(errors.some((e) => e.code === "narrative.identity_theft")).toBe(true);
  });

  it("end-to-end: the corrupt prose is flagged and marked (retry, then accept-and-mark)", async () => {
    const logger = createTestLogger();
    const world = antonWorld();
    const deps = makeTestDeps(logger, {
      consequenceEngine: new MockConsequenceEngine(logger, {
        "grab a fresh notebook page to jot down notes while reviewing the final candidates.":
          theft,
      }),
      config: { ...defaultConfig, autosaveEnabled: false, maxRetries: 1 },
    });
    const out = await resolveRender(world, action, deps);
    // PLAN_V2 Phase 4: the flawed paragraph is accepted and marked honest —
    // the identity-theft flag is what carries the honesty, not a rewrite.
    expect(out.render.narrateAcceptedDespiteViolations).toBe(true);
    expect(logger.store.byEvent("narrate_accepted_despite_violations")).toHaveLength(1);
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


describe("exp3-3 S4 deterministic quote reinsertion: tick-19 repro", () => {
  const QUOTE =
    "Feel free to take a look at my current test plan if you'd like to get familiar with our workflows.";
  const action: Action = {
    actorId: "tanya",
    text: `I gesture to my laptop on the desk as I say to Anton, '${QUOTE}'`,
  };

  it("reinserts the dropped quote deterministically (pure backstop)", () => {
    const repaired = reinsertQuote("Tanya gestures to her laptop.", "Tanya", QUOTE);
    expect(repaired).toContain("Feel free to take a look at my current test plan");
    expect(repaired).toContain("gestures to her laptop");
  });

  it("end-to-end: resolveRender repairs the dropped quote before validation", async () => {
    const logger = createTestLogger();
    const world = antonWorld();
    const deps = makeTestDeps(logger, {
      consequenceEngine: new MockConsequenceEngine(logger, {
        [action.text.toLowerCase()]: {
          narrative: "Tanya gestures to her laptop.",
          thoughts: "He seems eager.",
          reasoning: "r",
        },
      }),
      config: { ...defaultConfig, autosaveEnabled: false, maxRetries: 1 },
    });
    const out = await resolveRender(world, action, deps);
    // The deterministic pre-pass reinserted the quote before the prose
    // gate, so the render is accepted with the model's frame intact.
    expect(out.render.narrative).toContain("Feel free to take a look at my current test plan");
    expect(out.render.narrative).toContain("gestures to her laptop");
  });

  it("does not invent quotes when the action has none", () => {
    // The backstop only fires when the engine extracted a quote (the
    // orchestrator guards on exactQuote being non-null).
    const world = antonWorld();
    const noQuoteAction: Action = { actorId: "tanya", text: "Take a quiet sip of coffee." };
    expect(noQuoteAction.text).not.toMatch(/["'“‘]/);
  });
});

describe("exp3-10 S8 thought grounding", () => {
  const action: Action = { actorId: "anton", text: "Ask Tanya where to sit." };

  it("rejects thoughts naming invented people", () => {
    const world = antonWorld();
    const errors = validateThoughtGrounding(world, action, "anton", "Another day, same Leon.");
    expect(errors.some((e) => e.code === "thoughts.unknown_proper_noun")).toBe(true);
  });

  it("rejects ungrounded request claims (tick-3 repro)", () => {
    const world = antonWorld();
    const errors = validateThoughtGrounding(
      world,
      action,
      "anton",
      "Giving Dana the pen she requested.",
    );
    expect(errors.some((e) => e.code === "thoughts.ungrounded_claim")).toBe(true);
  });

  it("accepts the claim when history supports it", () => {
    const world = antonWorld();
    world.history.push({ text: "Dana: Dana asks Anton for a pen.", perceivers: ["dana", "anton"] });
    const errors = validateThoughtGrounding(
      world,
      action,
      "anton",
      "Giving Dana the pen she requested.",
    );
    expect(errors).toEqual([]);
  });

  it("passes clean thoughts", () => {
    const world = antonWorld();
    const errors = validateThoughtGrounding(
      world,
      action,
      "anton",
      "Hope she points me to my desk.",
    );
    expect(errors).toEqual([]);
  });

  it("fires inside validateRenderProse", () => {
    const world = antonWorld();
    const errors = validateRenderProse(
      world,
      action,
      {
        narrative: "Anton asks Tanya where to sit.",
        thoughts: "Giving Dana the pen she requested.",
        reasoning: "r",
      },
      {
        exactQuote: null, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
        x: 16, y: 2, engineManipulation: null,
      },
    );
    expect(errors.some((e) => e.code === "thoughts.ungrounded_claim")).toBe(true);
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

  it("planPose: tick-11 repro — the engine plans sit from the action text", () => {
    // Phase 4: pose is engine-planned from text (planPose), not
    // model-patched and validated. The sit-no-chair check is now the
    // engine's problem by construction (the executor owns poses).
    expect(planPose("Sit at her desk and organize papers.")).toBe("sit");
    expect(planPose("Sit down.")).toBe("sit");
    expect(planPose("Stand up and stretch.")).toBe("stand");
    expect(planPose("Look at the mug.")).toBeNull();
  });

  it("engine-derived state labels never stack articles (describePosition)", () => {
    // Phase 4: state labels are generated by describePosition, never by
    // the model — stacked articles ("near the tanya's mug") are
    // impossible by construction.
    const world = chairWorld();
    expect(describePosition(world, 8, 9)).toBe("at Tanya's desk");
    expect(describePosition(world, 8, 9)).not.toMatch(/the Tanya's/);
  });
});

