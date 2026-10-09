// Regression tests for experiment-3.md action items 1-13
// (office-anton.json, 7 adaptive user turns, local 8B, ticks 0-20).
import { describe, expect, it } from "vitest";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import { isQuoteGroundedInAction } from "../../src/core/speech.js";
import { parseActionQuotes } from "../../src/core/text.js";
import {
  hasDisplacementToken,
  resolveDestinationActorId,
  resolveDeterministicSemantics,
} from "../../src/engine/deterministicSemantics.js";
import { resolveRender, summarizeTurnOutcomes } from "../../src/engine/turnOrchestrator.js";
import { suggestSimilarIds } from "../../src/engine/physicalValidator.js";
import { computeMovementOutcome } from "../../src/core/movement.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import { Logger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld, errorText, triedHist } from "../helpers.js";
import {
  buildConsequenceContext,
  buildObjectIdCatalog,
  buildProposalContext,
  buildRelationshipRefresh,
  buildSelectionContext,
} from "../../src/engine/contextBuilder.js";
import { renderSuffix } from "../../src/llm/prompts.js";
import { mockClassifyAction, MockSemanticJudge } from "../../src/mocks/mockSemanticJudge.js";
import { createTestLogger } from "../../src/logging/logger.js";
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
});

describe("exp3-2 speech gate split (ticks 3 vs 4/12/15/18)", () => {
  it("a question paraphrase fails the exact-quote gate on direct validation (tick 3, Phase 2)", () => {
    // Phase 4: paraphrase is no longer acceptable on quoted turns — the
    // narrative must carry the exact quote character-for-character.
    // Direct validation (no in-loop backstop) rejects the paraphrase with
    // speech.exact_quote_missing; in the turn loop the deterministic
    // backstop reinserts it before validation instead.
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: 'Walk to N and ask "could you show me where my desk is?"' },
      { ...baseResult("U asks N for directions to his desk."), thoughts: "Going." },
      baseFacts({ exactQuote: "could you show me where my desk is?", moved: true, x: 2, y: 2 }),
    );
    expect(errors.map((e) => e.code)).toContain("speech.exact_quote_missing");
  });

  it("passes a verbatim question render (tick 3, Phase 2)", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: 'Walk to N and ask "could you show me where my desk is?"' },
      {
        ...baseResult('U walks to N and asks "could you show me where my desk is?"'),
        thoughts: "Going.",
      },
      baseFacts({ exactQuote: "could you show me where my desk is?", moved: true, x: 2, y: 2 }),
    );
    expect(errors).toEqual([]);
  });

  it("still fails truncations and flipped questions", () => {
    const world = makeTinyWorld();
    // Truncation: keeps the name, drops the question.
    const trunc = validateRenderProse(
      world,
      { actorId: "u", text: '"Hi, I am Anton, where is my desk?"' },
      baseResult("U says hi, Anton is here."),
      baseFacts({ exactQuote: "Hi, I am Anton, where is my desk?" }),
    );
    expect(trunc.map((e) => e.code)).toContain("speech.exact_quote_missing");
  });

  it("fails dropped handshakes via contact coverage (tick 12)", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: 'Shake the hand of Nadia, "Nadia, what should my first task be?"' },
      {
        ...baseResult("U asks, 'Nadia, what should my first task be?'"),
        thoughts: "Asking.",
      },
      baseFacts({ exactQuote: "Nadia, what should my first task be?" }),
    );
    expect(errors.map((e) => e.code)).toContain("contact.narrative_drops_contact");
  });

  it("pour action is engine-executed: narrative silence about the transfer passes (tick 9, Phase 3)", () => {
    const world = officeWorld();
    const u = world.actors.find((a) => a.id === "u")!;
    u.x = 3; u.y = 0; // within reach of the coffee machine at (0,0)
    const mug = world.scene.objects.find((o) => o.id === "anton_mug")!;
    mug.x = 3; mug.y = 1; // and of the mug
    const action = { actorId: "u", text: "Walk to the coffee machine and pour a coffee." };
    // Phase 3: the engine plans the cup pick-up from the action text —
    // the render emits no patch and the narrative need not name it
    // (one-directional grounding).
    const outcome = executeManipulation(world, action);
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.kind).toBe("pick-up");
    expect(outcome!.plan.propName).toBe("cup");
    const errors = validateRenderProse(
      world,
      action,
      {
        ...baseResult("Anton approaches the coffee machine, standing beside it."),
        thoughts: "Coffee time.",
      },
      baseFacts({ moved: true, x: 1, y: 1, engineManipulation: outcome }),
    );
    expect(errors).toEqual([]);
  });

  it("fails flipped ask-to-thanks via question coverage (tick 16)", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "n", text: "Walk to U to ask if he needs help setting up." },
      { ...baseResult("N thanks U, looking pleased."), thoughts: "Pleased." },
      baseFacts({ moved: true, x: 3, y: 3 }),
    );
    expect(errors.map((e) => e.code)).toContain("speech.question_dropped");
  });

  it("does not mistake adjectives for verbs ('an open demeanor')", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Call out a greeting, open and welcoming." },
      { ...baseResult("U calls out a greeting, open and welcoming."), thoughts: "Friendly." },
      baseFacts(),
    );
    expect(errors).toEqual([]);
  });
});

