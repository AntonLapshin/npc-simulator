// Regression tests for experiment-2.md action items 1-13
// (office-anton.json, 10 adaptive user turns, local 8B, ticks 0-29).
import { describe, expect, it } from "vitest";
import { validateConsequence } from "../../src/engine/physicalValidator.js";
import {
  buildConsequenceContext,
  buildProposalContext,
  buildRosterAnchor,
  buildSelectionContext,
  extractPronouns,
} from "../../src/engine/contextBuilder.js";
import { resolveActionSemantics } from "../../src/engine/actionSemantics.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import { consequenceResultSchema } from "../../src/schemas.js";
import { mockClassifyAction } from "../../src/mocks/mockSemanticJudge.js";
import { MockSemanticJudge } from "../../src/mocks/mockSemanticJudge.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { makeTinyWorld, hist, errorText } from "../helpers.js";
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
      const v = validateConsequence(
        world,
        { ...baseResult(narrative), actorPatches: [{ actorId: "u", thoughts: "Hmm." }] },
        { actorId: "u", text: "Walk to N at the entrance." },
        stillSemantics(),
      );
      expect(v.valid).toBe(false);
      expect(errorText(v.errors)).toMatch(/placeholder/);
    }
  });

  it("rejects verbatim action-text echoes", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("Walk to N at the entrance."),
        actorPatches: [{ actorId: "u", thoughts: "Hmm." }],
      },
      { actorId: "u", text: "Walk to N at the entrance." },
      stillSemantics(),
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/echoes/);
  });

  it("zero patches + zero movement for a movement action still fails", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      baseResult("U walks to N at the entrance."),
      { actorId: "u", text: "Walk to N at the entrance." },
      { moves: true, destinationActorId: "n", speaks: false, quotedSpeech: [] },
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/no position change|no actorPatch/);
  });
});

describe("exp2-2 acting-actor patch required (tick 11)", () => {
  it("rejects contact turns that patch observers only", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Shake hands with N." };
    const semantics: ActionSemantics = {
      moves: false, speaks: false, quotedSpeech: [], contactActorId: "n",
    };
    // Tick-11 shape: acting actor unpatched, observer patched.
    const observerOnly: ConsequenceResult = {
      ...baseResult("N sips her coffee."),
      actorPatches: [{ actorId: "n", thoughts: "Nice to meet U." }],
    };
    const v = validateConsequence(world, observerOnly, action, semantics);
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/acting actor.*no actorPatch/);

    const both: ConsequenceResult = {
      ...baseResult("U shakes hands with N."),
      actorPatches: [
        { actorId: "u", x: 3, y: 3, thoughts: "Firm grip." },
        { actorId: "n", thoughts: "Welcome aboard." },
      ],
      effects: { moved: true, spoke: false, destinationActorId: "n", contactActorId: "n" },
    };
    expect(
      validateConsequence(world, both, action, { ...semantics, moves: true }).valid,
    ).toBe(true);
  });

  it("keeps speech-only greetings with zero patches valid", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      baseResult('U says "Hi all!" to the room.'),
      { actorId: "u", text: '"Hi all!"' },
      { moves: false, speaks: true, quotedSpeech: ["Hi all!"] },
    );
    expect(v.valid).toBe(true);
  });
});

