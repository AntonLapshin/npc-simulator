// Regression tests for experiment-2.md action items 1-13
// (office-anton.json, 10 adaptive user turns, local 8B, ticks 0-29).
import { describe, expect, it } from "vitest";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import {
  buildRosterAnchor,
  extractPronouns,
  buildNarrateContext,
} from "../../src/engine/contextBuilder.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import { computeMovementOutcome } from "../../src/core/movement.js";
import { consequenceResultSchema } from "../../src/schemas.js";
import { mockClassifyAction } from "../../src/mocks/mockSemanticJudge.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { makeTinyWorld, hist, errorText } from "../helpers.js";
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
    // Exp-3 item 8 (S6): the scene needs a chair — pose:sit at a
    // chairless cell is now rejected by validateSitPoseSeating.
    {
      id: "spare_chair", name: "Spare chair", description: "A chair.",
      x: 1, y: 2, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    },
  );
  return world;
}

describe("exp2-1 placeholder/schema leak (tick 4)", () => {
  it("rejects schema-filler narratives", () => {
    const world = makeTinyWorld();
    for (const narrative of ["string", '"string"', "(none)", "none"]) {
      const errors = validateRenderProse(
        world,
        { actorId: "u", text: "Walk to Nadia at the entrance." },
        { ...baseResult(narrative), thoughts: "Hmm." },
        baseFacts(),
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errorText(errors)).toMatch(/placeholder/);
    }
  });

  it("rejects verbatim action-text echoes", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Walk to N at the entrance." },
      { ...baseResult("Walk to N at the entrance."), thoughts: "Hmm." },
      baseFacts(),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errorText(errors)).toMatch(/echoes/);
  });

  it("narrated locomotion with no engine move still fails", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Walk to Nadia at the entrance." },
      baseResult("U walks to Nadia at the entrance."),
      baseFacts(),
    );
    expect(errors.some((e) => e.code === "movement.narrated_without_move")).toBe(true);
  });
});

describe("exp2-2 acting-actor prose required (tick 11)", () => {
  it("rejects observer-as-subject prose on a contact turn", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const action = { actorId: "u", text: "Shake hands with Nadia." };
    // Tick-11 shape, Phase 4: the narrative must describe the acting
    // actor — observer-subject prose fails, no patches involved.
    const errors = validateRenderProse(
      world,
      action,
      { ...baseResult("Nadia sips her coffee."), thoughts: "Nice to meet U." },
      baseFacts(),
    );
    expect(errors.some((e) => e.code === "narrative.observer_as_subject")).toBe(true);
  });

  it("accepts the grounded handshake narrative", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const action = { actorId: "u", text: "Shake hands with Nadia." };
    const errors = validateRenderProse(
      world,
      action,
      { ...baseResult("U shakes hands with Nadia."), thoughts: "Firm grip." },
      baseFacts({ moved: true, x: 3, y: 3 }),
    );
    expect(errors).toEqual([]);
  });

  it("keeps speech-only greetings valid", () => {
    const world = makeTinyWorld();
    const quote = "Hi all!";
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: `"${quote}"` },
      baseResult(`U says "${quote}" to the room.`),
      baseFacts({ exactQuote: quote }),
    );
    expect(errors).toEqual([]);
  });
});

describe("exp2-3 narrative name audit (ticks 2/5/14)", () => {
  it("rejects prose naming a non-existent actor", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Walk toward Nadia." },
      { ...baseResult("U walks closer to Jeff and pats him on the back."), thoughts: "Welcome!" },
      baseFacts({ moved: true, x: 2, y: 1 }),
    );
    expect(errors.some((e) => e.code === "narrative.unknown_actor")).toBe(true);
    expect(errorText(errors)).toMatch(/unknown actor "Jeff"/);
  });

  it("rejects vocative hallucinations (Hey Jeff)", () => {
    const world = makeTinyWorld();
    const quote = "Hey Jeff, welcome!";
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: `Say "${quote}"` },
      { ...baseResult(`U waves and says "${quote}"`), thoughts: "Friendly." },
      baseFacts({ exactQuote: quote }),
    );
    expect(errors.some((e) => e.code === "narrative.unknown_actor")).toBe(true);
  });

  it("accepts prose naming roster actors and scene landmarks", () => {
    const world = officeWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Walk toward Nadia." },
      { ...baseResult("Anton walks toward Nadia near the coffee machine."), thoughts: "Going." },
      baseFacts({ moved: true, x: 2, y: 2 }),
    );
    expect(errors).toEqual([]);
  });
});


