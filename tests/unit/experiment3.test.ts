// Regression tests for experiment-3.md action items 1-13
// (office-anton.json, 7 adaptive user turns, local 8B, ticks 0-20).
import { describe, expect, it } from "vitest";
import { validateConsequence } from "../../src/engine/physicalValidator.js";
import {
  applyDeterministicGrounding,
  isQuoteGroundedInAction,
  parseActionQuotes,
  resolveActionSemantics,
} from "../../src/engine/actionSemantics.js";
import {
  hasDisplacementToken,
  resolveDestinationActorId,
  resolveDeterministicSemantics,
} from "../../src/engine/deterministicSemantics.js";
import { isSpeechOnlyFailure, resolveWithValidation, summarizeTurnOutcomes, trySalvageConsequence } from "../../src/engine/turnOrchestrator.js";
import { suggestSimilarIds } from "../../src/engine/physicalValidator.js";
import { suggestMoveTarget } from "../../src/engine/movementAssist.js";
import { Logger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld, errorText } from "../helpers.js";
import {
  buildConsequenceContext,
  buildObjectIdCatalog,
  buildProposalContext,
  buildRelationshipRefresh,
  buildSelectionContext,
} from "../../src/engine/contextBuilder.js";
import { consequenceSuffix } from "../../src/llm/prompts.js";
import { mockClassifyAction, MockSemanticJudge } from "../../src/mocks/mockSemanticJudge.js";
import { createTestLogger } from "../../src/logging/logger.js";
import type { ActionSemantics, ConsequenceResult, World } from "../../src/types.js";

function baseResult(narrative = "Something happens."): ConsequenceResult {
  return { narrative, actorPatches: [], objectPatches: [], reasoning: "r" };
}

function stillSemantics(): ActionSemantics {
  return { moves: false, speaks: false, quotedSpeech: [] };
}

/** Tiny world with two named desks + a coffee machine for landmark tests. */
function officeWorld(): World {
  const world = makeTinyWorld();
  world.actors.find((a) => a.id === "u")!.name = "Anton";
  world.actors.find((a) => a.id === "n")!.name = "Nadia";
  world.scene.objects.push(
    {
      id: "anton_desk", name: "Anton's desk", description: "A fresh desk.",
      x: 4, y: 4, w: 2, h: 1, passable: false, blocksVision: false, blocksSound: false,
    },
    {
      id: "nadia_desk", name: "Nadia's desk", description: "A desk.",
      x: 0, y: 4, w: 2, h: 1, passable: false, blocksVision: false, blocksSound: false,
    },
    {
      id: "coffee_machine", name: "Coffee machine", description: "Coffee.",
      x: 0, y: 0, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    },
    {
      id: "anton_mug", name: "Anton's mug", description: "A mug.",
      x: 4, y: 4, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    },
  );
  return world;
}

describe("exp3-1 deterministic quote grounding (ticks 0/3/9/17)", () => {
  it("parses ground-truth quotes from the action text", () => {
    expect(parseActionQuotes('Walk to Tanya and ask "where is my desk?"')).toEqual([
      "where is my desk?",
    ]);
    expect(parseActionQuotes("Walk silently.")).toEqual([]);
  });

  it("rejects hallucinated quotes as ungrounded", () => {
    const action = "Walk to Tanya and ask \"where is my desk?\"";
    expect(isQuoteGroundedInAction("Good to see you again, Jeff", action)).toBe(false);
    expect(isQuoteGroundedInAction("where is my desk?", action)).toBe(true);
    // Phase 1 is strict substring: paraphrases do NOT count as ground truth
    // here (narrative-side paraphrase stays lenient — see tick-3 test below).
    expect(isQuoteGroundedInAction("where my desk is", action)).toBe(false);
  });

  it("drops judge-invented quotes and ids, logging disagreement", async () => {
    const world = makeTinyWorld();
    const logger = createTestLogger();
    const judge = {
      async classify(): Promise<ActionSemantics> {
        return {
          moves: false,
          speaks: true,
          quotedSpeech: ["Good to see you again, Jeff"],
          destinationActorId: "jeff",
          addresseeActorId: "jeff",
        };
      },
    };
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "u", text: '"Hello there!"' },
      {
        ...baseResult('U says "Hello there!"'),
        actorPatches: [{ actorId: "u", thoughts: "Hi." }],
        effects: { moved: false, spoke: true, quotedSpeech: ["Hello there!"] },
      },
      judge,
      logger,
    );
    // Ground truth = the action-text quote; Jeff's quote and ids are dropped.
    expect(resolved.semantics!.quotedSpeech).toEqual(["Hello there!"]);
    expect(resolved.semantics!.destinationActorId).toBeUndefined();
    expect(resolved.semantics!.addresseeActorId).toBeUndefined();
    expect(resolved.disagreements!.length).toBeGreaterThan(0);
    expect(logger.store.events()).toContain("judge_vs_effects_disagreement");
  });

  it("applyDeterministicGrounding keeps roster ids and grounded quotes", () => {
    const world = makeTinyWorld();
    const { semantics, disagreements } = applyDeterministicGrounding(
      world,
      { actorId: "u", text: 'Walk to N and ask "where?"' },
      { moves: true, destinationActorId: "n", speaks: true, quotedSpeech: ["where?"] },
      { moves: true, destinationActorId: "n", speaks: true, quotedSpeech: ["where?"] },
      { moves: true, destinationActorId: "n", speaks: true, quotedSpeech: ["where?"] },
    );
    expect(disagreements).toEqual([]);
    expect(semantics).toMatchObject({ moves: true, destinationActorId: "n" });
  });
});