describe("exp2-3 narrative name audit (ticks 2/5/14)", () => {
  it("rejects prose naming a non-existent actor", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U walks closer to Jeff and pats him on the back."),
        actorPatches: [{ actorId: "u", x: 2, y: 1, thoughts: "Welcome!" }],
      },
      { actorId: "u", text: "Walk toward N." },
      stillSemantics(),
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/unknown actor "Jeff"/);
  });

  it("rejects vocative hallucinations (Hey Jeff)", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult('U waves and says "Hey Jeff, welcome!"'),
        actorPatches: [
          { actorId: "u", thoughts: "Friendly." },
          { actorId: "n", thoughts: "Who is Jeff?" },
        ],
        effects: { moved: false, spoke: true, quotedSpeech: ["Hey Jeff, welcome!"] },
      },
      { actorId: "u", text: 'Say "Hey Jeff, welcome!"' },
      { moves: false, speaks: true, quotedSpeech: ["Hey Jeff, welcome!"] },
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/unknown actor/);
  });

  it("accepts prose naming roster actors and scene landmarks", () => {
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

describe("exp2-4 deterministic gates incl. user turns (ticks 18/21/28/29)", () => {
  it("merged semantics restore movement the effects lied about", async () => {
    const world = makeTinyWorld();
    const logger = createTestLogger();
    // Tick-18 shape: walk-to-N + question answered with "adjusts his tie",
    // declared moved=false/spoke=false to dodge the gates.
    const resolved = await resolveActionSemantics(
      world,
      { actorId: "u", text: 'Walk toward N and ask "where is my desk?"' },
      {
        narrative: "U adjusts his tie.",
        actorPatches: [{ actorId: "u", thoughts: "Sharp." }],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: false, spoke: false },
      },
      new MockSemanticJudge(),
      logger,
    );
    expect(resolved.source).toBe("merged");
    const v = validateConsequence(
      world,
      {
        narrative: "U adjusts his tie.",
        actorPatches: [{ actorId: "u", thoughts: "Sharp." }],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: false, spoke: false },
      },
      { actorId: "u", text: 'Walk toward N and ask "where is my desk?"' },
      resolved.semantics!,
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/no position change|exact words/);
  });

  it("effects schema preserves destination/addressee/contact ids", () => {
    const parsed = consequenceResultSchema.safeParse({
      narrative: "U walks to N and asks for help.",
      actorPatches: [{ actorId: "u", x: 2, y: 2 }],
      objectPatches: [],
      reasoning: "r",
      effects: {
        moved: true,
        spoke: true,
        quotedSpeech: ["help me"],
        destinationActorId: "n",
        destinationObjectId: "coffee_machine",
        addresseeActorId: "n",
        contactActorId: "n",
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.effects).toMatchObject({
        destinationObjectId: "coffee_machine",
        addresseeActorId: "n",
        contactActorId: "n",
      });
    }
  });
});

describe("exp2-6 destination fidelity (ticks 7/17/27)", () => {
  it("resolves 'my desk' to the acting actor's own desk", () => {
    const world = officeWorld();
    const s = mockClassifyAction(world, { actorId: "u", text: "Walk to my desk to sit down." });
    expect(s.moves).toBe(true);
    expect(s.destinationObjectId).toBe("anton_desk");
  });

  it("rejects arrival claims far from the named landmark", () => {
    const world = officeWorld();
    // Tick-27 shape: "walks to his desk and begins typing" but lands across
    // the room. Start far so the landing is strictly closer yet not arrival.
    world.actors.find((a) => a.id === "u")!.x = 0;
    world.actors.find((a) => a.id === "u")!.y = 0;
    const action = { actorId: "u", text: "Walk to my desk and set up." };
    const semantics: ActionSemantics = {
      moves: true, destinationObjectId: "anton_desk", speaks: false, quotedSpeech: [],
    };
    const far: ConsequenceResult = {
      ...baseResult("Anton walks to his desk on the far side and begins typing."),
      actorPatches: [{ actorId: "u", x: 1, y: 1, pose: "sit", prop: "laptop" }],
      effects: { moved: true, spoke: false, destinationObjectId: "anton_desk" },
    };
    const vFar = validateConsequence(world, far, action, semantics);
    expect(vFar.valid).toBe(false);
    expect(errorText(vFar.errors)).toMatch(/AT Anton's desk|cells away/);
  });
});

describe("exp2-7 object grounding (30/30 empty objectPatches)", () => {
  it("requires a pose patch for sitting", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Sit on the chair at my desk." };
    const missing: ConsequenceResult = {
      ...baseResult("U approaches Nadia, saying hello."),
      actorPatches: [{ actorId: "u", x: 2, y: 2, thoughts: "Hi." }],
    };
    expect(
      validateConsequence(world, missing, action, stillSemantics()).valid,
    ).toBe(false);

    const seated: ConsequenceResult = {
      ...baseResult("U sits on the chair at the desk."),
      actorPatches: [{ actorId: "u", x: 2, y: 1, pose: "sit", thoughts: "Settled." }],
    };
    expect(validateConsequence(world, seated, action, stillSemantics())).toEqual({
      valid: true,
      errors: [],
    });
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
    const poured: ConsequenceResult = {
      ...baseResult("U pours a coffee and remarks on the taste."),
      actorPatches: [
        { actorId: "u", x: 1, y: 1, thoughts: "Good." },
        { actorId: "n", thoughts: "Coffee smells nice." },
      ],
      objectPatches: [],
    };
    expect(
      validateConsequence(world, poured, action, stillSemantics(), undefined, outcome),
    ).toEqual({ valid: true, errors: [] });
  });

  it("lets resumed typing pass without a fresh patch", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(
      world,
      {
        ...baseResult("U calls out hello, then returns to typing."),
        actorPatches: [{ actorId: "u", thoughts: "Focused." }],
        effects: { moved: false, spoke: true, quotedSpeech: ["hello"] },
      },
      { actorId: "u", text: 'Call out "hello", then return to typing.' },
      { moves: false, speaks: true, quotedSpeech: ["hello"] },
    );
    expect(v).toEqual({ valid: true, errors: [] });
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

  it("proposal/selection/consequence contexts all carry the roster", () => {
    const world = officeWorld();
    world.history.push(hist(world, "Anton: Nadia, where is my desk?"));
    world.history.push(hist(world, "Nadia: Welcome to the team, Anton!"));
    world.history.push(hist(world, "Anton: Nadia, please stop greeting me."));
    const proposal = buildProposalContext(world, "n");
    expect(proposal).toContain("ROSTER");
    expect(proposal).toMatch(/never invent/i);
    expect(proposal).toMatch(/do NOT repeat/i);
    const selection = buildSelectionContext(world, "n", ["Point at the desk."]);
    expect(selection).toContain("ROSTER");
    expect(selection).toMatch(/ANSWER/i);
    const consequence = buildConsequenceContext(world, { actorId: "u", text: "Hi!" });
    expect(consequence).toContain("ROSTER RULE");
    expect(consequence).toMatch(/no one else exists/i);
  });

  it("roster anchor leaks no private goals/memories", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.goal = "SECRET-PLAN-123";
    expect(buildRosterAnchor(world)).not.toContain("SECRET-PLAN-123");
    expect(buildProposalContext(world, "u")).not.toContain("SECRET-PLAN-123");
  });
});
