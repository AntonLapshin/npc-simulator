// Stage-1 action items (experiments/stage1-mechanics-report.md):
// A1 — repetition-screen `other|desk` collision; A2 — third-person
// put-down verb ontology; A3 — held scene-object identity; A4 —
// destination grounding + action-derived history cores.

import { describe, expect, it } from "vitest";
import {
  findCoreRepeat,
  getRecentOwnActions,
  suggestionCore,
} from "../../src/engine/contextBuilder.js";
import {
  detectNarrativeManipulation,
  planManipulation,
  type CoreObject,
  type ManipulationSnapshot,
} from "../../src/core/objects.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import { applyRenderResult } from "../../src/engine/patchApplier.js";
import { validateNarrativeDestinationGrounding } from "../../src/engine/validate/narrative.js";
import { errorText, hist, makeTinyWorld } from "../helpers.js";
import type { Actor, World } from "../../src/types.js";

function actorsWorld(): World {
  return {
    actors: [
      { id: "anton", name: "Anton" },
      { id: "tanya", name: "Tanya" },
      { id: "dana", name: "Dana" },
    ],
    history: [],
  } as unknown as World;
}

const LAPTOP = {
  pickable: true,
  propName: "laptop",
  surface: false,
  container: false,
  brewSource: false,
} as const;

function laptopObj(id: string, x: number, y: number): CoreObject {
  return { id, name: "Laptop", x, y, w: 1, h: 1, affordance: { ...LAPTOP } };
}

function holdingWorld(heldObjectId: string | null): ManipulationSnapshot {
  return {
    actors: [
      { id: "u", name: "U", x: 0, y: 0, prop: "laptop", heldObjectId },
      { id: "n", name: "N", x: 1, y: 0, prop: null, heldObjectId: null },
    ],
    objects: [laptopObj("laptop_near", 1, 0), laptopObj("laptop_far", 0, 0)],
  };
}

describe("A1: put-down verbs in the repetition core", () => {
  const world = actorsWorld();

  it("does not collide 'places the laptop on the desk' with 'stays at her desk'", () => {
    // The stage-1 F2 repro: both cored to "other|desk" and the repetition
    // screen rejected a semantically unrelated action as a repeat.
    const putDown = suggestionCore(world, "Tanya places the laptop on the desk", "tanya");
    const stay = suggestionCore(world, "Tanya stays at her desk and keeps working", "tanya");
    expect(putDown).toBe("putdown|laptop");
    expect(stay).toBe("other|desk");
    expect(putDown).not.toBe(stay);
  });

  it("distinguishes manipulated objects under the same location", () => {
    expect(suggestionCore(world, "Tanya places the laptop on the desk", "tanya")).toBe(
      "putdown|laptop",
    );
    expect(suggestionCore(world, "Tanya places the papers on the desk", "tanya")).toBe(
      "putdown|papers",
    );
  });

  it("prioritizes the held kind for take verbs too", () => {
    expect(suggestionCore(world, "Dana picks up the laptop at the desk", "dana")).toBe(
      "take|laptop",
    );
    expect(suggestionCore(world, "Dana grabs the mug at the desk", "dana")).toBe("take|mug");
  });

  it("keeps existing pins: actor destinations, chair push, adjust normalization", () => {
    expect(suggestionCore(world, "Walk toward Tanya's desk.", "anton")).toBe("move|tanya");
    expect(suggestionCore(world, "Push the chair in neatly.", "dana")).toBe("push|chair");
    expect(suggestionCore(world, "Dana shifts the dana_papers to the left", "dana")).toBe(
      "adjust|papers",
    );
    expect(suggestionCore(world, "Shake Anton's hand warmly.", "tanya")).toBe("shake|anton");
  });
});

describe("A2: third-person put-down phrasings plan", () => {
  it.each([
    "She puts the laptop down on the desk",
    "She puts the laptop down",
    "She sets the laptop down",
    "She lays the laptop down",
    "She puts the laptop aside",
    "She puts laptop aside",
    "She sets the laptop aside",
    "She sets aside the laptop",
    "Put the laptop down",
    "Set the laptop aside",
  ])("plans put-down for %j", (text) => {
    const plan = planManipulation(holdingWorld(null), "u", text);
    expect(plan?.kind).toBe("put-down");
  });

  it("the live turn-5 repro plans instead of silently dropping", () => {
    const plan = planManipulation(
      holdingWorld(null),
      "u",
      "gets up from chair, puts laptop aside, and walks over to greet him",
    );
    expect(plan?.kind).toBe("put-down");
  });

  it("the phantom-manipulation gate sees third-person put-downs too", () => {
    expect(detectNarrativeManipulation("She puts the laptop down.")).toContain("put-down");
    expect(detectNarrativeManipulation("She puts the laptop aside.")).toContain("put-down");
    expect(detectNarrativeManipulation("She sets the report aside.")).toContain("put-down");
  });
});