describe("exp3-4 displacement cap + real progress (ticks 8/15/20)", () => {
  // Phase 4: the render carries no coordinates — teleports and token
  // shuffles are impossible by construction (the engine computes every
  // step). These tests assert the engine-side guarantees and the prose
  // gate that catches invented locomotion.
  it("invented locomotion without an engine move fails (tick-20 shape)", () => {
    const world = makeTinyWorld();
    world.scene.width = 20;
    world.scene.height = 20;
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Glance over notes and mentally prepare questions." },
      { ...baseResult("U walks to the far corner of the room."), thoughts: "Zone." },
      baseFacts(),
    );
    expect(errors.map((e) => e.code)).toContain("movement.narrated_without_move");
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
    const target = computeMovementOutcome(world, "u", { destinationObjectId: "anton_desk" });
    expect(target).not.toBeNull();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Walk to my desk." },
      { ...baseResult("Anton walks toward his desk."), thoughts: "Going." },
      baseFacts({ moved: true, x: target!.x, y: target!.y }),
    );
    expect(errors).toEqual([]);
  });

  it("computeMovementOutcome never suggests teleports", () => {
    const world = makeTinyWorld();
    world.scene.width = 30;
    world.scene.height = 30;
    const o = computeMovementOutcome(world, "u", { destinationActorId: "n" });
    expect(o).not.toBeNull();
    expect(Math.hypot(o!.x - 1, o!.y - 1)).toBeLessThanOrEqual(6 + 1e-9);
  });
});

