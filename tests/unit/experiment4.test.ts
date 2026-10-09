// Regression tests for experiment-4.md action items 1-10
// (office-anton.json, 7 adaptive user turns, local 8B, ticks 0-20).
import { describe, expect, it } from "vitest";
import { validateConsequence } from "../../src/engine/physicalValidator.js";
import {
  applyDeterministicGrounding,
  isQuoteGroundedInAction,
  resolveActionSemantics,
} from "../../src/engine/actionSemantics.js";
import {
  hasSpeechToken,
  resolveDestinationObjectId,
} from "../../src/engine/deterministicSemantics.js";
import {
  clampMoveToCap,
  computeMovementOutcome,
  MAX_STEP_DISTANCE,
} from "../../src/core/movement.js";
import {
  isFallbackConsequence,
  resolveWithValidation,
  trySalvageConsequence,
} from "../../src/engine/turnOrchestrator.js";
import { applyConsequence, isFallbackHistoryEntry } from "../../src/engine/patchApplier.js";
import {
  buildProposalContext,
  detectIdentityLeak,
  findCoreRepeat,
  getOpenQuestions,
  getRecentOwnActions,
  suggestionCore,
} from "../../src/engine/contextBuilder.js";
import { MockSemanticJudge } from "../../src/mocks/mockSemanticJudge.js";
import { Logger, createTestLogger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld, hist, errorText, triedHist } from "../helpers.js";
import { NOT_DONE_SENTINEL } from "../../src/types.js";
import type { ActionSemantics, ConsequenceResult, World } from "../../src/types.js";

function baseResult(narrative = "Something happens."): ConsequenceResult {
  return { narrative, actorPatches: [], objectPatches: [], reasoning: "r" };
}

function stillSemantics(): ActionSemantics {
  return { moves: false, speaks: false, quotedSpeech: [] };
}

/** Office-anton-shaped world: entrance spawn ~14 cells from the desks. */
function antonWorld(): World {
  const world = makeTinyWorld();
  world.scene.width = 20;
  world.scene.height = 20;
  const [anton, tanya] = world.actors;
  anton!.id = "anton";
  anton!.name = "Anton";
  anton!.x = 16;
  anton!.y = 2;
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
    { id: "anton_desk", name: "Anton's desk", description: "A fresh desk.", x: 3, y: 8, w: 3, h: 1, passable: false, blocksVision: false, blocksSound: false },
    { id: "tanya_desk", name: "Tanya's desk", description: "A desk.", x: 7, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false },
    { id: "anton_sign", name: "Anton's desk sign", description: "A name-plate reading ANTON.", x: 5, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    { id: "anton_laptop", name: "Anton's laptop", description: "A new laptop.", x: 4, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    { id: "tanya_laptop", name: "Tanya's laptop", description: "An open laptop.", x: 8, y: 8, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    { id: "coffee_machine", name: "Coffee machine", description: "Coffee.", x: 2, y: 1, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
    { id: "lounge_mug", name: "Lounge mug", description: "A leftover mug.", x: 5, y: 14, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false },
  );
  return world;
}

describe("exp4-4 quote grounding at apostrophes (tick 5)", () => {
  it("rejects mid-word truncations as ungrounded", () => {
    const action = `Walk to the lounge and ask "Why don't we take a 10-minute break?"`;
    expect(isQuoteGroundedInAction("Why don", action)).toBe(false);
    expect(isQuoteGroundedInAction("Why don't we take a 10-minute break?", action)).toBe(true);
  });

  it("drops truncated quotes in grounding, keeping the full action quote", () => {
    const world = makeTinyWorld();
    const full = "Why don't we take a 10-minute break?";
    const { semantics, disagreements } = applyDeterministicGrounding(
      world,
      { actorId: "u", text: `Walk over and ask "${full}"` },
      { moves: true, speaks: true, quotedSpeech: [full, "Why don"] },
      { moves: true, speaks: true, quotedSpeech: [full] },
      { moves: true, speaks: true, quotedSpeech: ["Why don"] },
    );
    expect(semantics!.quotedSpeech).toEqual([full]);
    expect(disagreements.join(" ")).toMatch(/truncated quote/);
  });
});

describe("exp4-3 unquoted speech (tick 14)", () => {
  it("hasSpeechToken fires on explaining/nodding/thanking verbs and ?", () => {
    expect(hasSpeechToken("Nod and start explaining Anton's first task")).toBe(true);
    expect(hasSpeechToken("Thank both for the welcome")).toBe(true);
    expect(hasSpeechToken("Is this my spot?")).toBe(true);
    expect(hasSpeechToken("Walk to the desk.")).toBe(false);
    expect(hasSpeechToken("Glance over notes and mentally prepare questions.")).toBe(false);
  });

  it("mock judge marks unquoted explanations as speech", async () => {
    const world = makeTinyWorld();
    const s = await new MockSemanticJudge().classify(world, {
      actorId: "u",
      text: "Nod and start explaining the first task.",
    });
    expect(s.speaks).toBe(true);
  });

  it("grounding forces speaks=true for unquoted speech verbs", async () => {
    const world = makeTinyWorld();
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "u", text: "Nod and start explaining the first task." },
      { ...baseResult("U looks up from the monitor."), actorPatches: [{ actorId: "u", thoughts: "Onboarding." }] },
      {
        async classify(): Promise<ActionSemantics> {
          return { moves: false, speaks: false, quotedSpeech: [] };
        },
      },
      createTestLogger(),
    );
    expect(resolved.semantics!.speaks).toBe(true);
    expect(resolved.disagreements!.join(" ")).toMatch(/speaks deterministic override/);
  });

  it("hollow look-up fails the speech gate once speech is detected", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      { ...baseResult("Dana looks up from his monitor, seeing Anton walk in."), actorPatches: [{ actorId: "u", thoughts: "Waiting." }] },
      { actorId: "u", text: "Nod and start explaining the first task." },
      { moves: false, speaks: true, quotedSpeech: [] },
    );
    expect(v.valid).toBe(false);
  });
});

