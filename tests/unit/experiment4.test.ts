// Regression tests for experiment-4.md action items 1-10
// (office-anton.json, 7 adaptive user turns, local 8B, ticks 0-20).
import { describe, expect, it } from "vitest";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import { isQuoteGroundedInAction } from "../../src/core/speech.js";
import {
  hasSpeechToken,
  resolveDestinationObjectId,
} from "../../src/engine/deterministicSemantics.js";
import {
  clampMoveToCap,
  computeMovementOutcome,
  MAX_STEP_DISTANCE,
} from "../../src/core/movement.js";
import { isFallbackConsequence, resolveRender } from "../../src/engine/turnOrchestrator.js";
import { applyRenderResult, isFallbackHistoryEntry } from "../../src/engine/patchApplier.js";
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
  return { narrative, reasoning: "r" };
}

function baseFacts(over: Partial<RenderFacts> = {}): RenderFacts {
  return {
    exactQuote: null, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
    x: 1, y: 1, engineManipulation: null, ...over,
  };
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

  it("the full action quote grounds; the truncation does not", () => {
    const action = `Walk over and ask "Why don't we take a 10-minute break?"`;
    expect(isQuoteGroundedInAction("Why don't we take a 10-minute break?", action)).toBe(true);
    expect(isQuoteGroundedInAction("Why don", action)).toBe(false);
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

  it("hollow look-up fails the speech gate once speech is detected", () => {
    const world = makeTinyWorld();
    // Phase 4: the restored speech.no_speech_rendered prose gate — the
    // action carries the actor's own utterance ("explaining"), the
    // narrative renders no speech.
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Nod and start explaining the first task." },
      { ...baseResult("U looks up from the monitor."), thoughts: "Waiting." },
      baseFacts(),
    );
    expect(errors.some((e) => e.code === "speech.no_speech_rendered")).toBe(true);
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


describe("exp4-2 reverse verb-drop (ticks 2/16)", () => {
  it("fails narrated locomotion with no engine move (tick 2 hollow pass)", () => {
    const world = antonWorld();
    // Phase 4: the engine is the source of truth — the model cannot
    // self-declare moved=true, so the hollow pass surfaces as
    // narrated-without-move.
    const errors = validateRenderProse(
      world,
      { actorId: "dana", text: "Scan candidates and compose the email." },
      {
        ...baseResult("Dana finishes screening, stands up, walks to the kitchen for a coffee break."),
        thoughts: "Unwinding.",
      },
      baseFacts({ x: 15, y: 11 }),
    );
    expect(errors.some((e) => e.code === "movement.narrated_without_move")).toBe(true);
  });

  it("fails narrated pose change the engine did not plan", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Wait for the meeting to start." },
      { ...baseResult("U stands up and stretches."), thoughts: "Awake." },
      baseFacts(),
    );
    expect(errors.some((e) => e.code === "movement.pose_change_ungrounded")).toBe(true);
  });

  it("passes posture prose and staying-negations", () => {
    const world = makeTinyWorld();
    for (const narrative of [
      "U glances over the notes, staying seated.",
      "U shakes his head at the news.",
      "U returns to typing, focusing on the code.",
      "U stands beside the desk, waiting.",
    ]) {
      const errors = validateRenderProse(
        world,
        { actorId: "u", text: "Wait quietly." },
        { ...baseResult(narrative), thoughts: "Zone." },
        baseFacts(),
      );
      expect(errorText(errors)).not.toMatch(/narrative describes movement/);
    }
  });

  it("passes narrated locomotion when the engine moved", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Walk toward Nadia." },
      { ...baseResult("U approaches Nadia, standing beside them."), thoughts: "Going." },
      baseFacts({ moved: true, x: 2, y: 2 }),
    );
    expect(errors).toEqual([]);
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

  it("resolveRender ignores model-narrated arrival and applies the engine step (tick-15 shape)", async () => {
    const logger = new Logger({ sessionId: "exp4-clamp", writeToFile: false });
    const world = antonWorld();
    // Phase 4: the render carries no coordinates at all — the engine
    // computes the step deterministically; the narrative is validated
    // against the executed facts.
    const overCap: ConsequenceResult = {
      narrative: "Anton walks to his desk and sits down.",
      thoughts: "Going.",
      reasoning: "r",
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(overCap) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const out = await resolveRender(world, { actorId: "anton", text: "Walk to my desk and sit down." }, deps);
    expect(out.render.narrative).not.toBe("Nothing changes.");
    expect(out.liveness).toBe(false);
    // The engine step is capped and strictly closer to the desk.
    const expected = computeMovementOutcome(world, "anton", { destinationObjectId: "anton_desk" }, null)!;
    expect(out.executed.movement).not.toBeNull();
    expect(out.executed.movement!.x).toBe(expected.x);
    expect(out.executed.movement!.y).toBe(expected.y);
    expect(Math.hypot(expected.x - 16, expected.y - 2)).toBeLessThanOrEqual(MAX_STEP_DISTANCE + 1e-9);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });
});


describe("exp4-6 fallback history marked un-applied (ticks 8/16/20)", () => {
  it("marks fallback entries and detects the marker", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Nod and start explaining the first task." };
    const noExec = { movement: null, pose: null, manipulation: null };
    // Q1: clean turns record the narrative, not the action text.
    const applied = applyRenderResult(world, action, baseResult("Done."), noExec);
    expect(applied.history.at(-1)!.text).toBe("U: Done.");
    expect(isFallbackHistoryEntry(applied.history.at(-1)!)).toBe(false);
    const fellBack = applyRenderResult(world, action, baseResult("Done."), noExec, undefined, { fallback: true });
    // F22: the human-readable "(not done)" text is kept, but detection
    // uses the sentinel.
    expect(fellBack.history.at(-1)!.text).toBe(`U tried: ${action.text} (not done)${NOT_DONE_SENTINEL}`);
    expect(isFallbackHistoryEntry(fellBack.history.at(-1)!)).toBe(true);
    // A user-written "(not done)" without the sentinel is NOT a fallback.
    expect(isFallbackHistoryEntry(hist(world, "U tried: something (not done)"))).toBe(false);
  });

  it("isFallbackConsequence detects the canonical fallback only", () => {
    expect(isFallbackConsequence({ narrative: "Nothing changes.", reasoning: "x" })).toBe(true);
    expect(isFallbackConsequence({ narrative: "Changed.", reasoning: "x" })).toBe(false);
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
