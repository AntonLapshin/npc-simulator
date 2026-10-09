// Regression tests for experiment-5.md action items 1-8
// (office-anton.json, 7 adaptive user turns, local 8B, ticks 0-20).
import { describe, expect, it } from "vitest";
import { validateConsequence } from "../../src/engine/physicalValidator.js";
import { resolveDestinationObjectId } from "../../src/engine/deterministicSemantics.js";
import {
  MAX_STEP_DISTANCE,
} from "../../src/core/movement.js";
import { computeMovementOutcome } from "../../src/core/movement.js";
import {
  consecutiveFallbacks,
  getHonestHistoryNote,
  isTier2Salvageable,
  resolveWithValidation,
  runTurn,
  trySalvageConsequence,
} from "../../src/engine/turnOrchestrator.js";
import {
  applyConsequence,
  isPartialHistoryEntry,
} from "../../src/engine/patchApplier.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import {
  detectIdentityLeak,
  getOpenQuestions,
  getRecentOwnActions,
  validateSelectionForActor,
} from "../../src/engine/contextBuilder.js";
import { Logger, createTestLogger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld, hist, errorText, triedHist } from "../helpers.js";
import type { ActionSemantics, ConsequenceResult, World } from "../../src/types.js";

function baseResult(narrative = "Something happens."): ConsequenceResult {
  return { narrative, actorPatches: [], objectPatches: [], reasoning: "r" };
}

/** Office-anton-shaped world with lamp/sign/laptop props (Exp-5 §4.3 repros). */
function antonWorldWithProps(): World {
  const world = makeTinyWorld();
  world.scene.width = 20;
  world.scene.height = 20;
  const [anton, tanya] = world.actors;
  anton!.id = "anton";
  anton!.name = "Anton";
  anton!.x = 6;
  anton!.y = 8;
  tanya!.id = "tanya";
  tanya!.name = "Tanya";
  tanya!.x = 8;
  tanya!.y = 7;
  world.actors.push({
    id: "dana", name: "Dana", persona: "Dana is a recruiter.",
    x: 15, y: 11, state: "sitting", emotion: "stressed",
    goal: "Screen candidates.", thoughts: "t", memories: [], beliefs: [], relationships: [],
  });
  world.order = ["anton", "tanya", "dana"];
  world.scene.objects.push(
    { id: "anton_desk", name: "Anton's desk", description: "A fresh desk.", x: 3, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false },
    { id: "tanya_desk", name: "Tanya's desk", description: "A desk.", x: 7, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false },
    { id: "anton_laptop", name: "Anton's laptop", description: "A new laptop.", x: 4, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    { id: "tanya_laptop", name: "Tanya's laptop", description: "An open laptop.", x: 8, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    { id: "anton_lamp", name: "Desk lamp", description: "A small desk lamp on Anton's desk.", x: 5, y: 9, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    { id: "anton_sign", name: "Anton's desk sign", description: "A name-plate reading ANTON.", x: 5, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
  );
  return world;
}

describe("exp5-3 ranked destination resolution (ticks 3/15/18/19)", () => {
  it("plural 'desks' with a grab verb in the same clause still resolves the desk (tick 18)", () => {
    const world = antonWorldWithProps();
    expect(
      resolveDestinationObjectId(
        world,
        "Thank both, head toward the west-side desks to set up laptop.",
        "anton",
      ),
    ).toBe("anton_desk");
  });

  it("'desk with ANTON sign' resolves the desk, never the lamp or sign (ticks 3/15)", () => {
    const world = antonWorldWithProps();
    expect(
      resolveDestinationObjectId(world, "Walk to the desk with the ANTON sign and sit.", "anton"),
    ).toBe("anton_desk");
  });

  it("grab-only clauses still resolve props (no walk tokens)", () => {
    const world = antonWorldWithProps();
    expect(resolveDestinationObjectId(world, "Open the laptop to set it up.", "anton")).toBe(
      "anton_laptop",
    );
  });
});

describe("exp5-4 triple-verb semantics (tick 15)", () => {
  it("bare 'open laptop' plans like 'open my laptop' (no prose luck, Phase 3)", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "u_laptop", name: "U's laptop", description: "A laptop.",
      x: 1, y: 2, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    for (const text of [
      "Sit down and open laptop to set up.",
      "Sit down and open my laptop to set up.",
    ]) {
      // Phase 3: the engine plans the laptop pick-up from either phrasing
      // (the determiner never mattered to the planner) — no model patch
      // demanded, no prose luck.
      const action = { actorId: "u", text };
      const outcome = executeManipulation(world, action);
      expect(outcome, text).not.toBeNull();
      expect(outcome!.plan.kind, text).toBe("pick-up");
      expect(outcome!.plan.propName, text).toBe("laptop");
      const v = validateConsequence(
        world,
        {
          ...baseResult("U sits down at the desk."),
          actorPatches: [{ actorId: "u", pose: "sit", thoughts: "Settling in." }],
        },
        action,
        { moves: false, speaks: false, quotedSpeech: [] },
        undefined,
        outcome,
      );
      expect(v.valid, text).toBe(true);
    }
  });

  it("'open' as an adjective never trips the gate", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U stands nearby, calm."),
        actorPatches: [{ actorId: "u", thoughts: "Waiting." }],
      },
      { actorId: "u", text: "Stand there with an open and welcoming demeanor." },
      { moves: false, speaks: false, quotedSpeech: [] },
    );
    expect(errorText(v.errors)).not.toMatch(/pour\/brew\/open/);
  });
});

