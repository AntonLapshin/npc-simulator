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
import { validateConsequence } from "../../src/engine/physicalValidator.js";
import {
  matchObserverCoordination,
  observerNameTokens,
  validateEnterFreshness,
  validateNarrativeActors,
  validateObserverSubject,
} from "../../src/engine/validate/narrative.js";
import {
  findSupplementObserverSubject,
  recheckAcceptedProse,
} from "../../src/engine/turnSalvageGates.js";
import {
  effectiveRepairTarget,
  vetoAwayFromTarget,
} from "../../src/engine/textHints.js";
import {
  buildStationaryDowngrade,
  synthesizeStationaryNarrative,
} from "../../src/engine/turnOrchestrator.js";
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
  it("tick-27 repro: good-quote salvage with engine-worded reasoning passes", () => {
    const world = officeWorld();
    const quote =
      "Thanks both for making me feel welcome. I'm going to get my laptop set up now.";
    const candidate: ConsequenceResult = {
      narrative: `Anton says "${quote}"`,
      actorPatches: [{ actorId: "anton", x: 4, y: 10 }],
      objectPatches: [],
      // Engine-written, never canonical — must not trip the audit.
      reasoning: "Fallback due to Consequence Engine failure.",
      effects: { moved: false, spoke: true, quotedSpeech: [quote] },
    };
    expect(
      validateNarrativeActors(world, { narrative: candidate.narrative }),
    ).toEqual([]);
    const action: Action = {
      actorId: "anton",
      text: `I smile and say, 'Thanks both for making me feel welcome. I'm going to get my laptop set up now.'`,
    };
    expect(recheckAcceptedProse(world, action, candidate)).toEqual([]);
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
    const result: ConsequenceResult = {
      narrative: "Anton stays put.",
      actorPatches: [{ actorId: "anton", x: 10, y: 10, thoughts: "Waiting." }],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: true, spoke: false },
    };
    const errors = recheckAcceptedProse(world, action, result);
    expect(
      errors.some((e) => e.code === "movement.unexpected_move"),
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
    // And the full accept gate rejects the tick-23 narrative.
    const result: ConsequenceResult = {
      narrative: `Dana: ${narrative}`,
      actorPatches: [{ actorId: "dana", thoughts: "Watching." }],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: false, spoke: false },
    };
    const errors = recheckAcceptedProse(world, action, result);
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
// Item 6 (S2): effective repair target, veto, stationary downgrade.
// ---------------------------------------------------------------------------
describe("exp5 item 6 (S2): constructive movement repair", () => {
  it("effectiveRepairTarget prefers the judge destination over the narrative target (tick-15 repro)", () => {
    const world = officeWorld();
    const semantics: ActionSemantics = {
      moves: true,
      speaks: false,
      quotedSpeech: [],
      destinationObjectId: "anton_desk",
    };
    const target = effectiveRepairTarget(
      world,
      "anton",
      "Anton walks toward Tanya's desk, setting his laptop down.",
      semantics,
    );
    expect(target?.id).toBe("anton_desk");
    // Judge silent: falls back to the narrative target — actor mentions win
    // over objects (person is the stronger signal), so "Tanya's desk"
    // resolves to Tanya herself (tick-28 behavior preserved).
    const fallback = effectiveRepairTarget(
      world,
      "anton",
      "Anton walks toward Tanya's desk.",
      undefined,
    );
    expect(fallback?.id).toBe("tanya");
    // No target anywhere: null.
    expect(
      effectiveRepairTarget(world, "anton", "Anton looks around.", undefined),
    ).toBeNull();
  });

  it("vetoAwayFromTarget vetoes away-steps and keeps toward-steps", () => {
    const world = officeWorld(); // anton at (16,2)
    const towardDesk = { x: 4.5, y: 9 }; // anton_desk center
    expect(
      vetoAwayFromTarget(world, "anton", { x: 4, y: 10 }, towardDesk),
    ).toEqual({ x: 4, y: 10 });
    expect(
      vetoAwayFromTarget(world, "anton", { x: 17, y: 2 }, towardDesk),
    ).toBeNull();
  });

  it("buildStationaryDowngrade commits an honest stationary turn", () => {
    const world = officeWorld();
    // Exp-5 geometry: Tanya at (8,7), Anton moved adjacent to (7,7).
    world.actors.find((a) => a.id === "anton")!.x = 7;
    world.actors.find((a) => a.id === "anton")!.y = 7;
    const action: Action = {
      actorId: "tanya",
      text: "I offer to help Anton set up his laptop and get settled at his new desk.",
    };
    const result: ConsequenceResult = {
      narrative: "Tanya walks over to Anton to help with his laptop.",
      actorPatches: [
        { actorId: "tanya", x: 7, y: 7, thoughts: "Helping the new hire." },
      ],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: true, spoke: false },
    };
    const effTarget = effectiveRepairTarget(
      world,
      "tanya",
      result.narrative,
      silentSemantics(),
    );
    expect(effTarget?.id).toBe("anton");
    const downgrade = buildStationaryDowngrade(world, action, result, effTarget);
    expect(downgrade).not.toBeNull();
    // Honest prose: no movement claimed, already-reached target named.
    expect(downgrade!.narrative).toBe("Tanya remains in position by Anton.");
    // Movement stripped, thoughts kept, moved=false.
    const patch = downgrade!.actorPatches.find((p) => p.actorId === "tanya")!;
    expect(patch.x).toBeUndefined();
    expect(patch.y).toBeUndefined();
    expect(patch.thoughts).toBe("Helping the new hire.");
    expect(downgrade!.effects?.moved).toBe(false);
    // The downgrade validates clean (moves=false) and passes the accept gate.
    const v = validateConsequence(
      world,
      downgrade!,
      action,
      silentSemantics(),
    );
    expect(v.errors).toEqual([]);
    expect(recheckAcceptedProse(world, action, downgrade!)).toEqual([]);
  });

  it("synthesizeStationaryNarrative preserves quoted speech", () => {
    const world = officeWorld();
    const action: Action = {
      actorId: "anton",
      text: `I stay put and say, "No rush, take your time."`,
    };
    const actor = world.actors.find((a) => a.id === "anton")!;
    expect(
      synthesizeStationaryNarrative(action, "Anton", actor, null, undefined),
    ).toBe(`Anton remains in position. Anton says "No rush, take your time.".`);
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