describe("A3: held scene-object identity", () => {
  it("hand-over keeps the linked object instead of re-linking by proximity", () => {
    // laptop_near is closer to u than the linked laptop_far — the old
    // proximity re-link would have swapped identity (stage-1 F4).
    const plan = planManipulation(holdingWorld("laptop_far"), "u", "Hand the laptop to N.", "n");
    expect(plan?.kind).toBe("hand-over");
    expect(plan?.objectId).toBe("laptop_far");
  });

  it("put-down keeps the linked object", () => {
    const plan = planManipulation(holdingWorld("laptop_far"), "u", "She puts the laptop down.");
    expect(plan?.kind).toBe("put-down");
    expect(plan?.objectId).toBe("laptop_far");
  });

  it("falls back to proximity when no object is linked (legacy saves)", () => {
    const plan = planManipulation(holdingWorld(null), "u", "Hand the laptop to N.", "n");
    expect(plan?.kind).toBe("hand-over");
    // Nearest same-kind object to u at (0,0): laptop_far at (0,0).
    expect(plan?.objectId).toBe("laptop_far");
  });

  it("executeManipulation links on pick-up, transfers on hand-over, clears on put-down", () => {
    const world = makeTinyWorld();
    const u = world.actors.find((a) => a.id === "u")!;
    const n = world.actors.find((a) => a.id === "n")!;
    world.scene.objects.push({
      id: "laptop_1", name: "Laptop", description: "A laptop.",
      x: 1, y: 1, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false,
    });

    const pickUp = executeManipulation(world, { actorId: "u", text: "Pick up the laptop." });
    expect(pickUp?.plan.kind).toBe("pick-up");
    expect(pickUp?.heldObjectIds).toEqual([{ actorId: "u", heldObjectId: "laptop_1" }]);

    // Simulate the applied pick-up, then hand over.
    u.prop = "laptop";
    u.heldObjectId = "laptop_1";
    n.x = 2; n.y = 1;
    const handOver = executeManipulation(world, { actorId: "u", text: "Hand the laptop to N." }, "n");
    expect(handOver?.plan.kind).toBe("hand-over");
    expect(handOver?.heldObjectIds).toEqual([
      { actorId: "u", heldObjectId: null },
      { actorId: "n", heldObjectId: "laptop_1" },
    ]);

    // Simulate the applied hand-over, then put down.
    u.prop = null; u.heldObjectId = null;
    n.prop = "laptop"; n.heldObjectId = "laptop_1";
    const putDown = executeManipulation(world, { actorId: "n", text: "N puts the laptop down." });
    expect(putDown?.plan.kind).toBe("put-down");
    expect(putDown?.heldObjectIds).toEqual([{ actorId: "n", heldObjectId: null }]);
  });

  it("applyRenderResult carries the held object with the holder on movement", () => {
    const world = makeTinyWorld();
    const u = world.actors.find((a) => a.id === "u")!;
    u.prop = "laptop";
    u.heldObjectId = "laptop_1";
    world.scene.objects.push({
      id: "laptop_1", name: "Laptop", description: "A laptop.",
      x: 1, y: 1, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false,
    });
    const next = applyRenderResult(
      world,
      { actorId: "u", text: "Walk to the door." },
      { narrative: "U walks to the door.", reasoning: "r" },
      {
        movement: { from: { x: 1, y: 1 }, x: 4, y: 4, path: [], destination: null },
        pose: null,
        manipulation: null,
      },
    );
    const obj = next.scene.objects.find((o) => o.id === "laptop_1")!;
    expect(obj.x).toBe(4);
    expect(obj.y).toBe(4);
  });

  it("applyRenderResult carries nothing when the actor holds no prop", () => {
    const world = makeTinyWorld();
    const u = world.actors.find((a) => a.id === "u")!;
    u.prop = null;
    u.heldObjectId = "laptop_1"; // stale link must not drag the object along
    world.scene.objects.push({
      id: "laptop_1", name: "Laptop", description: "A laptop.",
      x: 1, y: 1, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false,
    });
    const next = applyRenderResult(
      world,
      { actorId: "u", text: "Walk to the door." },
      { narrative: "U walks to the door.", reasoning: "r" },
      {
        movement: { from: { x: 1, y: 1 }, x: 4, y: 4, path: [], destination: null },
        pose: null,
        manipulation: null,
      },
    );
    const obj = next.scene.objects.find((o) => o.id === "laptop_1")!;
    expect(obj.x).toBe(1);
    expect(obj.y).toBe(1);
  });
});

