// Regression tests for Experiment-5 action items implemented on the
// exp5-fixes branch.
//
// Item 5 (S4): accept-gate name audit scans the narrative only.
//   - tick-27 repro: a perfect quote-preserving salvage whose reasoning
//     carries engine wording ("Fallback due to Consequence Engine
//     failure.") must PASS — the word "Consequence" is not a person.
// Item 7 (S3): prose gates on the accept path.
//   - stay-action→teleport rejects on recheckAcceptedProse.
//   - stale "enters the office" rejects when the actor already has a
//     prior turn (ticks 23/24 repro); passes on the first turn.
//   - observer-led coordination ("Tanya and Dana turn to look…", tick-23
//     repro) rejects on the accept path; possessives, vocatives, and bare
//     fragments do not match.
// Item 6 (S2): constructive movement repair.
//   - effectiveRepairTarget prefers the judge's resolved destination over
//     the narrative's named target (tick-15 repro: judge anton_desk vs
//     corrupt narrative "Tanya's desk").
//   - vetoAwayFromTarget vetoes away-steps, keeps toward-steps.
//   - buildStationaryDowngrade strips movement, keeps thoughts, and
//     synthesizes an honest stationary narrative that validates clean.
// Item 9 (S8): intent-ban keys and cluster bans.
//   - the "offer" verb keys precisely (offer|anton, not other|anton).
//   - ticks-13/19/22 repro: the exact-key streak bans at the third
//     failure; the glance-at-test-plan substitute shares the {laptop}
//     cluster and is banned too; an unrelated cluster is not.
import { describe, expect, it } from "vitest";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import {
  matchObserverCoordination,
  observerNameTokens,
  validateEnterFreshness,
  validateNarrativeActors,
  validateObserverSubject,
} from "../../src/engine/validate/narrative.js";
import { findSupplementObserverSubject } from "../../src/engine/validate/narrative.js";
import {
  executorDestination,
  executeMovement,
} from "../../src/engine/movementExecutor.js";
import {
  suggestionClusterNouns,
  suggestionCore,
} from "../../src/engine/contextBuilder.js";
import {
  consecutiveClusterFailures,
  consecutiveIntentFailures,
} from "../../src/engine/turnLiveness.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { NOT_DONE_SENTINEL } from "../../src/types.js";
import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  World,
} from "../../src/types.js";

function officeWorld(): World {
  return loadScenario({
    version: 1,
    id: "office-exp5-test",
    title: "Office",
    narrative: "An office.",
    userActorId: "anton",
    order: ["anton", "tanya", "dana"],
    scene: {
      width: 20,
      height: 20,
      objects: [
        {
          id: "coffee_machine", name: "Coffee machine", description: "Coffee.",
          x: 2, y: 1, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
        },
        {
          id: "tanya_chair", name: "Tanya's chair", description: "A chair.",
          x: 8, y: 7, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
        },
        {
          id: "tanya_desk", name: "Tanya's desk", description: "A desk.",
          x: 7, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false,
        },
        {
          id: "anton_desk", name: "Anton's desk", description: "A desk.",
          x: 3, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false,
        },
      ],
    },
    actors: [
      {
        id: "anton", name: "Anton", persona: "New backend hire.", x: 16, y: 2,
        state: "standing near the entrance", emotion: "nervous",
        goal: "Settle in.", memories: [], beliefs: [], relationships: [],
      },
      {
        id: "tanya", name: "Tanya", persona: "QA engineer.", x: 8, y: 7,
        state: "sitting at her desk", emotion: "focused", pose: "sit",
        goal: "Finish testing.", memories: [], beliefs: [], relationships: [],
      },
      {
        id: "dana", name: "Dana", persona: "Recruiter.", x: 15, y: 11,
        state: "sitting at his desk", emotion: "stressed",
        goal: "Screen candidates.", memories: [], beliefs: [], relationships: [],
      },
    ],
  });
}

function silentSemantics(): ActionSemantics {
  return { moves: false, speaks: false, quotedSpeech: [] };
}

