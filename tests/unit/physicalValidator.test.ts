import { describe, expect, it } from "vitest";
import { looksLikeMovementIntent, validateConsequence } from "../../src/engine/physicalValidator.js";
import { makeTinyWorld } from "../helpers.js";
import type { ConsequenceResult } from "../../src/types.js";

function baseResult(): ConsequenceResult {
  return { narrative: "Something happens.", actorPatches: [], objectPatches: [], reasoning: "r" };
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
    expect(v.errors.join(" ")).toMatch(/outside scene/);
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
    expect(v.errors.join(" ")).toMatch(/non-passable/);
  });

  it("rejects unreachable movement (walled off)", () => {
    const world = makeTinyWorld();
    // Vertical wall splitting the 6x6 scene at x=3.
    world.scene.objects.push({
      id: "wall", name: "Wall", description: "A wall.",
      x: 3, y: 0, w: 1, h: 6, passable: false, blocksVision: true, blocksSound: true,
    });
    const result = baseResult();
    result.actorPatches = [{ actorId: "u", x: 4, y: 4 }];
    const v = validateConsequence(world, result);
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/no valid path/);
  });

  it("rejects unknown actor id", () => {
    const world = makeTinyWorld();
    const result = baseResult();
    result.actorPatches = [{ actorId: "ghost", emotion: "happy" }];
    const v = validateConsequence(world, result);
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/unknown actor id/);
  });

  it("rejects unknown object id", () => {
    const world = makeTinyWorld();
    const result = baseResult();
    result.objectPatches = [{ objectId: "ghost", description: "x" }];
    const v = validateConsequence(world, result);
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/unknown object id/);
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

  it("rejects invented dialogue not present in the action", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: '"Greeting all!"' };
    const invented: ConsequenceResult = {
      narrative:
        "Anton stands up straight and greets all, his nervous expression softening slightly as he says, 'Hello, everyone! I'm Anton, and I'll be working here from now on.'",
      actorPatches: [],
      objectPatches: [],
      reasoning: "r",
    };
    const v = validateConsequence(world, invented, action);
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/invent/);
  });

  it("accepts narratives that preserve the action's exact words", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: '"Greeting all!"' };
    const faithful: ConsequenceResult = {
      narrative: 'U straightens up and says "Greeting all!" to the room.',
      actorPatches: [],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, faithful, action)).toEqual({ valid: true, errors: [] });
  });

  it("does not treat in-place gestures as movement (log regression)", () => {
    expect(
      looksLikeMovementIntent(
        "Shake his head and let out a frustrated grunt, before reaching for his coffee mug and taking a long swig to collect himself, his gaze fixed intensely on his computer screen.",
      ),
    ).toBe(false);
    expect(
      looksLikeMovementIntent(
        "Turn to look at Anton as he enters, smiling in his direction and raising a hand in a casual wave, before focusing back on her task with a slight rustle of papers.",
      ),
    ).toBe(false);
    expect(looksLikeMovementIntent("Shake his head")).toBe(false);
    expect(looksLikeMovementIntent("Nod her head and wave")).toBe(false);
  });

  it("still detects real locomotion", () => {
    expect(looksLikeMovementIntent("Come closer to Tanya")).toBe(true);
    expect(looksLikeMovementIntent("Walk to the coffee machine")).toBe(true);
    expect(looksLikeMovementIntent("Head to the door")).toBe(true);
    expect(looksLikeMovementIntent("Return to the door")).toBe(true);
    expect(looksLikeMovementIntent("Return to her desk")).toBe(true);
  });

  it("does not treat resuming a task as movement (office-anton log regression)", () => {
    // Tick 1: "then return to typing" is resuming work, not locomotion.
    expect(
      looksLikeMovementIntent(
        "3. Call out a friendly 'Hey!' as she sees Anton, then return to typing, an open and welcoming demeanor still present even with full focus on the task at hand.",
      ),
    ).toBe(false);
    // Tick 2: "returning to staring at the monitor" is resuming work.
    expect(
      looksLikeMovementIntent(
        "Sighs, rubs temples, and mutters 'Just a few more minutes...' before returning to staring at the monitor, trying to refocus.",
      ),
    ).toBe(false);
    expect(looksLikeMovementIntent("Return to work")).toBe(false);
    expect(looksLikeMovementIntent("Go back to typing")).toBe(false);
  });

  it("accepts task-resuming consequences without x/y position change", () => {
    const world = makeTinyWorld();
    const action = {
      actorId: "u",
      text: "Call out a friendly 'Hey!' as she sees N, then return to typing.",
    };
    const result: ConsequenceResult = {
      narrative: "U calls out a friendly 'Hey!' then returns to typing.",
      actorPatches: [{ actorId: "u", thoughts: "Focused." }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, result, action)).toEqual({ valid: true, errors: [] });
  });

  it("accepts gesture consequences without x/y position change", () => {
    const world = makeTinyWorld();
    const action = {
      actorId: "u",
      text: "Shake his head and take a long swig of coffee, gazing at the screen.",
    };
    const result: ConsequenceResult = {
      narrative: "U shakes his head and takes a long swig of coffee, gazing at the screen.",
      actorPatches: [{ actorId: "u", thoughts: "Focus." }],
      objectPatches: [],
      reasoning: "r",
    };
    expect(validateConsequence(world, result, action)).toEqual({ valid: true, errors: [] });
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
    };
    const v = validateConsequence(world, result, { actorId: "u", text: "Walk to the desk" });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/desk/);
  });
});