describe("A4: narrated destination grounding", () => {
  function threeActorWorld(): World {
    const world = makeTinyWorld();
    const mkActor = (id: string, name: string, x: number, y: number): Actor => ({
      id, name, persona: "p", x, y, state: "s", emotion: "c", goal: "g",
      thoughts: "t", memories: [], beliefs: [], relationships: [],
    });
    world.actors.push(mkActor("dana", "Dana", 0, 0));
    world.actors.push(mkActor("tanya", "Tanya", 5, 5));
    return world;
  }
  const action = { actorId: "u", text: "Walk toward Tanya." };

  it("rejects a narrated destination contradicting the engine destination", () => {
    // The stage-1 turn-1 repro: engine moved toward Tanya, the 3B
    // narrated "walks toward Dana".
    const errors = validateNarrativeDestinationGrounding(
      threeActorWorld(), action, "U walks toward Dana.", "tanya",
    );
    expect(errors).toHaveLength(1);
    expect(errorText(errors)).toMatch(/movement\.destination_mismatch/);
    expect(errorText(errors)).toMatch(/Dana/);
  });

  it("accepts the matching destination, including possessive landmarks", () => {
    const world = threeActorWorld();
    expect(
      validateNarrativeDestinationGrounding(world, action, "U walks toward Tanya.", "tanya"),
    ).toEqual([]);
    expect(
      validateNarrativeDestinationGrounding(world, action, "U walks toward Tanya's desk.", "tanya"),
    ).toEqual([]);
  });

  it("ignores non-destination mentions of other actors", () => {
    const world = threeActorWorld();
    expect(
      validateNarrativeDestinationGrounding(
        world, action, "U walks toward Tanya, waving at Dana.", "tanya",
      ),
    ).toEqual([]);
  });

  it("ignores quoted dialogue (the character talking, not the narrator)", () => {
    const world = threeActorWorld();
    expect(
      validateNarrativeDestinationGrounding(
        world, action, 'U says "I will walk toward Dana tomorrow." U walks toward Tanya.', "tanya",
      ),
    ).toEqual([]);
  });

  it("is inert without an engine actor destination", () => {
    const world = threeActorWorld();
    expect(
      validateNarrativeDestinationGrounding(world, action, "U walks toward Dana.", null),
    ).toEqual([]);
    expect(
      validateNarrativeDestinationGrounding(world, action, "U walks across the room.", "tanya"),
    ).toEqual([]);
  });
});

describe("A4: repetition cores derive from the action text", () => {
  it("a mis-rendered narrative does not poison the repetition core", () => {
    // Stage-1 turn-1/turn-4 shape: the narrative mis-rendered the
    // destination ("walks toward Dana" for an engine move toward Tanya),
    // which used to core the history entry as "move|dana" and let a
    // verbatim repeat of the Tanya approach slip through.
    const world = actorsWorld();
    world.history.push({
      text: "Anton: Anton walks toward Dana. Anton says hello.",
      perceivers: ["anton", "tanya", "dana"],
      actionText: "I approach Tanya, trying to make a good impression.",
    });
    expect(getRecentOwnActions(world, "anton")).toEqual([
      "I approach Tanya, trying to make a good impression.",
    ]);
    // A verbatim repeat of the ACTION is now caught…
    expect(
      findCoreRepeat(world, "anton", "I approach Tanya and say hello again."),
    ).toBeDefined();
    // …while coring from the mis-rendered narrative alone would miss it.
    expect(
      findCoreRepeat(world, "anton", "Anton: Anton walks toward Dana. Anton says hello."),
    ).toBeUndefined();
  });

  it("falls back to narrative text for legacy entries without actionText", () => {
    const world = makeTinyWorld();
    world.history.push(hist(world, "U: U waves at N."));
    expect(getRecentOwnActions(world, "u")).toEqual(["U: U waves at N."]);
  });
});