describe("exp3-2 speech gate split (ticks 3 vs 4/12/15/18)", () => {
  it("passes a legitimate question paraphrase (tick 3)", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U asks N for directions to his desk."),
        actorPatches: [
          { actorId: "u", x: 2, y: 2, thoughts: "Going." },
          { actorId: "n", thoughts: "Helpful." },
        ],
      },
      { actorId: "u", text: 'Walk to N and ask "could you show me where my desk is?"' },
      {
        moves: true, destinationActorId: "n", speaks: true,
        quotedSpeech: ["could you show me where my desk is?"],
      },
    );
    expect(v).toEqual({ valid: true, errors: [] });
  });

  it("still fails truncations and flipped questions", () => {
    const world = makeTinyWorld();
    // Truncation: keeps the name, drops the question.
    const trunc = validateConsequence(
      world,
      { ...baseResult("U says hi, Anton is here."), actorPatches: [] },
      { actorId: "u", text: '"Hi, I am Anton, where is my desk?"' },
      { moves: false, speaks: true, quotedSpeech: ["Hi, I am Anton, where is my desk?"] },
    );
    expect(trunc.valid).toBe(false);
    expect(errorText(trunc.errors)).toMatch(/exact words/);
  });

  it("fails dropped handshakes via action-side contact coverage (tick 12)", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U asks, 'N, what should my first task be?'"),
        actorPatches: [
          { actorId: "u", thoughts: "Asking." },
          { actorId: "n", thoughts: "Onboarding." },
        ],
      },
      { actorId: "u", text: 'Shake the hand of N, "N, what should my first task be?"' },
      {
        moves: false, speaks: true, quotedSpeech: ["N, what should my first task be?"],
        addresseeActorId: "n", contactActorId: "n",
      },
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/physical contact/);
  });

  it("fails sit-dodged-by-stands via action-side pose coverage (tick 15)", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U stands next to the desk."),
        actorPatches: [{ actorId: "u", x: 2, y: 1, thoughts: "Here." }],
      },
      { actorId: "u", text: "Walk to my desk and sit on the chair." },
      stillSemantics(),
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/sit/);
  });

  it("fails pour-dodged-by-silence via action-side object coverage (tick 9)", () => {
    const world = officeWorld();
    world.actors.find((a) => a.id === "u")!.x = 5;
    world.actors.find((a) => a.id === "u")!.y = 0;
    const v = validateConsequence(
      world,
      {
        ...baseResult("Anton approaches the coffee machine, standing beside it."),
        actorPatches: [{ actorId: "u", x: 1, y: 1, thoughts: "Coffee time." }],
      },
      { actorId: "u", text: "Walk to the coffee machine and pour a coffee." },
      { moves: true, destinationObjectId: "coffee_machine", speaks: false, quotedSpeech: [] },
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/pour\/brew\/open/);
  });

  it("fails flipped ask-to-thanks via action-side question coverage (tick 16)", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("N thanks U, looking pleased."),
        actorPatches: [
          { actorId: "n", x: 3, y: 3, thoughts: "Pleased." },
          { actorId: "u", thoughts: "Welcome." },
        ],
      },
      { actorId: "n", text: "Walk to U to ask if he needs help setting up." },
      { moves: true, destinationActorId: "u", speaks: false, quotedSpeech: [] },
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/asks a question/);
  });

  it("does not mistake adjectives for verbs ('an open demeanor')", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U calls out a greeting, open and welcoming."),
        actorPatches: [{ actorId: "u", thoughts: "Friendly." }],
      },
      { actorId: "u", text: "Call out a greeting, open and welcoming." },
      { moves: false, speaks: true, quotedSpeech: [] },
    );
    expect(v).toEqual({ valid: true, errors: [] });
  });
});

describe("exp3-3 locomotion classification (ticks 2/8/11/14/17/20)", () => {
  it("mock judge: perception/cognition is never locomotion", async () => {
    const world = makeTinyWorld();
    const judge = new MockSemanticJudge();
    const still = [
      "Take a sip of coffee, reviewing candidate notes.",
      "Quickly glance up before settling back into the chair.",
      "Look up to greet N warmly.",
      "Ask N about backend experience and compare to the stack.",
      "Glance over notes and mentally prepare questions.",
      "Dana types up notes, focusing on the code.",
    ];
    for (const text of still) {
      const s = await judge.classify(world, { actorId: "u", text });
      expect(s.moves).toBe(false);
    }
  });

  it("mock judge: real locomotion still detected", async () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const judge = new MockSemanticJudge();
    for (const text of ["Walk to Nadia.", "Head to the door.", "Come closer to Nadia"]) {
      const s = await judge.classify(world, { actorId: "u", text });
      expect(s.moves).toBe(true);
    }
  });

  it("mock judge: approaching someone already adjacent needs no movement", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    // u at (1,1); move Nadia adjacent.
    world.actors.find((a) => a.id === "n")!.x = 2;
    world.actors.find((a) => a.id === "n")!.y = 1;
    const s = mockClassifyAction(world, { actorId: "u", text: "Set down the mug and approach Nadia." });
    expect(s.moves).toBe(false);
    expect(s.destinationActorId).toBeUndefined();
  });
});

describe("exp3-4 displacement cap + real progress (ticks 8/15/20)", () => {
  it("rejects teleports beyond the per-turn cap", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U returns to typing, focusing on the code."),
        actorPatches: [{ actorId: "u", x: 5, y: 5, thoughts: "Zone." }],
      },
      { actorId: "u", text: "Walk across the room." },
      { moves: true, speaks: false, quotedSpeech: [] },
    );
    // (1,1) -> (5,5) is 5.7 cells: within cap, no destination — valid.
    expect(v).toEqual({ valid: true, errors: [] });

    const far = validateConsequence(
      world,
      {
        ...baseResult("N walks across the room."),
        actorPatches: [{ actorId: "n", x: 0, y: 0, thoughts: "Going." }],
      },
      { actorId: "n", text: "Walk across the room." },
      { moves: true, speaks: false, quotedSpeech: [] },
    );
    // n is at (4,4); (4,4) -> (0,0) is 5.7 cells: within cap — valid too.
    expect(far).toEqual({ valid: true, errors: [] });
  });

  it("rejects a 13-cell glance-teleport", () => {
    const world = makeTinyWorld();
    // Simulate tick-20 scale: actor 13 cells from its patch target.
    world.scene.width = 20;
    world.scene.height = 20;
    const v = validateConsequence(
      world,
      {
        ...baseResult("U glances over notes."),
        actorPatches: [{ actorId: "u", x: 14, y: 14, thoughts: "Zone." }],
      },
      { actorId: "u", text: "Walk over there." },
      { moves: true, speaks: false, quotedSpeech: [] },
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/at most 6 cells/);
  });

  it("rejects token shuffles toward distant named landmarks (tick 15)", () => {
    const world = officeWorld();
    // Cross-room scale: Anton's desk far away, Anton at the origin.
    world.scene.width = 20;
    world.scene.height = 20;
    const desk = world.scene.objects.find((o) => o.id === "anton_desk")!;
    desk.x = 15;
    desk.y = 15;
    world.actors.find((a) => a.id === "u")!.x = 0;
    world.actors.find((a) => a.id === "u")!.y = 0;
    const v = validateConsequence(
      world,
      {
        ...baseResult("Anton sits at Nadia's desk, now at (1, 0)."),
        actorPatches: [{ actorId: "u", x: 1, y: 0, thoughts: "Here?" }],
      },
      { actorId: "u", text: "Walk to my desk on the west side and sit down." },
      { moves: true, destinationObjectId: "anton_desk", speaks: false, quotedSpeech: [] },
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/real progress|different landmark/);
  });

  it("accepts real progress toward a distant landmark", () => {
    const world = officeWorld();
    world.scene.width = 20;
    world.scene.height = 20;
    const desk = world.scene.objects.find((o) => o.id === "anton_desk")!;
    desk.x = 15;
    desk.y = 15;
    world.actors.find((a) => a.id === "u")!.x = 0;
    world.actors.find((a) => a.id === "u")!.y = 0;
    const target = suggestMoveTarget(world, "u", undefined, "anton_desk");
    expect(target).not.toBeNull();
    const v = validateConsequence(
      world,
      {
        ...baseResult("Anton walks toward his desk."),
        actorPatches: [{ actorId: "u", x: target!.x, y: target!.y, thoughts: "Going." }],
      },
      { actorId: "u", text: "Walk to my desk." },
      { moves: true, destinationObjectId: "anton_desk", speaks: false, quotedSpeech: [] },
    );
    expect(v).toEqual({ valid: true, errors: [] });
  });

  it("suggestMoveTarget never suggests teleports", () => {
    const world = makeTinyWorld();
    world.scene.width = 30;
    world.scene.height = 30;
    const s = suggestMoveTarget(world, "u", "n");
    expect(s).not.toBeNull();
    expect(Math.hypot(s!.x - 1, s!.y - 1)).toBeLessThanOrEqual(6 + 1e-9);
  });
});