describe("exp4-5 ranked destination resolution (ticks 4/7/15/18)", () => {
  it("ownership: 'my desk' resolves to the actor's own desk", () => {
    const world = antonWorld();
    expect(resolveDestinationObjectId(world, "Walk to my desk and sit down.", "anton")).toBe("anton_desk");
    expect(resolveDestinationObjectId(world, "Walk to my desk and sit down.", "tanya")).toBe("tanya_desk");
  });

  it("grab mode: leftover coffee resolves to the lounge mug, not the machine", () => {
    const world = antonWorld();
    expect(
      resolveDestinationObjectId(world, "Head to the lounge to grab leftover coffee.", "tanya"),
    ).toBe("lounge_mug");
  });

  it("walk mode prefers furniture over signs", () => {
    const world = antonWorld();
    // "Walk to the desk with the ANTON sign" names desk + sign: the desk wins.
    expect(
      resolveDestinationObjectId(world, "Walk to the desk with the ANTON sign and sit.", "anton"),
    ).toBe("anton_desk");
  });

  it("grab mode prefers the actor's own laptop over another desk's", () => {
    const world = antonWorld();
    expect(resolveDestinationObjectId(world, "Open the laptop to set it up.", "anton")).toBe("anton_laptop");
  });
});

describe("exp4-7 narrowed merged-OR (ticks 3/7/10/15/17)", () => {
  it("merged moves=true on glance text is kept (F1: token never downgrades)", async () => {
    const world = makeTinyWorld();
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "u", text: "Glance over notes and mentally prepare questions." },
      { ...baseResult("U teleports."), actorPatches: [], effects: { moved: true, spoke: false } },
      {
        async classify(): Promise<ActionSemantics> {
          return { moves: true, speaks: false, quotedSpeech: [] };
        },
      },
      createTestLogger(),
    );
    // F1: a true merged verdict stands even without a displacement token —
    // the fixed verb ontology is not the whole language.
    expect(resolved.semantics!.moves).toBe(true);
    expect(resolved.disagreements!.join(" ")).toMatch(/kept from the merged verdict/);
  });

  it("deterministic moves=true survives effects+judge both claiming stillness", async () => {
    const world = makeTinyWorld();
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "u", text: "Walk to N." },
      { ...baseResult("U adjusts his tie."), actorPatches: [], effects: { moved: false, spoke: false } },
      {
        async classify(): Promise<ActionSemantics> {
          return { moves: false, speaks: false, quotedSpeech: [] };
        },
      },
      createTestLogger(),
    );
    expect(resolved.semantics!.moves).toBe(true);
    expect(resolved.disagreements!.join(" ")).toMatch(/deterministic override/);
  });

  it("grounded destination wins over the consequence's wrong landmark (tick 10)", async () => {
    const world = antonWorld();
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "tanya", text: "Head to Anton's desk and help him set up his laptop." },
      {
        ...baseResult("Tanya walks."),
        actorPatches: [],
        effects: { moved: true, spoke: false, destinationObjectId: "tanya_desk" },
      },
      {
        async classify(): Promise<ActionSemantics> {
          return { moves: true, speaks: false, quotedSpeech: [] };
        },
      },
      createTestLogger(),
    );
    expect(resolved.semantics!.destinationObjectId).toBe("anton_desk");
    expect(resolved.disagreements!.join(" ")).toMatch(/kept grounded/);
  });
});