describe("exp2-6 destination fidelity (ticks 7/17/27)", () => {
  it("resolves 'my desk' to the acting actor's own desk", () => {
    const world = officeWorld();
    const s = mockClassifyAction(world, { actorId: "u", text: "Walk to my desk to sit down." });
    expect(s.moves).toBe(true);
    expect(s.destinationObjectId).toBe("anton_desk");
  });

  it("the engine step moves strictly closer to the named landmark (tick-27 shape)", () => {
    // Phase 4: the arrival gate was a patch validator (the model's x/y
    // vs the landmark). Now the engine computes the step itself, so a
    // step away from the target is impossible by construction.
    const world = officeWorld();
    world.actors.find((a) => a.id === "u")!.x = 0;
    world.actors.find((a) => a.id === "u")!.y = 0;
    const o = computeMovementOutcome(world, "u", { destinationObjectId: "anton_desk" });
    expect(o).not.toBeNull();
    const desk = world.scene.objects.find((ob) => ob.id === "anton_desk")!;
    const cx = desk.x + desk.w / 2, cy = desk.y + desk.h / 2;
    expect(Math.hypot(o!.x - cx, o!.y - cy)).toBeLessThan(Math.hypot(0 - cx, 0 - cy));
  });
});

describe("exp2-7 object grounding (Phase 4: engine-owned)", () => {
  it("the engine plans the sit pose from the action text (no patch needed)", async () => {
    const { planPose } = await import("../../src/core/text.js");
    expect(planPose("Sit on the chair at my desk.")).toBe("sit");
    expect(planPose("U approaches Nadia, saying hello.")).toBeNull();
  });

  it("rejects narrated sitting the engine did not plan", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Look at the desk." },
      { ...baseResult("U sits on the chair at the desk."), thoughts: "Settled." },
      baseFacts({ pose: null }),
    );
    expect(errors.some((e) => e.code === "object_grounding.sit_no_pose")).toBe(true);
  });

  it("pouring is engine-executed: the cup pick-up needs no model patch (Phase 3)", () => {
    const world = officeWorld();
    world.scene.objects.push({
      id: "u_mug", name: "U's mug", description: "A mug.",
      x: 1, y: 1, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    const action = { actorId: "u", text: "Pour a coffee." };
    // u at (1,1): next to the coffee machine (0,0) and the mug — the
    // engine plans the cup pick-up itself.
    const outcome = executeManipulation(world, action);
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.kind).toBe("pick-up");
    expect(outcome!.plan.propName).toBe("cup");
    const errors = validateRenderProse(
      world,
      action,
      { ...baseResult("U pours a coffee and remarks on the taste."), thoughts: "Good." },
      baseFacts({ engineManipulation: outcome }),
    );
    expect(errors).toEqual([]);
  });

  it("lets resumed typing pass", () => {
    const world = makeTinyWorld();
    const quote = "hello";
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: `Call out "${quote}", then return to typing.` },
      { ...baseResult("U calls out hello, then returns to typing."), thoughts: "Focused." },
      baseFacts({ exactQuote: quote }),
    );
    expect(errors).toEqual([]);
  });
});

describe("exp2-9/12/13 roster anchor, pronouns, de-dup", () => {
  it("extracts pronouns from personas", () => {
    expect(
      extractPronouns("Dana is a tech recruiter in his late 20s. He is outgoing."),
    ).toBe("he/him");
    expect(
      extractPronouns("Tanya is a QA engineer in her early 30s. She is practical."),
    ).toBe("she/her");
  });

  it("roster anchor lists everyone with pronouns and a closed world", () => {
    const world = officeWorld();
    const anchor = buildRosterAnchor(world);
    expect(anchor).toContain("Anton (u,");
    expect(anchor).toContain("Nadia (n,");
    expect(anchor).toMatch(/only.*exist|no one else exists/i);
    expect(anchor).toMatch(/never invent/i);
  });

  it("the narrate context carries the roster rule", () => {
    const world = officeWorld();
    world.history.push(hist(world, "Anton: Nadia, where is my desk?"));
    world.history.push(hist(world, "Nadia: Welcome to the team, Anton!"));
    world.history.push(hist(world, "Anton: Nadia, please stop greeting me."));
    const ctx = buildNarrateContext(world, { actorId: "u", text: "Hi!" }, undefined, {});
    expect(ctx).toContain("ROSTER RULE");
    expect(ctx).toMatch(/no one else exists/i);
  });

  it("roster anchor leaks no private goals/memories", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.goal = "SECRET-PLAN-123";
    expect(buildRosterAnchor(world)).not.toContain("SECRET-PLAN-123");
  });
});