describe("exp3-5 observer-as-subject prose (tick 13)", () => {
  it("fails narratives led by a roster observer", () => {
    const world = officeWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("Anton shakes Nadia's hand."),
        actorPatches: [
          { actorId: "n", x: 3, y: 3, thoughts: "Welcome!" },
          { actorId: "u", thoughts: "Firm grip." },
        ],
      },
      { actorId: "n", text: "Approach Anton to greet warmly." },
      { moves: true, destinationActorId: "u", speaks: false, quotedSpeech: [] },
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/observer.*as the acting subject|describe ONLY/);
  });

  it("passes landmark mentions and possessives", () => {
    const world = officeWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("Anton walks toward Nadia near the coffee machine."),
        actorPatches: [{ actorId: "u", x: 2, y: 2, thoughts: "Going." }],
        effects: { moved: true, spoke: false, destinationActorId: "n" },
      },
      { actorId: "u", text: "Walk toward Nadia." },
      { moves: true, destinationActorId: "n", speaks: false, quotedSpeech: [] },
    );
    expect(v).toEqual({ valid: true, errors: [] });
  });
});

describe("exp3-7 fuzzy object-ID repair (ticks 10/11)", () => {
  it("suggests the closest real ids", () => {
    expect(suggestSimilarIds("coffee mug", ["anton_mug", "dana_mug", "anton_desk"])).toMatch(
      /anton_mug.*dana_mug|dana_mug.*anton_mug/,
    );
    expect(suggestSimilarIds("paper", ["dana_papers", "anton_desk"])).toContain("dana_papers");
    expect(suggestSimilarIds("tanya's_desk", ["tanya_desk", "anton_desk"])).toContain("tanya_desk");
  });

  it("names suggestions in the unknown-object error", () => {
    const world = officeWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U sets down the mug."),
        actorPatches: [{ actorId: "u", thoughts: "Done." }],
        objectPatches: [{ objectId: "coffee mug", description: "Used." }],
      },
      { actorId: "u", text: "Set down the coffee mug." },
      stillSemantics(),
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/unknown object id.*did you mean/);
  });
});

describe("exp3-6 partial-apply / salvage (ticks 3/9)", () => {
  it("salvages valid movement plus a stray hallucinated patch, repairing the dropped quote", () => {
    const world = officeWorld();
    world.actors.find((a) => a.id === "u")!.x = 3;
    world.actors.find((a) => a.id === "u")!.y = 3;
    const action = { actorId: "u", text: 'Walk to the coffee machine. "I need caffeine."' };
    const semantics: ActionSemantics = {
      moves: true, destinationObjectId: "coffee_machine",
      speaks: true, quotedSpeech: ["I need caffeine."],
    };
    const result: ConsequenceResult = {
      narrative: "Anton approaches the coffee machine, standing beside it.",
      actorPatches: [
        { actorId: "u", x: 1, y: 1, thoughts: "Coffee time." },
        { actorId: "jeff", thoughts: "Hello." },
      ],
      objectPatches: [],
      reasoning: "r",
    };
    const out = trySalvageConsequence(world, action, result, semantics);
    expect(out).not.toBeNull();
    expect(out!.salvaged.actorPatches.some((p) => p.actorId === "jeff")).toBe(false);
    expect(out!.salvaged.actorPatches.some((p) => p.actorId === "u")).toBe(true);
    // Exp-3 item 3 (S4): the dropped quote is reinserted deterministically
    // (frame preserved, quote appended) — marked with the honest
    // quote_reinserted note instead of a speech warning downgrade.
    expect(out!.warnings.some((w) => w.code === "salvage.quote_reinserted")).toBe(true);
    expect(out!.salvaged.narrative).toContain("I need caffeine.");
    expect(out!.salvaged.narrative).toContain("approaches the coffee machine");
  });

  it("refuses salvage when the acting actor is unpatched", () => {
    const world = makeTinyWorld();
    const out = trySalvageConsequence(
      world,
      { actorId: "u", text: "Wave." },
      {
        narrative: "A ghost acts.",
        actorPatches: [{ actorId: "ghost", emotion: "spooky" }],
        objectPatches: [],
        reasoning: "r",
      },
      stillSemantics(),
    );
    expect(out).toBeNull();
  });

  it("isSpeechOnlyFailure matches only speech nits", () => {
    // F2: classification switches on stable codes, not message prose.
    expect(
      isSpeechOnlyFailure([{ code: "speech.dropped_words", message: "narrative drops the acting actor's exact words" }]),
    ).toBe(true);
    expect(
      isSpeechOnlyFailure([{ code: "speech.invented_dialogue", message: "narrative invents dialogue" }]),
    ).toBe(true);
    expect(
      isSpeechOnlyFailure([{ code: "actor.out_of_bounds", message: "actor u: coordinates outside scene bounds" }]),
    ).toBe(false);
    expect(isSpeechOnlyFailure([])).toBe(false);
  });

  it("resolveWithValidation salvages instead of falling back (tick-9 shape)", async () => {
    const logger = new Logger({ sessionId: "exp3-salvage", writeToFile: false });
    const world = officeWorld();
    world.actors.find((a) => a.id === "u")!.x = 3;
    world.actors.find((a) => a.id === "u")!.y = 3;
    const scripted: ConsequenceResult = {
      narrative: "Anton approaches the coffee machine, standing beside it.",
      actorPatches: [
        { actorId: "u", x: 1, y: 1, thoughts: "Coffee time." },
        { actorId: "jeff", thoughts: "Hello." },
      ],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: true, destinationObjectId: "coffee_machine", spoke: false },
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(scripted) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const out = await resolveWithValidation(
      world,
      { actorId: "u", text: "Walk to the coffee machine." },
      deps,
    );
    expect(out.narrative).not.toBe("Nothing changes.");
    expect(out.actorPatches.some((p) => p.actorId === "u" && p.x === 1 && p.y === 1)).toBe(true);
    expect(out.actorPatches.some((p) => p.actorId === "jeff")).toBe(false);
    expect(logger.store.byEvent("partial_applied")).toHaveLength(1);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });
});