describe("exp4-2 reverse verb-drop (ticks 2/16)", () => {
  it("fails effects.moved=true with no position patch (tick 2 hollow pass)", () => {
    const world = antonWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("Dana finishes screening, stands up, walks to the kitchen for a coffee break."),
        actorPatches: [{ actorId: "dana", thoughts: "Unwinding." }],
        effects: { moved: true, spoke: false },
      },
      { actorId: "dana", text: "Scan candidates and compose the email." },
      stillSemantics(),
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/no position change/);
  });

  it("fails narrated pose change with no pose patch", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U stands up and stretches."),
        actorPatches: [{ actorId: "u", thoughts: "Awake." }],
      },
      { actorId: "u", text: "Wait for the meeting to start." },
      stillSemantics(),
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/pose/);
  });

  it("passes posture prose and staying-negations without patches", () => {
    const world = makeTinyWorld();
    for (const narrative of [
      "U glances over the notes, staying seated.",
      "U shakes his head at the news.",
      "U returns to typing, focusing on the code.",
      "U stands beside the desk, waiting.",
    ]) {
      const v = validateConsequence(
        world,
        { ...baseResult(narrative), actorPatches: [{ actorId: "u", thoughts: "Zone." }] },
        { actorId: "u", text: "Wait quietly." },
        stillSemantics(),
      );
      expect(errorText(v.errors)).not.toMatch(/narrative describes movement|declares moved=true/);
    }
  });

  it("passes narrated locomotion when the position patch backs it", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U approaches N, standing beside them."),
        actorPatches: [
          { actorId: "u", x: 2, y: 2, thoughts: "Going." },
          { actorId: "n", thoughts: "Hello." },
        ],
      },
      { actorId: "u", text: "Walk toward N." },
      { moves: true, destinationActorId: "n", speaks: false, quotedSpeech: [] },
    );
    expect(v).toEqual({ valid: true, errors: [] });
  });
});

describe("exp4-1 clamp over-cap walks to a partial step (ticks 15/18)", () => {
  it("clampMoveToCap projects a 14-cell jump onto the 6-cell reachable set", () => {
    const world = antonWorld();
    const clamped = clampMoveToCap(world, "anton", 4, 9);
    expect(clamped).not.toBeNull();
    expect(Math.hypot(clamped!.x - 16, clamped!.y - 2)).toBeLessThanOrEqual(MAX_STEP_DISTANCE + 1e-9);
    // Progress toward the desk, not a shuffle in place.
    expect(Math.hypot(clamped!.x - 16, clamped!.y - 2)).toBeGreaterThan(3);
  });

  it("resolveWithValidation ignores over-cap model coordinates and applies the engine step (tick-15 shape)", async () => {
    const logger = new Logger({ sessionId: "exp4-clamp", writeToFile: false });
    const world = antonWorld();
    const overCap: ConsequenceResult = {
      narrative: "Anton walks to his desk and sits down.",
      actorPatches: [{ actorId: "anton", x: 4, y: 9, pose: "sit", thoughts: "Going." }],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: true, destinationObjectId: "anton_desk", spoke: false },
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(overCap) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const out = await resolveWithValidation(world, { actorId: "anton", text: "Walk to my desk and sit down." }, deps);
    expect(out.narrative).not.toBe("Nothing changes.");
    const moved = out.actorPatches.find((p) => p.actorId === "anton")!;
    // Phase 1: the model's over-cap coordinates are ignored (logged at
    // debug); the engine computes the step deterministically instead.
    const expected = computeMovementOutcome(world, "anton", { destinationObjectId: "anton_desk" }, null)!;
    expect(moved.x).toBe(expected.x);
    expect(moved.y).toBe(expected.y);
    expect(Math.hypot(moved.x! - 16, moved.y! - 2)).toBeLessThanOrEqual(MAX_STEP_DISTANCE + 1e-9);
    // Non-coordinate patch content survives the merge.
    expect(moved.pose).toBe("sit");
    const ignored = logger.store.byEvent("model_coordinates_ignored");
    expect(ignored.some((e) => (e.output as { ignoredX?: number })?.ignoredX === 4)).toBe(true);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });
});

