import { describe, expect, it } from "vitest";
import { validateConsequence } from "../../src/engine/physicalValidator.js";
import { MockSemanticJudge } from "../../src/mocks/mockSemanticJudge.js";
import { makeTinyWorld, errorText } from "../helpers.js";
import type { ActionSemantics, ConsequenceResult } from "../../src/types.js";

function baseResult(): ConsequenceResult {
  return { narrative: "Something happens.", actorPatches: [], objectPatches: [], reasoning: "r" };
}

function stillSemantics(): ActionSemantics {
  return { moves: false, speaks: false, quotedSpeech: [] };
}

describe("physicalValidator", () => {
  it("accepts valid movement", () => {
    const world = makeTinyWorld();
    const result = baseResult();
    result.actorPatches = [{ actorId: "u", x: 2, y: 1 }];
    expect(validateConsequence(world, result)).toEqual({ valid: true, errors: [] });
  });

  it("rejects out-of-bounds movement", () => {
    const world = makeTinyWorld();
    const result = baseResult();
    result.actorPatches = [{ actorId: "u", x: 99, y: 99 }];
    const v = validateConsequence(world, result);
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/outside scene/);
  });

  it("rejects movement into non-passable object", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "rock", name: "Rock", description: "A rock.",
      x: 2, y: 1, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false,
    });
    const result = baseResult();
    result.actorPatches = [{ actorId: "u", x: 2, y: 1 }];
    const v = validateConsequence(world, result);
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/non-passable/);
  });

  it("rejects unreachable movement (walled off)", () => {
    const world = makeTinyWorld();
    // Vertical wall splitting the 6x6 scene at x=3.
    world.scene.objects.push({
      id: "wall", name: "Wall", description: "A wall.",
      x: 3, y: 0, w: 1, h: 6, passable: false, blocksVision: true, blocksSound: true,
    });
    const result = baseResult();
    // F10: (4,4) is occupied by n now — use a free cell across the wall.
    result.actorPatches = [{ actorId: "u", x: 5, y: 1 }];
    const v = validateConsequence(world, result);
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/no valid path/);
  });

  it("rejects unknown actor id", () => {
    const world = makeTinyWorld();
    const result = baseResult();
    result.actorPatches = [{ actorId: "ghost", emotion: "happy" }];
    const v = validateConsequence(world, result);
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/unknown actor id/);
  });

  it("rejects unknown object id", () => {
    const world = makeTinyWorld();
    const result = baseResult();
    result.objectPatches = [{ objectId: "ghost", description: "x" }];
    const v = validateConsequence(world, result);
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/unknown object id/);
  });

  it("rejects invalid boolean flags", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "door", name: "Door", description: "A door.",
      x: 0, y: 0, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    const result = baseResult();
    result.objectPatches = [{ objectId: "door", passable: "yes" as unknown as boolean }];
    const v = validateConsequence(world, result);
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it("rejects invalid coordinates (x without y, non-finite)", () => {
    const world = makeTinyWorld();
    const partial = baseResult();
    partial.actorPatches = [{ actorId: "u", x: 2 }];
    expect(validateConsequence(world, partial).valid).toBe(false);

    const nan = baseResult();
    nan.actorPatches = [{ actorId: "u", x: NaN, y: 1 }];
    expect(validateConsequence(world, nan).valid).toBe(false);
  });

  it("rejects schema-invalid payloads", () => {
    const world = makeTinyWorld();
    const v = validateConsequence(world, { narrative: "", actorPatches: [], objectPatches: [], reasoning: "r" });
    expect(v.valid).toBe(false);
  });

  it("rejects invented dialogue not present in the judged utterances", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: '"Greeting all!"' };
    const semantics: ActionSemantics = { moves: false, speaks: true, quotedSpeech: ["Greeting all!"] };
    const invented: ConsequenceResult = {
      narrative:
        "Anton stands up straight and greets all, his nervous expression softening slightly as he says, 'Hello, everyone! I'm Anton, and I'll be working here from now on.'",
      actorPatches: [],
      objectPatches: [],
      reasoning: "r",
    };
    const v = validateConsequence(world, invented, action, semantics);
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/invent/);
  });

  it("accepts narratives that preserve the judged utterances", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: '"Greeting all!"' };
    const semantics: ActionSemantics = { moves: false, speaks: true, quotedSpeech: ["Greeting all!"] };
    const faithful: ConsequenceResult = {
      narrative: 'U straightens up and says "Greeting all!" to the room.',
      actorPatches: [],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, faithful, action, semantics)).toEqual({ valid: true, errors: [] });
  });

  it("allows short greeting renders when the judge reports speech without quotes", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Say hello to the room." };
    const semantics: ActionSemantics = { moves: false, speaks: true, quotedSpeech: [] };
    const rendered: ConsequenceResult = {
      narrative: "U looks up and says 'Hi!' to the room.",
      actorPatches: [],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, rendered, action, semantics)).toEqual({ valid: true, errors: [] });
  });

  it("requires x/y when semantics report movement, never otherwise", () => {
    const world = makeTinyWorld();
    const moving: ActionSemantics = { moves: true, speaks: false, quotedSpeech: [] };

    // No position change at all.
    const missing: ConsequenceResult = {
      narrative: "U walks across the room.",
      actorPatches: [{ actorId: "u", thoughts: "Going." }],
      objectPatches: [],
      reasoning: "r",
    };
    const vMissing = validateConsequence(world, missing, { actorId: "u", text: "Walk." }, moving);
    expect(vMissing.valid).toBe(false);
    expect(errorText(vMissing.errors)).toMatch(/no position change/);

    // Unchanged position.
    const same: ConsequenceResult = {
      narrative: "U walks across the room.",
      actorPatches: [{ actorId: "u", x: 1, y: 1 }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, same, { actorId: "u", text: "Walk." }, moving).valid).toBe(false);

    // Real position change passes.
    const moved: ConsequenceResult = {
      narrative: "U walks across the room.",
      actorPatches: [{ actorId: "u", x: 2, y: 1 }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, moved, { actorId: "u", text: "Walk." }, moving)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("enforces strictly-closer via resolved id (pronouns need no substring match)", () => {
    const world = makeTinyWorld();
    // "Walk toward him" names no one by substring — the judge resolves the id.
    const towardN: ActionSemantics = {
      moves: true,
      destinationActorId: "n",
      speaks: false,
      quotedSpeech: [],
    };
    const action = { actorId: "u", text: "Walk toward him." };

    const closer: ConsequenceResult = {
      narrative: "U walks toward N.",
      actorPatches: [{ actorId: "u", x: 2, y: 2 }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, closer, action, towardN)).toEqual({ valid: true, errors: [] });

    const away: ConsequenceResult = {
      narrative: "U walks toward N.",
      actorPatches: [{ actorId: "u", x: 0, y: 0 }],
      objectPatches: [],
      reasoning: "r",
    };
    const vAway = validateConsequence(world, away, action, towardN);
    expect(vAway.valid).toBe(false);
    expect(errorText(vAway.errors)).toMatch(/not closer/);
  });

  it("skips the closer-to check for unknown destination ids", () => {
    const world = makeTinyWorld();
    const semantics: ActionSemantics = {
      moves: true,
      destinationActorId: "ghost",
      speaks: false,
      quotedSpeech: [],
    };
    const result: ConsequenceResult = {
      narrative: "U walks somewhere.",
      actorPatches: [{ actorId: "u", x: 2, y: 1 }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, result, { actorId: "u", text: "Walk." }, semantics)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("derives semantics from self-declared effects when none are injected", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Saunter over to N." };

    const declaredStill: ConsequenceResult = {
      narrative: "U stays put.",
      actorPatches: [{ actorId: "u", thoughts: "Idle." }],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: false, spoke: false },
    };
    expect(validateConsequence(world, declaredStill, action)).toEqual({ valid: true, errors: [] });

    const declaredMoved: ConsequenceResult = {
      narrative: "U saunters over.",
      actorPatches: [{ actorId: "u", thoughts: "Strolling." }],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: true, spoke: false },
    };
    const v = validateConsequence(world, declaredMoved, action);
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/no position change/);
  });

  it("fails open to physics-only without effects or injected semantics", () => {
    const world = makeTinyWorld();
    // Movement-sounding prose with no position change: no judge, no
    // declaration — physics (bounds/reachability) still applies, but no
    // semantic "must emit x/y" error is raised.
    const result: ConsequenceResult = {
      narrative: "U stays put.",
      actorPatches: [{ actorId: "u", thoughts: "Idle." }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(
      validateConsequence(world, result, { actorId: "u", text: "Walk to the door." }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("honors judge paraphrase probes (locomotion and non-locomotion)", () => {
    const world = makeTinyWorld();
    // "saunters over" IS locomotion (an LLM judge resolves this; the
    // validator only enforces the verdict).
    const saunter: ActionSemantics = { moves: true, speaks: false, quotedSpeech: [] };
    const saunterResult: ConsequenceResult = {
      narrative: "U saunters over.",
      actorPatches: [{ actorId: "u", thoughts: "Strolling." }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(
      validateConsequence(world, saunterResult, { actorId: "u", text: "Saunter over." }, saunter).valid,
    ).toBe(false);

    // "rolls her chair closer" IS locomotion.
    const chair: ActionSemantics = { moves: true, speaks: false, quotedSpeech: [] };
    expect(
      validateConsequence(world, saunterResult, { actorId: "u", text: "Roll her chair closer." }, chair)
        .valid,
    ).toBe(false);

    // "go the extra mile" is metaphor — NOT movement. (Exp-4 item 2: a
    // narrative that itself narrates locomotion still needs the patch, so
    // the still-narrative case uses effort prose, not "saunters over".)
    const mile: ActionSemantics = { moves: false, speaks: false, quotedSpeech: [] };
    const mileResult: ConsequenceResult = {
      narrative: "U puts in extra effort on the report.",
      actorPatches: [{ actorId: "u", thoughts: "Focused." }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(
      validateConsequence(world, mileResult, { actorId: "u", text: "Go the extra mile." }, mile),
    ).toEqual({ valid: true, errors: [] });
  });

  it("accepts task-resuming consequences without x/y (office-anton regression)", () => {
    const world = makeTinyWorld();
    const judge = new MockSemanticJudge();
    const cases: Array<[string, string]> = [
      [
        "Call out a friendly 'Hey!' as she sees N, then return to typing.",
        "U calls out a friendly 'Hey!' then returns to typing.",
      ],
      [
        "Sighs, rubs temples, and mutters 'Just a few more minutes...' before returning to staring at the monitor, trying to refocus.",
        "U mutters 'Just a few more minutes...' before returning to staring at the monitor.",
      ],
    ];
    return (async () => {
      for (const [text, narrative] of cases) {
        const action = { actorId: "u", text };
        const semantics = await judge.classify(world, action);
        expect(semantics.moves).toBe(false);
        const result: ConsequenceResult = {
          narrative,
          actorPatches: [{ actorId: "u", thoughts: "Focused." }],
          objectPatches: [],
          reasoning: "r",
        };
        expect(validateConsequence(world, result, action, semantics)).toEqual({
          valid: true,
          errors: [],
        });
      }
    })();
  });

  it("accepts in-place gestures without x/y (log regression)", () => {
    const world = makeTinyWorld();
    const judge = new MockSemanticJudge();
    const cases = [
      "Shake his head and let out a frustrated grunt, before reaching for his coffee mug and taking a long swig to collect himself, his gaze fixed intensely on his computer screen.",
      "Turn to look at N as he enters, smiling in his direction and raising a hand in a casual wave, before focusing back on her task with a slight rustle of papers.",
    ];
    return (async () => {
      for (const text of cases) {
        const action = { actorId: "u", text };
        const semantics = await judge.classify(world, action);
        expect(semantics.moves).toBe(false);
        const result: ConsequenceResult = {
          narrative: "U gestures in place.",
          actorPatches: [{ actorId: "u", thoughts: "Focus." }],
          objectPatches: [],
          reasoning: "r",
        };
        expect(validateConsequence(world, result, action, semantics)).toEqual({
          valid: true,
          errors: [],
        });
      }
    })();
  });

  it("mock judge still detects real locomotion", async () => {
    const world = makeTinyWorld();
    // Single-letter ids/names never substring-match (false-positive guard),
    // so give the target a full name for the destination check.
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const judge = new MockSemanticJudge();
    for (const [text, destinationActorId] of [
      ["Come closer to Nadia", "n"],
      ["Walk to the coffee machine", undefined],
      ["Head to the door", undefined],
      ["Return to the door", undefined],
    ] as Array<[string, string | undefined]>) {
      const semantics = await judge.classify(world, { actorId: "u", text });
      expect(semantics.moves).toBe(true);
      expect(semantics.destinationActorId).toBe(destinationActorId);
    }
  });

  it("murmurs-a-greeting speech is preserved via judged quotes", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Murmur a greeting to the room." };
    const semantics: ActionSemantics = { moves: false, speaks: true, quotedSpeech: ["hello there"] };
    const invented: ConsequenceResult = {
      narrative: "U steps forward and declares 'I am the king of this office!'",
      actorPatches: [],
      objectPatches: [],
      reasoning: "r",
    };
    const v = validateConsequence(world, invented, action, semantics);
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/invent/);
  });

  it("names the blocking object when coordinates land inside furniture", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "desk", name: "Desk", description: "A desk.",
      x: 2, y: 1, w: 2, h: 2, passable: false, blocksVision: false, blocksSound: false,
    });
    const result: ConsequenceResult = {
      narrative: "U walks to the desk.",
      actorPatches: [{ actorId: "u", x: 2, y: 1 }],
      objectPatches: [],
      reasoning: "r",
      effects: { moved: true, spoke: false },
    };
    const v = validateConsequence(world, result, { actorId: "u", text: "Walk to the desk" });
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/desk/);
  });

  it("still reports stillness without semantics (fail-open physics check)", () => {
    const world = makeTinyWorld();
    // Sipping from an already-held cup changes nothing — no fresh patch owed.
    world.actors.find((a) => a.id === "u")!.prop = "cup";
    const result: ConsequenceResult = {
      narrative: "U shakes his head and takes a long swig of coffee, gazing at the screen.",
      actorPatches: [{ actorId: "u", thoughts: "Focus." }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(
      validateConsequence(
        world,
        result,
        { actorId: "u", text: "Shake his head and take a long swig of coffee, gazing at the screen." },
        stillSemantics(),
      ),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects sipping/typing grounding with nothing held and no patch", () => {
    const world = makeTinyWorld();
    expect(world.actors.find((a) => a.id === "u")!.prop).toBeNull();
    const result: ConsequenceResult = {
      narrative: "U takes a long swig of coffee, gazing at the screen.",
      actorPatches: [{ actorId: "u", thoughts: "Focus." }],
      objectPatches: [],
      reasoning: "r",
    };
    const v = validateConsequence(
      world,
      result,
      { actorId: "u", text: "Take a swig of coffee." },
      stillSemantics(),
    );
    expect(v.valid).toBe(false);
    expect(errorText(v.errors)).toMatch(/sipping\/drinking\/typing|prop/);
  });
});