describe("exp3-9/10/11/12/13 prompting", () => {
  it("consequence context carries the object-ID catalog and copy rule", () => {
    const world = officeWorld();
    const ctx = buildConsequenceContext(world, { actorId: "u", text: "Pour a coffee." });
    expect(ctx).toContain("OBJECT IDS");
    expect(ctx).toContain("anton_mug");
    expect(ctx).toContain("QUOTED-SPEECH COPY RULE");
    expect(ctx).toContain("omitting the verb from the narrative never excuses omitting the patch");
    expect(ctx).toContain("at most 6 cells");
  });

  it("relationship refresh names known colleagues, never strangers", () => {
    const world = officeWorld();
    const line = buildRelationshipRefresh(world, "n");
    expect(line).toContain("KNOWN COLLEAGUES");
    expect(line).toContain("Anton (u,");
    expect(line).toMatch(/never strangers/);
    // Private goals stay out of the shared line.
    world.actors.find((a) => a.id === "u")!.goal = "SECRET-PLAN-999";
    expect(buildRelationshipRefresh(world, "n")).not.toContain("SECRET-PLAN-999");
  });

  it("object catalog groups mugs/papers/desks with exact ids", () => {
    const world = officeWorld();
    const catalog = buildObjectIdCatalog(world);
    expect(catalog).toContain("`anton_mug`");
    expect(catalog).toContain("`anton_desk`");
    expect(catalog).toMatch(/never invent/);
  });

  it("short suffix keeps the core, full suffix keeps everything", () => {
    const short = consequenceSuffix("short");
    const full = consequenceSuffix("full");
    expect(consequenceSuffix()).toBe(full);
    for (const needle of ["contactActorId", "quotedSpeech", "TURN DISCIPLINE", "ROSTER", "6 cells"]) {
      expect(short).toContain(needle);
    }
    expect(full.length).toBeGreaterThan(short.length);
    expect(full).toContain("QUOTED-SPEECH COPY RULE");
    expect(full).toContain("OBJECT IDS");
  });

  it("proposal/selection contexts carry the relationship refresh", () => {
    const world = officeWorld();
    expect(buildProposalContext(world, "u")).toContain("KNOWN COLLEAGUES");
    expect(buildSelectionContext(world, "u", ["Wave."])).toContain("KNOWN COLLEAGUES");
  });
});