describe("exp5-8 explanation pressure (ticks 14/20)", () => {
  it("an explanation narrated as silent behavior fails the topic gate", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U looks up from the monitor."),
        actorPatches: [
          { actorId: "u", thoughts: "Busy." },
          { actorId: "n", thoughts: "Waiting." },
        ],
      },
      { actorId: "u", text: "Nod and start explaining N's first task." },
      { moves: false, speaks: true, quotedSpeech: [] },
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/topic/);
  });

  it("an explanation that keeps the topic passes", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U nods and explains the first backend task to N."),
        actorPatches: [
          { actorId: "u", thoughts: "Onboarding." },
          { actorId: "n", thoughts: "Got it." },
        ],
      },
      { actorId: "u", text: "Nod and start explaining N's first task." },
      {
        moves: false,
        speaks: true,
        quotedSpeech: [],
        addresseeActorId: "n",
      },
    );
    expect(v).toEqual({ valid: true, errors: [] });
  });

  it("'describe the layout' narrated as a greeting substitute fails", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U greets N warmly."),
        actorPatches: [
          { actorId: "u", x: 2, y: 2, thoughts: "Going." },
          { actorId: "n", thoughts: "Hi." },
        ],
      },
      { actorId: "u", text: "Walk over and describe the office layout." },
      { moves: true, speaks: true, quotedSpeech: [] },
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/topic/);
  });
});

describe("exp5-1 tier-2 salvage (ticks 6/9/12/18)", () => {
  it("isTier2Salvageable covers speech/object wording, not physics/contact/discipline", () => {
    // F2: codes, not prose.
    expect(
      isTier2Salvageable([
        { code: "speech.dropped_words", message: "narrative drops the acting actor's exact words" },
        { code: "object.phantom_manipulation", message: "narrative describes pick-up but the engine executed no manipulation" },
      ]),
    ).toBe(true);
    expect(
      isTier2Salvageable([{ code: "speech.topic_dropped", message: "narrative keeps none of its topic words" }]),
    ).toBe(true);
    expect(isTier2Salvageable([])).toBe(false);
    expect(
      isTier2Salvageable([{ code: "movement.over_step_cap", message: "acting actor (u) moves 13.0 cells in one turn" }]),
    ).toBe(false);
    expect(
      isTier2Salvageable([
        { code: "contact.action_too_far", message: "action implies physical contact with n but ends at (1, 1), 4.2 cells away" },
      ]),
    ).toBe(false);
    expect(
      isTier2Salvageable([
        { code: "narrative.observer_as_subject", message: 'narrative casts roster observer "n" as the acting subject' },
      ]),
    ).toBe(false);
  });

  it("tick-6 shape: engine movement + sit + question salvages with warnings", () => {
    const world = antonWorldWithProps();
    world.actors.find((a) => a.id === "anton")!.x = 16;
    world.actors.find((a) => a.id === "anton")!.y = 2;
    const logger = createTestLogger();
    const semantics = {
      moves: true,
      destinationActorId: "tanya",
      speaks: true,
      quotedSpeech: ["Is this my spot?"],
      addresseeActorId: "tanya",
    };
    // Phase 1: the orchestrator merges the engine-computed step before
    // salvage runs — salvage keeps it (the old clamp-repair tier is
    // deleted; salvage never fabricates coordinates).
    const engine = computeMovementOutcome(world, "anton", { destinationActorId: "tanya" }, null)!;
    const out = trySalvageConsequence(
      world,
      { actorId: "anton", text: 'Walk to Tanya, sit, and ask "Is this my spot?"' },
      {
        // Over-cap model claim replaced by the engine step; quote dropped.
        narrative: "Anton walks toward Tanya.",
        actorPatches: [{ actorId: "anton", x: engine.x, y: engine.y, thoughts: "Going." }],
        objectPatches: [],
        reasoning: "r",
      },
      semantics,
      logger,
    );
    expect(out).not.toBeNull();
    const moved = out!.salvaged.actorPatches.find((p) => p.actorId === "anton")!;
    expect(moved.x).toBe(engine.x);
    expect(moved.y).toBe(engine.y);
    expect(Math.hypot(moved.x! - 16, moved.y! - 2)).toBeLessThanOrEqual(
      MAX_STEP_DISTANCE + 1e-9,
    );
    // Addressee reaction repaired deterministically; speech/object wording warned.
    expect(out!.salvaged.actorPatches.some((p) => p.actorId === "tanya")).toBe(true);
    expect(errorText(out!.warnings)).toMatch(/exact words|keeps no question/);
    expect(getHonestHistoryNote(out!.salvaged)).toMatch(/partial/);
  });

  it("still refuses far contact and observer-subject prose", () => {
    const world = makeTinyWorld();
    const contact = trySalvageConsequence(
      world,
      { actorId: "u", text: "Shake N's hand warmly." },
      {
        narrative: "U shakes N's hand.",
        actorPatches: [{ actorId: "u", thoughts: "Grip." }],
        objectPatches: [],
        reasoning: "r",
      },
      { moves: false, speaks: false, quotedSpeech: [], contactActorId: "n" },
      createTestLogger(),
    );
    expect(contact).toBeNull();
  });
});

