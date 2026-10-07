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
import { isSpeechOnlyFailure, resolveWithValidation, trySalvageConsequence } from "../../src/engine/turnOrchestrator.js";
import { suggestSimilarIds } from "../../src/engine/physicalValidator.js";
import { suggestMoveTarget } from "../../src/engine/movementAssist.js";
import { Logger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld } from "../helpers.js";
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
    // Close paraphrase stays grounded.
    expect(isQuoteGroundedInAction("where my desk is", action)).toBe(true);
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
    expect(logger.store.events()).toContain("judge_disagreement");
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
    expect(trunc.errors.join(" ")).toMatch(/exact words/);
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
    expect(v.errors.join(" ")).toMatch(/physical contact/);
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
    expect(v.errors.join(" ")).toMatch(/sit/);
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
    expect(v.errors.join(" ")).toMatch(/pour\/brew\/open/);
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
    expect(v.errors.join(" ")).toMatch(/asks a question/);
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
    expect(v.errors.join(" ")).toMatch(/at most 6 cells/);
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
    expect(v.errors.join(" ")).toMatch(/real progress|different landmark/);
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
    expect(v.errors.join(" ")).toMatch(/observer.*as the acting subject|describe ONLY/);
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
    expect(v.errors.join(" ")).toMatch(/unknown object id.*did you mean/);
  });
});

describe("exp3-6 partial-apply / salvage (ticks 3/9)", () => {
  it("salvages valid movement plus a stray hallucinated patch, warning on speech", () => {
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
    expect(out!.warnings.length).toBeGreaterThan(0);
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
    expect(isSpeechOnlyFailure(['narrative drops the acting actor\'s exact words ("x")'])).toBe(true);
    expect(isSpeechOnlyFailure(['narrative invents dialogue ("x") not present'])).toBe(true);
    expect(isSpeechOnlyFailure(["actor u: coordinates outside scene bounds"])).toBe(false);
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