describe("exp4-8 salvage entry logging (whole run)", () => {
  it("logs salvage_evaluated on accept and on hard-gate refusal", () => {
    const logger = createTestLogger();
    const world = antonWorld();
    world.actors.find((a) => a.id === "anton")!.x = 5;
    world.actors.find((a) => a.id === "anton")!.y = 5;
    const action = { actorId: "anton", text: "Walk to the coffee machine." };
    const semantics: ActionSemantics = {
      moves: true, destinationObjectId: "coffee_machine", speaks: false, quotedSpeech: [],
    };
    // Accept: valid movement (strictly closer to the machine) + stray patch.
    const ok = trySalvageConsequence(
      world, action,
      {
        narrative: "Anton approaches the coffee machine, standing beside it.",
        actorPatches: [
          { actorId: "anton", x: 3, y: 2, thoughts: "Coffee." },
          { actorId: "jeff", thoughts: "Hi." },
        ],
        objectPatches: [], reasoning: "r",
      },
      semantics, logger,
    );
    expect(ok).not.toBeNull();
    // Phase 3: phantom-manipulation prose no longer refuses — tier-2
    // salvage advances the movement with the wording miss logged as a
    // warning.
    const tier2 = trySalvageConsequence(
      world,
      { actorId: "anton", text: "Walk to the coffee machine." },
      {
        narrative: "Anton picks up the mug and pours coffee.",
        actorPatches: [{ actorId: "anton", x: 3, y: 2, thoughts: "Coffee." }],
        objectPatches: [], reasoning: "r",
      },
      semantics, logger, undefined, null,
    );
    expect(tier2).not.toBeNull();
    expect(errorText(tier2!.warnings)).toMatch(/object\.phantom_manipulation/);
    // Refuse: far contact with no adjacency (adjacency stays hard).
    const no = trySalvageConsequence(
      world,
      { actorId: "anton", text: "Shake Tanya's hand warmly." },
      {
        narrative: "Anton shakes Tanya's hand.",
        actorPatches: [{ actorId: "anton", thoughts: "Firm grip." }],
        objectPatches: [], reasoning: "r",
      },
      { moves: false, speaks: false, quotedSpeech: [], contactActorId: "tanya" },
      logger,
    );
    expect(no).toBeNull();
    const evals = logger.store.byEvent("salvage_evaluated");
    expect(evals).toHaveLength(3);
    expect((evals[0]!.output as { eligible: boolean }).eligible).toBe(true);
    expect((evals[1]!.output as { eligible: boolean }).eligible).toBe(true);
    expect((evals[2]!.output as { eligible: boolean }).eligible).toBe(false);
    expect((evals[2]!.output as { blockers: Array<{ code: string; message: string }> }).blockers.length).toBeGreaterThan(0);
  });
});