describe("phase1 deterministic grounding exit (ticks 0/3/6/9)", () => {
  function tanyaWorld(): World {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Tanya";
    return world;
  }

  it("deterministic destination prefers the goal over the origin", () => {
    const world = tanyaWorld();
    expect(resolveDestinationActorId(world, "u", "Walk from Tanya to the door.")).toBeUndefined();
    world.actors.push({
      id: "d", name: "Dana", persona: "p", x: 0, y: 0,
      state: "s", emotion: "c", goal: "g", thoughts: "t", memories: [], beliefs: [], relationships: [],
    });
    // Last movement mention wins: Dana is the goal, Tanya the origin.
    expect(resolveDestinationActorId(world, "u", "Walk from Tanya to Dana.")).toBe("d");
    // A greeting addressee is never a destination (tick 6).
    expect(resolveDestinationActorId(world, "u", "Thanks, Tanya! Walk to my desk.")).toBeUndefined();
    expect(resolveDestinationActorId(world, "u", "Come closer to Tanya.")).toBe("n");
  });

  it("drops a greeting addressee promoted to destination, keeps the addressee (tick 6)", async () => {
    const world = tanyaWorld();
    const logger = createTestLogger();
    const action = { actorId: "u", text: 'Walk to my desk and sit down. "Thanks, Tanya! Is this my spot?"' };
    const quote = "Thanks, Tanya! Is this my spot?";
    const judge = {
      async classify(): Promise<ActionSemantics> {
        return {
          moves: true, destinationActorId: "n", speaks: true,
          quotedSpeech: [quote], addresseeActorId: "n",
        };
      },
    };
    const resolved = await resolveActionSemantics(
      world, action,
      {
        ...baseResult("U walks."),
        actorPatches: [],
        effects: { moved: true, spoke: true, quotedSpeech: [quote] },
      },
      judge, logger,
    );
    // Tanya is mentioned only as an addressee — never a movement requirement.
    expect(resolved.semantics!.destinationActorId).toBeUndefined();
    expect(resolved.semantics!.addresseeActorId).toBe("n");
    expect(resolved.semantics!.quotedSpeech).toEqual([quote]);
    expect(resolved.disagreements!.join(" ")).toMatch(/not named as a movement target/);
  });

  it("drops an unmentioned roster destination so good movement still validates (tick 9)", async () => {
    const world = officeWorld();
    world.actors.find((a) => a.id === "u")!.x = 3;
    world.actors.find((a) => a.id === "u")!.y = 3;
    const logger = createTestLogger();
    const action = { actorId: "u", text: "Walk over to the coffee machine for a break." };
    const judge = {
      async classify(): Promise<ActionSemantics> {
        return {
          moves: true, destinationActorId: "n", speaks: false,
          quotedSpeech: ["Excuse me, do you have a minute?"],
        };
      },
    };
    const resolved = await resolveActionSemantics(
      world, action,
      {
        ...baseResult("Anton approaches the coffee machine, standing beside it."),
        actorPatches: [{ actorId: "u", x: 1, y: 1, thoughts: "Coffee time." }],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: true, spoke: false },
      },
      judge, logger,
    );
    // No Tanya in the action: the invented destination and quote are dropped.
    expect(resolved.semantics!.destinationActorId).toBeUndefined();
    expect(resolved.semantics!.quotedSpeech).toEqual([]);
    expect(resolved.disagreements!.length).toBeGreaterThan(0);
    // ...and the valid walk validates on its own movement, not the invention.
    const v = validateConsequence(
      world,
      {
        ...baseResult("Anton approaches the coffee machine, standing beside it."),
        actorPatches: [{ actorId: "u", x: 1, y: 1, thoughts: "Coffee time." }],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: true, spoke: false },
      },
      action,
      resolved.semantics!,
    );
    expect(v).toEqual({ valid: true, errors: [] });
  });

  it("tick-3 paraphrase still passes end to end under strict quote grounding", async () => {
    const world = makeTinyWorld();
    const logger = createTestLogger();
    const action = { actorId: "u", text: 'Walk to N and ask "could you show me where my desk is?"' };
    const resolved = await resolveActionSemantics(
      world, action,
      {
        narrative: "U asks N for directions to his desk.",
        actorPatches: [
          { actorId: "u", x: 2, y: 2, thoughts: "Going." },
          { actorId: "n", thoughts: "Helpful." },
        ],
        objectPatches: [],
        reasoning: "r",
        effects: {
          moved: true, spoke: true,
          quotedSpeech: ["could you show me where my desk is?"],
          destinationActorId: "n", addresseeActorId: "n",
        },
      },
      new MockSemanticJudge(), logger,
    );
    expect(resolved.disagreements).toEqual([]);
    const v = validateConsequence(
      world,
      {
        narrative: "U asks N for directions to his desk.",
        actorPatches: [
          { actorId: "u", x: 2, y: 2, thoughts: "Going." },
          { actorId: "n", thoughts: "Helpful." },
        ],
        objectPatches: [],
        reasoning: "r",
        effects: {
          moved: true, spoke: true,
          quotedSpeech: ["could you show me where my desk is?"],
          destinationActorId: "n", addresseeActorId: "n",
        },
      },
      action,
      resolved.semantics!,
    );
    expect(v).toEqual({ valid: true, errors: [] });
  });

  it("logs judge_vs_effects_disagreement on every resolution, even on agreement", async () => {
    const world = makeTinyWorld();
    const logger = createTestLogger();
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "u", text: "Wave." },
      { narrative: "U waves.", actorPatches: [], objectPatches: [], reasoning: "r" },
      new MockSemanticJudge(), logger,
    );
    expect(resolved.disagreements).toEqual([]);
    const events = logger.store.byEvent("judge_vs_effects_disagreement");
    expect(events).toHaveLength(1);
    expect((events[0]!.output as { agreement: boolean }).agreement).toBe(true);
    // Deterministic layer resolves no quotes/destinations for a bare wave.
    expect(resolveDeterministicSemantics(world, { actorId: "u", text: "Wave." })).toEqual({
      quotedSpeech: [],
    });
  });
});

describe("phase3 action-side verb gates (ticks 12/15/18, 10/11)", () => {
  it("fails speech dropped without a trace, passes preserved thanks (tick 18)", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Thank N for the welcome and head to the desk." };
    const dropped = validateConsequence(
      world,
      {
        ...baseResult("U looks around the office."),
        actorPatches: [{ actorId: "u", thoughts: "Nice place." }],
      },
      action,
      stillSemantics(),
    );
    expect(dropped.valid).toBe(false);
    expect(errorText(dropped.errors)).toMatch(/renders no speech/);

    const kept = validateConsequence(
      world,
      {
        ...baseResult("U thanks N for the welcome."),
        actorPatches: [
          { actorId: "u", thoughts: "Grateful." },
          { actorId: "n", thoughts: "Welcome!" },
        ],
      },
      action,
      stillSemantics(),
    );
    expect(kept).toEqual({ valid: true, errors: [] });
  });

  it("greet/welcome may be rendered non-verbally (golden-path guard)", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Jeff";
    const v = validateConsequence(
      world,
      {
        ...baseResult("U walks toward Jeff and stops near him."),
        actorPatches: [
          { actorId: "u", x: 2, y: 2, thoughts: "Friendly." },
          { actorId: "n", thoughts: "Welcoming." },
        ],
      },
      { actorId: "u", text: "Walk over to Jeff and welcome him." },
      { moves: true, destinationActorId: "n", speaks: false, quotedSpeech: [] },
    );
    expect(v).toEqual({ valid: true, errors: [] });
  });

  it("fails pick up/hold with no backing patch, passes with a prop patch", () => {
    const world = officeWorld();
    for (const text of ["Pick up the mug from the desk.", "Hold the cup while waiting."]) {
      const dropped = validateConsequence(
        world,
        {
          ...baseResult("Anton stands by the desk."),
          actorPatches: [{ actorId: "u", thoughts: "Coffee." }],
        },
        { actorId: "u", text },
        stillSemantics(),
      );
      expect(dropped.valid, text).toBe(false);
      expect(errorText(dropped.errors), text).toMatch(/pick up\/hold/);
    }
    const held = validateConsequence(
      world,
      {
        ...baseResult("Anton holds the cup."),
        actorPatches: [{ actorId: "u", prop: "cup", thoughts: "Warm." }],
      },
      { actorId: "u", text: "Hold the cup while waiting." },
      stillSemantics(),
    );
    expect(held).toEqual({ valid: true, errors: [] });
  });

  it("fails far handshakes even without a declared contact id, passes adjacent ones (tick 12)", () => {
    const world = officeWorld();
    // u (Anton) at (1,1), n (Nadia) at (4,4): 4.2 cells apart — no contact declared.
    const far = validateConsequence(
      world,
      {
        ...baseResult("Anton shakes Nadia's hand."),
        actorPatches: [
          { actorId: "u", thoughts: "Firm grip." },
          { actorId: "n", thoughts: "Welcome!" },
        ],
      },
      { actorId: "u", text: "Shake Nadia's hand warmly." },
      stillSemantics(),
    );
    expect(far.valid).toBe(false);
    expect(errorText(far.errors)).toMatch(/adjacent/);

    // Adjacent: Nadia one cell away, handshake narrated — passes.
    world.actors.find((a) => a.id === "n")!.x = 2;
    world.actors.find((a) => a.id === "n")!.y = 1;
    const near = validateConsequence(
      world,
      {
        ...baseResult("Anton shakes Nadia's hand."),
        actorPatches: [
          { actorId: "u", thoughts: "Firm grip." },
          { actorId: "n", thoughts: "Welcome!" },
        ],
      },
      { actorId: "u", text: "Shake Nadia's hand warmly." },
      stillSemantics(),
    );
    expect(near).toEqual({ valid: true, errors: [] });
  });

  it("surfaces fuzzy id suggestions in retry feedback so the retry can succeed (ticks 10/11)", async () => {
    const logger = new Logger({ sessionId: "exp3-phase3-retry", writeToFile: false });
    const world = officeWorld();
    const seenFeedback: (string | undefined)[] = [];
    const attempts: ConsequenceResult[] = [
      {
        narrative: "Anton sets down the mug.",
        actorPatches: [{ actorId: "u", thoughts: "Done." }],
        objectPatches: [{ objectId: "coffee mug", description: "Used." }],
        reasoning: "r",
      },
      {
        narrative: "Anton sets down the mug.",
        actorPatches: [{ actorId: "u", thoughts: "Done." }],
        objectPatches: [{ objectId: "anton_mug", description: "Used." }],
        reasoning: "r",
      },
    ];
    const deps = makeTestDeps(logger, {
      consequenceEngine: {
        resolve: async (_w: World, _a: { actorId: string; text: string }, feedback?: string) => {
          seenFeedback.push(feedback);
          return structuredClone(attempts[seenFeedback.length - 1]!);
        },
      } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 1, autosaveEnabled: false },
    });
    const out = await resolveWithValidation(
      world,
      { actorId: "u", text: "Set down the coffee mug." },
      deps,
    );
    expect(out.narrative).not.toBe("Nothing changes.");
    expect(out.objectPatches).toEqual([{ objectId: "anton_mug", description: "Used." }]);
    // The retry saw the validator's "did you mean" hint, not a bare unknown-id.
    expect(seenFeedback[1]).toMatch(/did you mean/);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });
});