describe("exp3-5 observer-as-subject prose (tick 13)", () => {
  it("fails narratives led by a roster observer", () => {
    const world = officeWorld();
    // Nadia (n) acts; the narrative is led by Anton (a roster observer).
    // Nadia moves adjacent to Anton for the handshake: (1,1)->(2,1).
    const errors = validateRenderProse(
      world,
      { actorId: "n", text: "Approach Anton to greet warmly." },
      { ...baseResult("Anton shakes Nadia's hand."), thoughts: "Welcome!" },
      baseFacts({ moved: true, x: 2, y: 1 }),
    );
    expect(errors.some((e) => e.code === "narrative.observer_as_subject")).toBe(true);
  });

  it("passes landmark mentions and possessives", () => {
    const world = officeWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Walk toward Nadia." },
      {
        ...baseResult("Anton walks toward Nadia near the coffee machine."),
        thoughts: "Going.",
      },
      baseFacts({ moved: true, x: 2, y: 2 }),
    );
    expect(errors).toEqual([]);
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

  // Phase 4: the "unknown object id ... did you mean" retry error is deleted
  // with the patch contract — the engine owns objects outright and model
  // objectPatches are stripped before validation, never repaired.
});

describe("exp3-9/10/11/12/13 prompting", () => {
  it("consequence context carries the object-ID catalog and copy rule", () => {
    const world = officeWorld();
    const ctx = buildConsequenceContext(world, { actorId: "u", text: "Pour a coffee." });
    expect(ctx).toContain("OBJECT IDS");
    expect(ctx).toContain("anton_mug");
    // Phase 2: the copy rule is rewritten around the engine-dictated exact quote.
    expect(ctx).toContain("EXACT QUOTE RULE");
    // Phase 3: the patch demand is replaced by the engine-ownership rule.
    expect(ctx).toContain("OBJECT MANIPULATION IS ENGINE-EXECUTED");
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

  it("the render suffix carries the render contract, not the patch contract", () => {
    const suffix = renderSuffix();
    for (const needle of ["RENDER CONTRACT", "EXECUTED", "SPEECH IS ENGINE-OWNED", "ROSTER", "PIPELINE BAN"]) {
      expect(suffix).toContain(needle);
    }
    // Phase 4: no coordinate/patch-emission instructions — the schema has
    // no such fields and anything emitted is ignored.
    expect(suffix).toContain("Never\nemit x/y coordinates");
    expect(suffix).not.toContain("contactActorId");
    expect(suffix).not.toContain("quotedSpeech");
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


  it("a valid walk validates on its own movement (tick 9)", () => {
    const world = officeWorld();
    world.actors.find((a) => a.id === "u")!.x = 3;
    world.actors.find((a) => a.id === "u")!.y = 3;
    const action = { actorId: "u", text: "Walk over to the coffee machine for a break." };
    // Phase 4: there is no judge to invent destinations or quotes — the
    // engine plans the walk from the action text and the render narrates
    // the executed facts.
    const errors = validateRenderProse(
      world,
      action,
      {
        ...baseResult("Anton approaches the coffee machine, standing beside it."),
        thoughts: "Coffee time.",
      },
      baseFacts({ moved: true, x: 1, y: 1 }),
    );
    expect(errors).toEqual([]);
  });


});

describe("phase3 action-side verb gates (ticks 12/15/18, 10/11)", () => {
  it("fails speech dropped without a trace, passes preserved thanks (tick 18)", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Thank N for the welcome and head to the desk." };
    const dropped = validateRenderProse(
      world,
      action,
      { ...baseResult("U looks around the office."), thoughts: "Nice place." },
      baseFacts({ moved: true, x: 2, y: 2 }),
    );
    expect(dropped.map((e) => e.code)).toContain("speech.no_speech_rendered");

    const kept = validateRenderProse(
      world,
      action,
      { ...baseResult("U thanks N for the welcome."), thoughts: "Grateful." },
      baseFacts({ moved: true, x: 2, y: 2 }),
    );
    expect(kept).toEqual([]);
  });

  it("greet/welcome may be rendered non-verbally (golden-path guard)", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Jeff";
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Walk over to Jeff and welcome him." },
      {
        ...baseResult("U walks toward Jeff and stops near him."),
        thoughts: "Friendly.",
      },
      baseFacts({ moved: true, x: 2, y: 2 }),
    );
    expect(errors).toEqual([]);
  });

  it("pick up/hold needs no render patch (Phase 3: engine-owned); phantom prose fails", () => {
    const world = officeWorld();
    const u = world.actors.find((a) => a.id === "u")!;
    u.x = 4; u.y = 3; // next to anton_mug at (4,4)
    for (const text of ["Pick up the mug from the desk.", "Hold the cup while waiting."]) {
      const action = { actorId: "u", text };
      const outcome = executeManipulation(world, action);
      expect(outcome, text).not.toBeNull();
      // The engine executed the pick-up; the render emits no patch and the
      // narrative need not describe the transfer (one-directional grounding).
      const errors = validateRenderProse(
        world,
        action,
        { ...baseResult("Anton stands by the desk."), thoughts: "Coffee." },
        baseFacts({ engineManipulation: outcome }),
      );
      expect(errors, text).toEqual([]);
    }
    // Phantom prose: the narrative describes a pick-up the engine did not
    // execute (the action implies no manipulation at all).
    const phantom = validateRenderProse(
      world,
      { actorId: "u", text: "Anton stands by the desk." },
      { ...baseResult("Anton picks up the mug and waves it around."), thoughts: "Coffee." },
      baseFacts(),
    );
    expect(phantom.map((e) => e.code)).toContain("object.phantom_manipulation");
  });

  it("fails far handshakes, passes adjacent ones (tick 12)", () => {
    const world = officeWorld();
    // u (Anton) at (1,1), n (Nadia) at (4,4): 4.2 cells apart — a narrated
    // handshake is invented contact the engine did not achieve.
    const far = validateRenderProse(
      world,
      { actorId: "u", text: "Shake Nadia's hand warmly." },
      { ...baseResult("Anton shakes Nadia's hand."), thoughts: "Firm grip." },
      baseFacts(),
    );
    expect(far.map((e) => e.code)).toContain("contact.too_far");

    // Adjacent: Nadia one cell away, handshake narrated — passes.
    world.actors.find((a) => a.id === "n")!.x = 2;
    world.actors.find((a) => a.id === "n")!.y = 1;
    const near = validateRenderProse(
      world,
      { actorId: "u", text: "Shake Nadia's hand warmly." },
      { ...baseResult("Anton shakes Nadia's hand."), thoughts: "Firm grip." },
      baseFacts({ moved: true, x: 2, y: 1 }),
    );
    expect(near).toEqual([]);
  });

  it("Stage-2 B1: body-part hand nouns claim no contact and no transfer", () => {
    const world = officeWorld();
    // Nadia far away (4,4); u at (1,1). A waved hand is not contact and
    // "hands empty" is not a hand-over — the Stage-2 tick-3 live repro
    // failed on both before the transfer-frame scoping.
    const wave = validateRenderProse(
      world,
      { actorId: "u", text: "Wave to Nadia across the room." },
      { ...baseResult("Anton raises a hand in a friendly wave at Nadia."), thoughts: "Hi." },
      baseFacts(),
    );
    expect(wave.map((e) => e.code)).not.toContain("contact.too_far");
    expect(wave.map((e) => e.code)).not.toContain("object.phantom_manipulation");

    const empty = validateRenderProse(
      world,
      { actorId: "u", text: "Stand by the desk." },
      {
        ...baseResult("Anton stands beside the desk, hands empty, glancing at the envelope."),
        thoughts: "Waiting.",
      },
      baseFacts(),
    );
    expect(empty.map((e) => e.code)).not.toContain("object.phantom_manipulation");
  });

  it("garbage old-schema patches are stripped and ignored (Phase 4: render-only)", async () => {
    const logger = new Logger({ sessionId: "exp3-phase4-strip", writeToFile: false });
    const world = officeWorld();
    const deps = makeTestDeps(logger, {
      consequenceEngine: {
        resolve: async () =>
          structuredClone({
            narrative: "Anton waves at Nadia.",
            thoughts: "Friendly.",
            // Old-schema garbage: stripped by the schema before validation
            // — never validated, never applied.
            actorPatches: [{ actorId: "u", x: 99, y: 99, thoughts: "Hacked." }],
            objectPatches: [{ objectId: "coffee mug", description: "Used." }],
            effects: { moved: true, spoke: false },
            reasoning: "r",
          }),
      } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 1, autosaveEnabled: false },
    });
    const out = await resolveRender(
      world,
      { actorId: "u", text: "Wave at Nadia." },
      deps,
    );
    // The turn is clean: the garbage never reaches the world or validation.
    expect(out.render.narrative).toBe("Anton waves at Nadia.");
    expect(out.liveness).toBe(false);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    expect(logger.store.byEvent("render_failed")).toHaveLength(0);
    expect(logger.store.byEvent("render_accepted")).toHaveLength(1);
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

  it("invented locomotion on a glance fails, staying in place passes (ticks 8/20)", () => {
    const world = makeTinyWorld();
    world.scene.width = 20;
    world.scene.height = 20;
    const action = { actorId: "u", text: "Glance over notes and mentally prepare questions." };
    // Phase 4: the render carries no coordinates — the tick-8/20 teleport
    // surfaces as narrated locomotion the engine never executed.
    const invented = validateRenderProse(
      world,
      action,
      { ...baseResult("U walks across the room."), thoughts: "Zone." },
      baseFacts(),
    );
    expect(invented.map((e) => e.code)).toContain("movement.narrated_without_move");

    const stayed = validateRenderProse(
      world,
      action,
      { ...baseResult("U glances over notes, staying seated."), thoughts: "Zone." },
      baseFacts(),
    );
    expect(stayed).toEqual([]);
  });

  it("sit settles locally (the narrative cannot teleport)", () => {
    const world = makeTinyWorld();
    world.scene.width = 20;
    world.scene.height = 20;
    const action = { actorId: "u", text: "Sit on the chair at my desk." };
    // Phase 4: where the actor sits is engine-determined; the narrative
    // carries no coordinates, so a "far chair" teleport is unexpressible.
    const settle = validateRenderProse(
      world,
      action,
      { ...baseResult("U sits on the chair at the desk."), thoughts: "Settled." },
      baseFacts({ pose: "sit", effectivePose: "sit" }),
    );
    expect(settle).toEqual([]);
  });

  it("the engine makes real progress toward distant actors (tick-15 actor variant)", () => {
    // Phase 1: token shuffles are impossible by construction — the engine
    // always steps to the closest legal cell within the cap, which IS the
    // real-progress rule.
    const world = makeTinyWorld();
    world.scene.width = 20;
    world.scene.height = 20;
    world.actors.find((a) => a.id === "u")!.x = 0;
    world.actors.find((a) => a.id === "u")!.y = 0;
    world.actors.find((a) => a.id === "n")!.x = 15;
    world.actors.find((a) => a.id === "n")!.y = 15;
    const action = { actorId: "u", text: "Walk toward N." };
    const o = computeMovementOutcome(world, "u", { destinationActorId: "n" });
    expect(o).not.toBeNull();
    // A 21-cell walk spends (nearly) the full 6-cell allowance — no shuffle.
    const oldDist = Math.hypot(15, 15);
    expect(oldDist - Math.hypot(o!.x - 15, o!.y - 15)).toBeGreaterThan(5);
    // And the render validates against the engine's output.
    const errors = validateRenderProse(
      world,
      action,
      { ...baseResult("U strides toward N."), thoughts: "Going." },
      baseFacts({ moved: true, x: o!.x, y: o!.y }),
    );
    expect(errors).toEqual([]);
  });

  it("glance turns resolve without forced movement end to end (tick-20 shape)", async () => {
    const logger = new Logger({ sessionId: "exp3-phase2-glance", writeToFile: false });
    const world = makeTinyWorld();
    world.scene.width = 20;
    world.scene.height = 20;
    const action = { actorId: "u", text: "Glance over notes and mentally prepare questions." };
    // A well-behaved render stays in place: passes, no repair, no fallback.
    const staying = {
      narrative: "U glances over the notes, staying seated.",
      thoughts: "Back in the zone.",
      reasoning: "r",
    };
    const deps = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(staying) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const out = await resolveRender(world, action, deps);
    expect(out.render.narrative).not.toBe("Nothing changes.");
    expect(out.liveness).toBe(false);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    expect(logger.store.byEvent("render_accepted")).toHaveLength(1);

    // A stubborn teleporter on the same glance action: the old-schema
    // coordinates are stripped and ignored — the turn still resolves as a
    // clean glance.
    const teleporting = {
      narrative: "U glances over notes.",
      thoughts: "Zone.",
      actorPatches: [{ actorId: "u", x: 14, y: 14 }],
      reasoning: "r",
    };
    const deps2 = makeTestDeps(logger, {
      consequenceEngine: { resolve: async () => structuredClone(teleporting) } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const out2 = await resolveRender(world, action, deps2);
    expect(out2.render.narrative).toBe("U glances over notes.");
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });
});

describe("phase4 render-only contract (actual Phase 4)", () => {
  it("resolveRender repairs a dropped quote deterministically, no retry burned (tick-9 end to end)", async () => {
    // Phase 4: a dropped quote no longer costs a retry — the in-loop
    // deterministic backstop reinserts the exact quote before validation,
    // so the turn is accepted on attempt 1.
    const logger = new Logger({ sessionId: "exp3-phase4-retry", writeToFile: false });
    const world = officeWorld();
    world.actors.find((a) => a.id === "u")!.x = 3;
    world.actors.find((a) => a.id === "u")!.y = 3;
    const action = { actorId: "u", text: 'Walk to the coffee machine and ask "is this my spot?"' };
    let calls = 0;
    const deps = makeTestDeps(logger, {
      consequenceEngine: {
        resolve: async () => {
          calls++;
          // The render drops the action's quote; the engine owns speech
          // now, so the backstop restores it without a retry.
          return structuredClone({
            narrative: "Anton walks toward the coffee machine.",
            thoughts: "Coffee time.",
            reasoning: "r",
          });
        },
      } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 1, autosaveEnabled: false },
    });
    const out = await resolveRender(world, action, deps);
    expect(calls).toBe(1);
    expect(out.render.narrative).toContain('"is this my spot?"');
    expect(out.liveness).toBe(false);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    // The deterministic repair is audit-logged.
    expect(logger.store.byEvent("render_quote_reinserted")).toHaveLength(1);
  });

  it("summarizeTurnOutcomes tracks clean / liveness / fallback separately", async () => {
    const logger = new Logger({ sessionId: "exp3-phase4-rates", writeToFile: false });

    // Clean turn: default mock engine validates first try.
    const cleanDeps = makeTestDeps(logger, {
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    await resolveRender(makeTinyWorld(), { actorId: "u", text: "Wave." }, cleanDeps);

    // Liveness turn: the render keeps failing prose validation and the
    // actor has hit the consecutive-fallback threshold — the liveness
    // floor synthesizes prose instead of freezing the turn.
    const liveWorld = officeWorld();
    liveWorld.actors.find((a) => a.id === "u")!.x = 3;
    liveWorld.actors.find((a) => a.id === "u")!.y = 3;
    for (let i = 0; i < 3; i++) {
      liveWorld.history.push(triedHist(liveWorld, `Anton tried: act ${i}`));
    }
    const liveDeps = makeTestDeps(logger, {
      consequenceEngine: {
        resolve: async () => ({ narrative: "U waves at Liam.", reasoning: "bad" }),
      } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const lived = await resolveRender(
      liveWorld,
      { actorId: "u", text: "Wave." },
      liveDeps,
    );
    expect(lived.liveness).toBe(true);

    // Fallback turn: the render fails and the actor is below the liveness
    // threshold (a user turn never gets liveness).
    const farWorld = makeTinyWorld();
    farWorld.scene.width = 20;
    farWorld.scene.height = 20;
    farWorld.userActorId = "u";
    const fallbackDeps = makeTestDeps(logger, {
      consequenceEngine: {
        resolve: async () => ({ narrative: "U waves at Liam.", reasoning: "bad" }),
      } as never,
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const fell = await resolveRender(farWorld, { actorId: "u", text: "Wave." }, fallbackDeps);
    expect(fell.render.narrative).toBe("Nothing changes.");

    const summary = summarizeTurnOutcomes(logger.store.all());
    expect(summary).toMatchObject({ clean: 1, liveness: 1, fallback: 1, total: 3 });
    expect(summary.cleanRate).toBeCloseTo(1 / 3);
    expect(summary.livenessRate).toBeCloseTo(1 / 3);
    expect(summary.fallbackRate).toBeCloseTo(1 / 3);
    expect(summarizeTurnOutcomes([])).toMatchObject({ clean: 0, liveness: 0, fallback: 0, total: 0 });
  });
});