describe("exp4-6 fallback history marked un-applied (ticks 8/16/20)", () => {
  it("marks fallback entries and detects the marker", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Nod and start explaining the first task." };
    // Q1: clean turns record the narrative, not the action text.
    const applied = applyConsequence(world, baseResult("Done."), action);
    expect(applied.history.at(-1)!.text).toBe("U: Done.");
    expect(isFallbackHistoryEntry(applied.history.at(-1)!)).toBe(false);
    const fellBack = applyConsequence(world, baseResult("Done."), action, undefined, { fallback: true });
    // F22: the human-readable "(not done)" text is kept, but detection
    // uses the sentinel.
    expect(fellBack.history.at(-1)!.text).toBe(`U tried: ${action.text} (not done)${NOT_DONE_SENTINEL}`);
    expect(isFallbackHistoryEntry(fellBack.history.at(-1)!)).toBe(true);
    // A user-written "(not done)" without the sentinel is NOT a fallback.
    expect(isFallbackHistoryEntry(hist(world, "U tried: something (not done)"))).toBe(false);
  });

  it("isFallbackConsequence detects the canonical fallback only", () => {
    expect(isFallbackConsequence({ narrative: "Nothing changes.", actorPatches: [], objectPatches: [], reasoning: "x" })).toBe(true);
    expect(isFallbackConsequence({ narrative: "Nothing changes.", actorPatches: [{ actorId: "u", thoughts: "Hmm." }], objectPatches: [], reasoning: "x" })).toBe(false);
  });

  it("open questions and recent actions ignore fallback attempts", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    world.history.push(
      hist(world, "U: Walk to Nadia. Nadia, where is my desk?"),
      triedHist(world, "Nadia tried: Nod and start explaining the first task."),
    );
    // The question from the applied turn stays open; the fallback explanation
    // counts as neither an answer nor a prior action to avoid repeating.
    expect(getOpenQuestions(world, "n").length).toBe(1);
    expect(getRecentOwnActions(world, "n")).toEqual([]);
  });
});

describe("exp4-9 identity anchor (ticks 8/19)", () => {
  it("flags POV swaps and goal attributions, passes vocatives and landmarks", () => {
    const world = antonWorld();
    expect(detectIdentityLeak(world, "dana", "Anton walks over and introduces himself to Dana.")).toMatch(/identity leak/);
    expect(detectIdentityLeak(world, "dana", "Take a few deep breaths to calm his nerves. Anton wants to familiarize himself.")).toMatch(/identity leak/);
    expect(detectIdentityLeak(world, "tanya", "Walk toward Tanya's desk to greet her.")).toBeUndefined();
    expect(detectIdentityLeak(world, "anton", 'Walk to Tanya and ask "Tanya, could you show me where my desk is?"')).toBeUndefined();
    expect(detectIdentityLeak(world, "dana", "Nod and start explaining the first task.")).toBeUndefined();
  });

  it("proposal context leads with the deciding actor's identity", () => {
    const world = antonWorld();
    const ctx = buildProposalContext(world, "dana");
    expect(ctx.indexOf("You are Dana (dana)")).toBeLessThan(ctx.indexOf("Current Actor"));
    expect(ctx).toContain("You are NOT");
  });
});

describe("exp4-10 handshake/greeting attractor dedup", () => {
  it("cores match across rewordings from the deciding actor's perspective", () => {
    const world = antonWorld();
    expect(suggestionCore(world, "Anton shakes hands with Tanya", "tanya")).toBe(
      suggestionCore(world, "Shake Anton's hand warmly.", "tanya"),
    );
    expect(suggestionCore(world, "Stand up and wave at Anton", "tanya")).toBe(
      suggestionCore(world, "Wave at Anton.", "tanya"),
    );
    expect(suggestionCore(world, "Shake Anton's hand warmly.", "tanya")).not.toBe(
      suggestionCore(world, "Walk to the coffee machine and pour a coffee.", "tanya"),
    );
  });

  it("findCoreRepeat flags a reworded repeat of a recent own action", () => {
    const world = antonWorld();
    world.history.push(hist(world, "Tanya: Shake Anton's hand warmly."));
    expect(findCoreRepeat(world, "tanya", "Stand up and shake Anton's hand.")).toContain("Shake Anton's hand");
    expect(findCoreRepeat(world, "tanya", "Walk to the coffee machine and pour a coffee.")).toBeUndefined();
    // Another actor's handshake is not this actor's repeat.
    expect(findCoreRepeat(world, "dana", "Stand up and shake Anton's hand.")).toBeUndefined();
  });
});