describe("phase2 movement speed + progress semantics (ticks 8/15/20)", () => {
  it("hasDisplacementToken: perception/cognition/resumed activity carry no token", () => {
    for (const text of [
      "Quickly glance up before settling back into the chair.",
      "Look up to greet N warmly.",
      "Glance over notes and mentally prepare questions.",
      "Ask N about backend experience and compare to the stack.",
      "Take a sip of coffee, reviewing candidate notes.",
      "Dana types up notes, focusing on the code.",
      "Go the extra mile.",
      "Call out a friendly 'Hey!' as she sees N, then return to typing.",
      "Shake his head at N.",
    ]) {
      expect(hasDisplacementToken(text)).toBe(false);
    }
  });

  it("hasDisplacementToken: explicit displacement verbs and proximity phrases carry a token", () => {
    for (const text of [
      "Walk to Nadia.",
      "Head to the door.",
      "Come closer to Nadia.",
      "Saunter over.",
      "Roll her chair closer.",
      "Sidle over to him.",
      "Stand next to Nadia.",
      "Return to the door.",
      "Walk from Tanya to Dana.",
      "Set down the mug and approach Nadia.",
      "Walk to my desk, then glance at the notes.",
    ]) {
      expect(hasDisplacementToken(text)).toBe(true);
    }
  });

  it("grounds away moves=true on glance text, keeps it on walk text", async () => {
    const world = makeTinyWorld();
    const logger = createTestLogger();
    const glance = await resolveActionSemantics(
      world,
      { actorId: "u", text: "Quickly glance up before settling back into the chair." },
      {
        ...baseResult("U teleports across the room."),
        actorPatches: [{ actorId: "u", x: 5, y: 5, thoughts: "Zone." }],
        effects: { moved: true, spoke: false },
      },
      {
        async classify(): Promise<ActionSemantics> {
          return { moves: true, destinationActorId: "n", speaks: false, quotedSpeech: [] };
        },
      },
      logger,
    );
    // F1: token evidence may ASSERT movement but never downgrade a true
    // merged verdict to false — the merged moves=true stands even with no
    // displacement token, and the disagreement is logged.
    expect(glance.semantics!.moves).toBe(true);
    expect(glance.semantics!.destinationActorId).toBeUndefined();
    expect(glance.disagreements!.join(" ")).toMatch(/kept from the merged verdict despite no displacement token/);

    const walk = await resolveActionSemantics(
      world,
      { actorId: "u", text: "Walk to N." },
      {
        ...baseResult("U walks."),
        actorPatches: [],
        effects: { moved: true, spoke: false, destinationActorId: "n" },
      },
      {
        async classify(): Promise<ActionSemantics> {
          return { moves: true, destinationActorId: "n", speaks: false, quotedSpeech: [] };
        },
      },
      createTestLogger(),
    );
    expect(walk.semantics).toMatchObject({ moves: true, destinationActorId: "n" });
    expect(walk.disagreements).toEqual([]);
  });

  it("glance-teleports fail, staying in place passes (ticks 8/20)", () => {
    const world = makeTinyWorld();
    world.scene.width = 20;
    world.scene.height = 20;
    const action = { actorId: "u", text: "Glance over notes and mentally prepare questions." };
    const still: ActionSemantics = { moves: false, speaks: false, quotedSpeech: [] };
    const teleport = validateConsequence(
      world,
      {
        ...baseResult("U glances over notes."),
        actorPatches: [{ actorId: "u", x: 14, y: 14, thoughts: "Zone." }],
      },
      action,
      still,
    );
    expect(teleport.valid).toBe(false);
    expect(errorText(teleport.errors)).toMatch(/stay in place/);

    const stayed = validateConsequence(
      world,
      {
        ...baseResult("U glances over notes, staying seated."),
        actorPatches: [{ actorId: "u", thoughts: "Zone." }],
      },
      action,
      still,
    );
    expect(stayed).toEqual({ valid: true, errors: [] });
  });

  it("sit may settle locally but never teleport", () => {
    const world = makeTinyWorld();
    world.scene.width = 20;
    world.scene.height = 20;
    const action = { actorId: "u", text: "Sit on the chair at my desk." };
    const still = stillSemantics();
    const settle = validateConsequence(
      world,
      {
        ...baseResult("U sits on the chair at the desk."),
        actorPatches: [{ actorId: "u", x: 2, y: 1, pose: "sit", thoughts: "Settled." }],
      },
      action,
      still,
    );
    expect(settle).toEqual({ valid: true, errors: [] });

    const flung = validateConsequence(
      world,
      {
        ...baseResult("U sits on a far chair."),
        actorPatches: [{ actorId: "u", x: 14, y: 14, pose: "sit", thoughts: "Settled." }],
      },
      action,
      still,
    );
    expect(flung.valid).toBe(false);
    expect(errorText(flung.errors)).toMatch(/stay in place/);
  });

  it("rejects token shuffles toward distant actors (tick-15 actor variant)", () => {
    const world = makeTinyWorld();
    world.scene.width = 20;
    world.scene.height = 20;
    world.actors.find((a) => a.id === "u")!.x = 0;
    world.actors.find((a) => a.id === "u")!.y = 0;
    world.actors.find((a) => a.id === "n")!.x = 15;
    world.actors.find((a) => a.id === "n")!.y = 15;
    const action = { actorId: "u", text: "Walk toward N." };
    const semantics: ActionSemantics = {
      moves: true, destinationActorId: "n", speaks: false, quotedSpeech: [],
    };
    const shuffle = validateConsequence(
      world,
      {
        ...baseResult("U steps toward N."),
        actorPatches: [{ actorId: "u", x: 1, y: 0, thoughts: "Going." }],
      },
      action,
      semantics,
    );
    expect(shuffle.valid).toBe(false);
    expect(errorText(shuffle.errors)).toMatch(/real progress/);

    const stride = validateConsequence(
      world,
      {
        ...baseResult("U strides toward N."),
        actorPatches: [{ actorId: "u", x: 4, y: 4, thoughts: "Going." }],
      },
      action,
      semantics,
    );
    expect(stride).toEqual({ valid: true, errors: [] });
  });

  it("glance turns resolve without forced movement end to end (tick-20 shape)", async () => {
    const logger = new Logger({ sessionId: "exp3-phase2-glance", writeToFile: false });
    const world = makeTinyWorld();
    world.scene.width = 20;
    world.scene.height = 20;
    const action = { actorId: "u", text: "Glance over notes and mentally prepare questions." };
    // A well-behaved consequence stays in place: passes, no repair, no fallback.
    const staying = {
      narrative: "U glances over the notes, staying seated.",
      actorPatches: [{ actorId: "u", thoughts: "Back in the zone." }],
      objectPatches: [],
      reasoning: "r",
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(staying) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const out = await resolveWithValidation(world, action, deps);
    expect(out.narrative).not.toBe("Nothing changes.");
    expect(logger.store.byEvent("movement_repaired")).toHaveLength(0);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);

    // A stubborn teleporter on the same glance action fails instead of passing.
    const teleporting = {
      narrative: "U glances over notes.",
      actorPatches: [{ actorId: "u", x: 14, y: 14, thoughts: "Zone." }],
      objectPatches: [],
      reasoning: "r",
    };
    const deps2 = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(teleporting) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const out2 = await resolveWithValidation(world, action, deps2);
    expect(out2.narrative).toBe("Nothing changes.");
  });
});