describe("exp5-2 salvaged-history honesty (ticks 3/15)", () => {
  it("salvaged turns record the narrative + warnings, never the raw action", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Walk to N and ask where my desk is?" };
    const salvaged: ConsequenceResult = {
      narrative: "U greets N.",
      actorPatches: [
        { actorId: "u", x: 2, y: 2, thoughts: "Going." },
        { actorId: "n", thoughts: "Hello." },
      ],
      objectPatches: [],
      reasoning: "r",
    };
    const next = applyConsequence(world, salvaged, action, undefined, {
      honestHistoryNote: "partial: keeps no question",
    });
    const entry = next.history.at(-1)!;
    // F6: entries are { text, perceivers } objects now.
    expect(entry.text).toContain("U greets N.");
    expect(entry.text).toContain("(partial)");
    expect(entry.text).not.toContain("where my desk is");
    expect(isPartialHistoryEntry(entry)).toBe(true);
    // The dropped question never becomes an open question for N.
    expect(getOpenQuestions(next, "n")).toEqual([]);
    // …while a salvaged narrative that KEEPS the question stays open.
    const kept = applyConsequence(
      world,
      { ...salvaged, narrative: "U walks to N and asks where his desk is?" },
      action,
      undefined,
      { honestHistoryNote: "partial" },
    );
    expect(getOpenQuestions(kept, "n").length).toBe(1);
  });

  it("end-to-end: a salvaged user turn logs narrative history", async () => {
    // Phase 2: the exact (first) quote is repaired in-loop by the
    // deterministic backstop, so a turn that reaches salvage drops the
    // action's SECOND quote — a speech nit (multi-quote choreography is a
    // non-goal) that salvage tier 1 downgrades to a warning.
    const logger = new Logger({ sessionId: "exp5-honest", writeToFile: false });
    const quoteDrop: ConsequenceResult = {
      narrative: 'U walks toward N. U says "Where is my desk?"',
      actorPatches: [{ actorId: "u", x: 2, y: 2, thoughts: "Going." }],
      objectPatches: [],
      reasoning: "r",
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(quoteDrop) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const world = makeTinyWorld();
    deps.getUserAction = async () => 'Walk to N and ask "Where is my desk?" then add "thanks a lot!"';
    const next = await runTurn(world, deps);
    expect(logger.store.byEvent("partial_applied")).toHaveLength(1);
    // Narrative-based history: the exact quote is preserved verbatim in
    // the narrative AND the engine intervention is marked honestly.
    // Exp-7 item A9: the history note is plain language; the validator
    // code stays on the log record only.
    expect(next.history.at(-1)!.text).toMatch(/^U: U walks toward N\. U says "Where is my desk\?" \(partial\)/);
    expect(next.history.at(-1)!.text).toContain("partial — some dialogue was improvised");
    expect(next.history.at(-1)!.text).not.toContain("quote_reinserted");
    const partialLog = logger.store.byEvent("partial_applied");
    expect(partialLog).toHaveLength(1);
    expect(JSON.stringify(partialLog[0])).toContain("speech.dropped_words");
    // Phase 1: the scripted (2,2) is ignored — the engine computes the step.
    const engine = computeMovementOutcome(makeTinyWorld(), "u", {}, null)!;
    expect(next.actors.find((a) => a.id === "u")!.x).toBe(engine.x);
    expect(next.actors.find((a) => a.id === "u")!.y).toBe(engine.y);
    // …and because the question is kept, it stays open for N.
    expect(getOpenQuestions(next, "n").length).toBe(1);
  });
});