// ---------------------------------------------------------------------------
// Item 5 (S4): the name audit scans the narrative, never reasoning.
// ---------------------------------------------------------------------------
describe("exp5 item 5 (S4): narrative-only actor audit", () => {
  it("tick-27 repro: good-quote render with engine-worded reasoning passes", () => {
    const world = officeWorld();
    const quote =
      "Thanks both for making me feel welcome. I'm going to get my laptop set up now.";
    const action: Action = {
      actorId: "anton",
      text: `I smile and say, 'Thanks both for making me feel welcome. I'm going to get my laptop set up now.'`,
    };
    const candidate: ConsequenceResult = {
      narrative: `Anton says "${quote}"`,
      // Engine-worded reasoning, never canonical — must not trip the audit.
      reasoning: "Fallback due to Consequence Engine failure.",
    };
    expect(
      validateNarrativeActors(world, { narrative: candidate.narrative }),
    ).toEqual([]);
    expect(
      validateRenderProse(
        world,
        action,
        candidate,
        {
          exactQuote: quote, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
          x: 16, y: 2, engineManipulation: null,
        },
      ),
    ).toEqual([]);
  });

  it("still catches a genuinely unknown person in the narrative", () => {
    const world = officeWorld();
    const errors = validateNarrativeActors(world, {
      narrative: "Anton greets Liam on the way into the office.",
    });
    expect(errors.some((e) => e.code === "narrative.unknown_actor")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item 7 (S3): stay→teleport, stale enters, observer coordination.
// ---------------------------------------------------------------------------
describe("exp5 item 7 (S3): accept-path prose gates", () => {
  it("stay-action→teleport rejects on the accept path", () => {
    const world = officeWorld();
    const action: Action = { actorId: "anton", text: "Stay where you are." };
    // Phase 4: the model cannot self-declare moved=true — the engine
    // decides, so the teleport surfaces as narrated-without-move.
    const errors = validateRenderProse(
      world,
      action,
      { narrative: "Anton walks into the conference room.", reasoning: "r" },
      {
        exactQuote: null, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
        x: 16, y: 2, engineManipulation: null,
      },
    );
    expect(
      errors.some((e) => e.code === "movement.narrated_without_move"),
    ).toBe(true);
  });

  it("stale 'enters the office' fails once the actor has a prior turn", () => {
    const world = officeWorld();
    const action: Action = { actorId: "anton", text: "Walk in." };
    // First turn: entering is legitimate.
    expect(
      validateEnterFreshness(world, "Anton enters the office.", action),
    ).toEqual([]);
    // After a completed prior turn: stale (tick-24 repro).
    world.history.push({
      text: "Anton: Anton greets the office.",
      tick: 0,
      turnIndex: 0,
    } as never);
    const errors = validateEnterFreshness(
      world,
      "Anton enters the office.",
      action,
    );
    expect(errors.some((e) => e.code === "narrative.stale_enter")).toBe(true);
  });

  it("tick-23 shape: another actor's stale entrance narrated mid-run fails", () => {
    const world = officeWorld();
    world.history.push(
      { text: "Anton: Anton greets the office.", tick: 0, turnIndex: 0 } as never,
      { text: "Dana: Dana reviews candidates.", tick: 2, turnIndex: 2 } as never,
    );
    const action: Action = { actorId: "dana", text: "Look at Anton." };
    const errors = validateEnterFreshness(
      world,
      "Dana watches Anton enter the office.",
      action,
    );
    expect(errors.some((e) => e.code === "narrative.stale_enter")).toBe(true);
  });

  it("observer-led coordination rejects on the accept path (tick-23 repro)", () => {
    const world = officeWorld();
    const action: Action = { actorId: "dana", text: "Look at Anton." };
    const narrative =
      "Tanya and Dana turn to look at Anton as he enters the office.";
    // Verb-agnostic supplement catches the coordination ("turn" is not in
    // the validator's verb list, so the list version needs a listed verb).
    expect(
      findSupplementObserverSubject(world, narrative, action).some(
        (e) => e.code === "narrative.observer_as_subject",
      ),
    ).toBe(true);
    expect(
      validateObserverSubject(
        world,
        { narrative: "Tanya and Dana greet Anton as he enters." },
        action,
      ).some((e) => e.code === "narrative.observer_as_subject"),
    ).toBe(true);
    // And the full render validation rejects the tick-23 narrative.
    const errors = validateRenderProse(
      world,
      action,
      { narrative: `Dana: ${narrative}`, thoughts: "Watching.", reasoning: "r" },
      {
        exactQuote: null, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
        x: 15, y: 11, engineManipulation: null,
      },
    );
    expect(
      errors.some((e) => e.code === "narrative.observer_as_subject"),
    ).toBe(true);
  });

  it("coordination matcher ignores possessives, vocatives, and fragments", () => {
    const world = officeWorld();
    const tokens = observerNameTokens(world, "dana");
    expect(
      matchObserverCoordination("tanya's hand rests on the desk.", tokens),
    ).toBeUndefined();
    expect(
      matchObserverCoordination("tanya, smiling, waves at anton.", tokens),
    ).toBeUndefined();
    expect(matchObserverCoordination("tanya and dana.", tokens)).toBeUndefined();
    // …but catches the real coordination shape.
    const hit = matchObserverCoordination(
      "tanya and dana turn to look at anton.",
      tokens,
    );
    expect(hit?.id).toBe("tanya");
  });
});

// ---------------------------------------------------------------------------
// Item 6 (S2): Phase 1 — the repair machinery is deleted.
// ---------------------------------------------------------------------------
// Phase 1 (engine-owned movement) deletes effectiveRepairTarget,
// vetoAwayFromTarget, buildStationaryDowngrade, and
// synthesizeStationaryNarrative. The tick-15 invariant they protected — the
// judge's resolved destination beats the narrative's named target — now
// holds structurally: executorDestination ranks explicit semantic
// destinations above text, and the engine step always moves toward the
// resolved destination.
describe("exp5 item 6 (S2): engine-owned movement", () => {
  it("the resolved semantic destination wins over the narrative's named target (tick-15 repro)", () => {
    const world = officeWorld(); // anton at (16,2)
    const semantics: ActionSemantics = {
      moves: true,
      speaks: false,
      quotedSpeech: [],
      destinationObjectId: "anton_desk",
    };
    // Narrative says "Tanya's desk" but the judge resolved anton_desk.
    expect(executorDestination(semantics, "anton")).toEqual({
      kind: "object",
      id: "anton_desk",
    });
    const o = executeMovement(
      world,
      { actorId: "anton", text: "Anton walks toward Tanya's desk." },
      semantics,
    );
    expect(o).not.toBeNull();
    const desk = world.scene.objects.find((ob) => ob.id === "anton_desk")!;
    const oldDist = Math.hypot(16 - (desk.x + desk.w / 2), 2 - (desk.y + desk.h / 2));
    expect(Math.hypot(o!.x - (desk.x + desk.w / 2), o!.y - (desk.y + desk.h / 2))).toBeLessThan(oldDist);
    // Not toward Tanya: the narrative's named target is not a destination.
    const tanya = world.actors.find((a) => a.id === "tanya")!;
    const oldTanya = Math.hypot(16 - tanya.x, 2 - tanya.y);
    expect(Math.hypot(o!.x - tanya.x, o!.y - tanya.y)).toBeLessThan(oldTanya + 1e-9);
  });

  it("stationary intents get no engine movement (no downgrade machinery needed)", () => {
    const world = officeWorld();
    const o = executeMovement(
      world,
      { actorId: "anton", text: "Type furiously on the laptop." },
      silentSemantics(),
    );
    expect(o).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Item 9 (S8): intent-ban keys and cluster bans.
// ---------------------------------------------------------------------------
describe("exp5 item 9 (S8): intent-ban keys and cluster bans", () => {
  const OFFER =
    "I offer to help Anton set up his laptop and get settled at his new desk.";
  const SUBSTITUTE =
    "I glance at the test plan on my laptop, trying to gauge how far along I am.";

  it("the offer verb keys precisely (not other|anton)", () => {
    const world = officeWorld();
    expect(suggestionCore(world, OFFER, "tanya")).toBe("offer|anton");
  });

  it("cluster nouns capture the shared object kind, not abstract nouns", () => {
    expect(suggestionClusterNouns(OFFER)).toEqual(["desk", "laptop"]);
    expect(suggestionClusterNouns(SUBSTITUTE)).toEqual(["laptop"]);
    // Actor-only intents have no cluster (a failed walk must not ban greetings).
    expect(suggestionClusterNouns("I wave at Anton.")).toEqual([]);
  });

  it("ticks-13/19/22 repro: exact-key ban fires; the substitute is cluster-banned", () => {
    const world = officeWorld();
    const fail = (text: string): string =>
      `Tanya tried: ${text} (not done)${NOT_DONE_SENTINEL}`;
    world.history.push(
      { text: fail(OFFER), tick: 13, turnIndex: 1 } as never,
      {
        text: fail(
          "I stand up and walk to Anton's desk, extending my hand for a handshake in greeting.",
        ),
        tick: 16,
        turnIndex: 1,
      } as never,
      { text: fail(OFFER), tick: 19, turnIndex: 1 } as never,
    );
    // The interleaving different intent (tick 16) is skipped, not breaking:
    // two matching failures → the exact-key streak hits the threshold.
    expect(consecutiveIntentFailures(world, "tanya", "offer|anton")).toBe(2);
    // The substitute shares the laptop cluster → banned after the same
    // two failures, instead of dodging on a different verb|noun key.
    expect(
      consecutiveClusterFailures(
        world,
        "tanya",
        suggestionClusterNouns(SUBSTITUTE),
      ),
    ).toBe(2);
    // An unrelated cluster is untouched.
    expect(
      consecutiveClusterFailures(
        world,
        "tanya",
        suggestionClusterNouns("I walk to the coffee machine."),
      ),
    ).toBe(0);
  });

  it("an applied own turn breaks the cluster streak", () => {
    const world = officeWorld();
    const fail = (text: string): string =>
      `Tanya tried: ${text} (not done)${NOT_DONE_SENTINEL}`;
    world.history.push(
      { text: fail(OFFER), tick: 13, turnIndex: 1 } as never,
      {
        text: "Tanya: Tanya opens her laptop and starts the test run.",
        tick: 20,
        turnIndex: 1,
      } as never,
    );
    expect(
      consecutiveClusterFailures(world, "tanya", ["laptop"]),
    ).toBe(0);
  });
});