describe("phase4 partial-apply fallback (plan Phase 4)", () => {
  it("isSpeechOnlyFailure covers lost questions and silent-behavior swaps", () => {
    // F2: codes, not prose.
    expect(
      isSpeechOnlyFailure([
        { code: "speech.question_dropped", message: "action asks a question but the narrative keeps no question" },
      ]),
    ).toBe(true);
    expect(
      isSpeechOnlyFailure([
        { code: "speech.no_speech_rendered", message: "action says something but the narrative renders no speech" },
      ]),
    ).toBe(true);
    // Speech nit mixed with a physics error is still a hard failure.
    expect(
      isSpeechOnlyFailure([
        { code: "speech.dropped_words", message: "narrative drops the acting actor's exact words" },
        { code: "actor.out_of_bounds", message: "actor u: coordinates outside scene bounds" },
      ]),
    ).toBe(false);
  });

  it("salvages valid movement + dropped question + stray patch with warnings (tick-3 degraded shape)", () => {
    const world = officeWorld();
    world.actors.find((a) => a.id === "u")!.x = 3;
    world.actors.find((a) => a.id === "u")!.y = 3;
    const action = { actorId: "u", text: 'Walk to the coffee machine and ask "is this my spot?"' };
    const semantics: ActionSemantics = {
      moves: true, destinationObjectId: "coffee_machine",
      speaks: true, quotedSpeech: ["is this my spot?"],
    };
    const out = trySalvageConsequence(
      world,
      action,
      {
        narrative: "Anton walks to the coffee machine.",
        actorPatches: [
          { actorId: "u", x: 1, y: 1, thoughts: "Coffee time." },
          { actorId: "jeff", thoughts: "Hello." },
        ],
        objectPatches: [],
        reasoning: "r",
      },
      semantics,
    );
    expect(out).not.toBeNull();
    // Degraded-but-advancing: movement kept, hallucination stripped.
    expect(out!.salvaged.actorPatches.some((p) => p.actorId === "u" && p.x === 1 && p.y === 1)).toBe(true);
    expect(out!.salvaged.actorPatches.some((p) => p.actorId === "jeff")).toBe(false);
    // Exp-3 item 3 (S4): the dropped question is reinserted
    // deterministically — marked with the honest quote_reinserted note.
    expect(out!.warnings.some((w) => w.code === "salvage.quote_reinserted")).toBe(true);
    expect(out!.salvaged.narrative).toContain("is this my spot?");
  });

  it("repairs missing movement in salvage when locomotion is implied", () => {
    const world = officeWorld();
    world.actors.find((a) => a.id === "u")!.x = 3;
    world.actors.find((a) => a.id === "u")!.y = 3;
    const action = { actorId: "u", text: "Walk to the coffee machine." };
    const out = trySalvageConsequence(
      world,
      action,
      {
        // Narrates the walk but omits the x/y patch (weak-LLM shape).
        narrative: "Anton walks to the coffee machine.",
        actorPatches: [{ actorId: "u", thoughts: "Going." }],
        objectPatches: [],
        reasoning: "r",
      },
      { moves: true, destinationObjectId: "coffee_machine", speaks: false, quotedSpeech: [] },
    );
    expect(out).not.toBeNull();
    const moved = out!.salvaged.actorPatches.find((p) => p.actorId === "u")!;
    expect(moved.x).toBeDefined();
    expect(moved.y).toBeDefined();
    expect([moved.x, moved.y]).not.toEqual([3, 3]);
  });

  it("does not repair glance turns: no locomotion, no movement", () => {
    const world = officeWorld();
    const out = trySalvageConsequence(
      world,
      { actorId: "u", text: "Glance over the notes." },
      {
        narrative: "Anton glances over the notes.",
        actorPatches: [{ actorId: "u", thoughts: "Zone." }],
        objectPatches: [],
        reasoning: "r",
      },
      stillSemantics(),
    );
    // Already valid as-is (in place) — salvaged clean, never moved.
    expect(out).not.toBeNull();
    expect(out!.warnings).toEqual([]);
    expect(out!.salvaged.actorPatches.find((p) => p.actorId === "u")!.x).toBeUndefined();
  });

  it("tier-2 salvages movement when object wording fails, still refuses contact gaps", () => {
    const world = officeWorld();
    world.actors.find((a) => a.id === "u")!.x = 3;
    world.actors.find((a) => a.id === "u")!.y = 3;
    // Pour verb dropped with no backing patch (tick-9 verb-drop shape).
    // Exp-5 item 1: tier-2 salvage advances the movement with the pour
    // miss logged as a warning instead of freezing the whole turn.
    const pour = trySalvageConsequence(
      world,
      { actorId: "u", text: "Walk to the coffee machine and pour a coffee." },
      {
        narrative: "Anton approaches the coffee machine, standing beside it.",
        actorPatches: [{ actorId: "u", x: 1, y: 1, thoughts: "Coffee time." }],
        objectPatches: [],
        reasoning: "r",
      },
      { moves: true, destinationObjectId: "coffee_machine", speaks: false, quotedSpeech: [] },
    );
    expect(pour).not.toBeNull();
    expect(pour!.salvaged.actorPatches.find((p) => p.actorId === "u")!.x).toBe(1);
    expect(errorText(pour!.warnings)).toMatch(/pour\/brew\/open/);

    // Far handshake with no adjacency (tick-12 shape): u (1,1), n (4,4).
    const contact = trySalvageConsequence(
      officeWorld(),
      { actorId: "u", text: "Shake Nadia's hand warmly." },
      {
        narrative: "Anton shakes Nadia's hand.",
        actorPatches: [
          { actorId: "u", thoughts: "Firm grip." },
          { actorId: "n", thoughts: "Welcome!" },
        ],
        objectPatches: [],
        reasoning: "r",
      },
      stillSemantics(),
    );
    expect(contact).toBeNull();
  });

  it("resolveWithValidation guides prose-only retry, then salvages (tick-9 end to end)", async () => {
    const logger = new Logger({ sessionId: "exp3-phase4-retry", writeToFile: false });
    const world = officeWorld();
    world.actors.find((a) => a.id === "u")!.x = 3;
    world.actors.find((a) => a.id === "u")!.y = 3;
    const seenFeedback: (string | undefined)[] = [];
    const bad: ConsequenceResult = {
      narrative: "Anton approaches the coffee machine, standing beside it.",
      actorPatches: [
        { actorId: "u", x: 1, y: 1, thoughts: "Coffee time." },
        { actorId: "jeff", thoughts: "Hello." },
      ],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: true, destinationObjectId: "coffee_machine", spoke: false },
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: {
        resolve: async (_w: World, _a: { actorId: string; text: string }, feedback?: string) => {
          seenFeedback.push(feedback);
          return structuredClone(bad);
        },
      } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 1, autosaveEnabled: false },
    });
    const out = await resolveWithValidation(
      world,
      { actorId: "u", text: "Walk to the coffee machine." },
      deps,
    );
    // Degraded-but-advancing instead of "Nothing changes.": movement kept.
    expect(out.narrative).not.toBe("Nothing changes.");
    expect(out.actorPatches.some((p) => p.actorId === "u" && p.x === 1 && p.y === 1)).toBe(true);
    expect(out.actorPatches.some((p) => p.actorId === "jeff")).toBe(false);
    expect(logger.store.byEvent("partial_applied")).toHaveLength(1);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    // The retry was told to keep patches and fix prose only.
    expect(seenFeedback[1]).toMatch(/keep the remaining valid patches|keep every actorPatch/);
  });

  it("summarizeTurnOutcomes tracks clean / salvaged / fallback separately", async () => {
    const logger = new Logger({ sessionId: "exp3-phase4-rates", writeToFile: false });

    // Clean turn: default mock engine validates first try.
    const cleanDeps = makeTestDeps(logger, {
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    await resolveWithValidation(makeTinyWorld(), { actorId: "u", text: "Wave." }, cleanDeps);

    // Salvaged turn: valid movement + stray patch, speech-clean.
    const salvagedWorld = officeWorld();
    salvagedWorld.actors.find((a) => a.id === "u")!.x = 3;
    salvagedWorld.actors.find((a) => a.id === "u")!.y = 3;
    const salvaged: ConsequenceResult = {
      narrative: "Anton approaches the coffee machine, standing beside it.",
      actorPatches: [
        { actorId: "u", x: 1, y: 1, thoughts: "Coffee time." },
        { actorId: "jeff", thoughts: "Hello." },
      ],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: true, destinationObjectId: "coffee_machine", spoke: false },
    };
    const salvagedDeps = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(salvaged) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    await resolveWithValidation(
      salvagedWorld,
      { actorId: "u", text: "Walk to the coffee machine." },
      salvagedDeps,
    );

    // Fallback turn: unrepairable physics (out of bounds, no locomotion).
    const fallbackDeps = makeTestDeps(logger, {
      consequenceEngine: {
        resolve: async () => ({
          narrative: "Teleport!",
          actorPatches: [{ actorId: "u", x: 999, y: 999 }],
          objectPatches: [],
          reasoning: "bad",
        }),
      } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const fell = await resolveWithValidation(makeTinyWorld(), { actorId: "u", text: "Wave." }, fallbackDeps);
    expect(fell.narrative).toBe("Nothing changes.");

    const summary = summarizeTurnOutcomes(logger.store.all());
    expect(summary).toMatchObject({ clean: 1, salvaged: 1, fallback: 1, total: 3 });
    expect(summary.cleanRate).toBeCloseTo(1 / 3);
    expect(summary.salvagedRate).toBeCloseTo(1 / 3);
    expect(summary.fallbackRate).toBeCloseTo(1 / 3);
    expect(summary.degradedRate).toBeCloseTo(1 / 3);
    expect(summarizeTurnOutcomes([])).toMatchObject({ clean: 0, salvaged: 0, fallback: 0, total: 0 });
  });
});