describe("exp5-5/7 selection guard (ticks 4/7/13/16/19/20)", () => {
  it("validateSelectionForActor flags POV swaps and repeats, passes clean picks", () => {
    const world = antonWorldWithProps();
    expect(validateSelectionForActor(world, "dana", "Anton walks over and introduces himself.")).toMatch(
      /identity leak/,
    );
    expect(
      validateSelectionForActor(world, "dana", "Anton plans to shadow Dana today."),
    ).toMatch(/identity leak/);
    world.history.push(hist(world, "Tanya: Shake Anton's hand warmly."));
    expect(
      validateSelectionForActor(world, "tanya", "Stand up and shake Anton's hand."),
    ).toMatch(/repetition/);
    expect(
      validateSelectionForActor(world, "tanya", "Walk to the coffee machine and pour a coffee."),
    ).toBeUndefined();
  });

  it("runTurn substitutes a clean candidate instead of burning consequence attempts", async () => {
    const logger = new Logger({ sessionId: "exp5-guard", writeToFile: false });
    const world = makeTinyWorld();
    world.userActorId = "u";
    world.turnIndex = 1; // N's turn
    world.history.push(hist(world, "N: Shake U's hand warmly."));
    const { MockProposalEngine } = await import("../../src/mocks/mockProposalEngine.js");
    const { MockSelectionEngine } = await import("../../src/mocks/mockSelectionEngine.js");
    const { MockConsequenceEngine } = await import("../../src/mocks/mockConsequenceEngine.js");
    const deps = makeTestDeps(logger, {
      proposalEngine: new MockProposalEngine(logger, {
        [`n@tick0`]: {
          suggestions: ["Stand up and shake U's hand.", "Stay at the desk and continue working."],
          reasoning: "scripted",
        },
      }),
      selectionEngine: new MockSelectionEngine(logger, {
        [`n@tick0`]: { action: "Stand up and shake U's hand.", reasoning: "scripted repeat" },
      }),
      consequenceEngine: new MockConsequenceEngine(logger),
    });
    const next = await runTurn(world, deps);
    expect(logger.store.byEvent("selection_rejected")).toHaveLength(1);
    expect(logger.store.byEvent("selection_substituted")).toHaveLength(1);
    expect(next.history.at(-1)!.text).toContain("Stay at the desk and continue working.");
  });
});

describe("exp5-6 NPC liveness floor (Tanya 7 / Dana 7 fallbacks)", () => {
  function fallenWorld(): World {
    const world = makeTinyWorld();
    world.userActorId = "u";
    // N fell back 3 consecutive own turns (interleaved with U's applied turns).
    world.history.push(
      triedHist(world, "N tried: Stand up and walk over."),
      hist(world, "U: Wave."),
      triedHist(world, "N tried: Stand up and walk over."),
      hist(world, "U: Wave."),
      triedHist(world, "N tried: Stand up and walk over."),
    );
    return world;
  }

  it("consecutiveFallbacks counts own streaks, ignoring interleaved actors", () => {
    const world = fallenWorld();
    expect(consecutiveFallbacks(world, "n")).toBe(3);
    expect(consecutiveFallbacks(world, "u")).toBe(0);
    world.history.push(hist(world, "N: Stay at the desk and continue working."));
    expect(consecutiveFallbacks(world, "n")).toBe(0);
  });

  it("resolveWithValidation applies liveness instead of a 4th fallback (NPC only)", async () => {
    const logger = new Logger({ sessionId: "exp5-liveness", writeToFile: false });
    // Unrepairable: hallucinated patch only, no locomotion implied.
    const bad: ConsequenceResult = {
      narrative: "N ponders.",
      actorPatches: [{ actorId: "jeff", thoughts: "Hi." }],
      objectPatches: [],
      reasoning: "bad",
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(bad) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const out = await resolveWithValidation(fallenWorld(), { actorId: "n", text: "Wait quietly." }, deps);
    expect(out.narrative).toContain("holds position");
    expect(out.actorPatches).toHaveLength(1);
    expect(logger.store.byEvent("liveness_applied")).toHaveLength(1);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    expect(getHonestHistoryNote(out)).toBe("liveness floor");
  });

  it("user turns still fall back (never rewritten)", async () => {
    const logger = new Logger({ sessionId: "exp5-liveness-user", writeToFile: false });
    const world = fallenWorld();
    world.history.push(
      triedHist(world, "U tried: Walk over."),
      triedHist(world, "U tried: Walk over."),
      triedHist(world, "U tried: Walk over."),
    );
    const bad: ConsequenceResult = {
      narrative: "U ponders.",
      actorPatches: [{ actorId: "jeff", thoughts: "Hi." }],
      objectPatches: [],
      reasoning: "bad",
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(bad) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const out = await resolveWithValidation(
      world,
      { actorId: "u", text: "Wait quietly." },
      deps,
      { allowLiveness: false },
    );
    expect(out.narrative).toBe("Nothing changes.");
  });
});
