// Exhaustive unit tests for the pure manipulation core (src/core/objects.ts).
//
// Phase 3 mandate: the core is 100% unit-tested pure functions. Every
// branch of planManipulation's guards is enumerated by hand below:
// pick-up success/failure, put-down onto surface vs ground, hand-over to
// adjacent vs distant actor, already-held, not-pickable, missing target,
// null semantics, the single-manipulation contract, and the invariant
// assertions.
import { describe, expect, it } from "vitest";
import {
  HAND_OVER_REACH,
  MANIPULATION_REACH,
  affordanceForObject,
  assertManipulationInvariants,
  describeManipulation,
  detectNarrativeManipulation,
  distanceToObjectCenter,
  kindWordProp,
  mentionsObject,
  nearBrewSource,
  nearestKindObject,
  planManipulation,
  resolveContactMention,
  type CoreActor,
  type CoreObject,
  type ManipulationPlan,
  type ManipulationSnapshot,
} from "../../../src/core/objects.js";

// ---------------------------------------------------------------------------
// Snapshot builders (hand-enumerated, independent of the engine wrapper).
// ---------------------------------------------------------------------------

function actor(over: Partial<CoreActor> = {}): CoreActor {
  return { id: "u", name: "U", x: 0, y: 0, prop: null, heldObjectId: null, ...over };
}

function obj(over: Partial<CoreObject> & { id: string; name: string }): CoreObject {
  return {
    x: 0, y: 0, w: 1, h: 1,
    affordance: affordanceForObject({ id: over.id, name: over.name }),
    ...over,
  };
}

function snap(actors: CoreActor[], objects: CoreObject[]): ManipulationSnapshot {
  return { actors, objects };
}

/** Snapshot with one actor at the origin and the given objects. */
function oneActor(objects: CoreObject[] = [], a: Partial<CoreActor> = {}): ManipulationSnapshot {
  return snap([actor(a)], objects);
}

// ---------------------------------------------------------------------------
// affordanceForObject — the canonical kind table.
// ---------------------------------------------------------------------------

describe("affordanceForObject", () => {
  it("resolves holdable kinds with canonical prop names", () => {
    const cases: Array<[string, string, string]> = [
      ["dana_laptop", "Dana's laptop", "laptop"],
      ["coffee_mug", "Coffee mug", "cup"],
      ["tea_cup", "Tea cup", "cup"],
      ["stack_of_papers", "Stack of papers", "papers"],
      ["q3_documents", "Q3 documents", "papers"],
      ["final_report", "Final report", "report"],
      ["my_phone", "My phone", "phone"],
      ["old_book", "Old book", "book"],
      ["spiral_notebook", "Spiral notebook", "book"],
      ["water_bottle", "Water bottle", "bottle"],
      ["gym_bag", "Gym bag", "bag"],
    ];
    for (const [id, name, prop] of cases) {
      const aff = affordanceForObject({ id, name });
      expect(aff.pickable, id).toBe(true);
      expect(aff.propName, id).toBe(prop);
      expect(aff.surface, id).toBe(false);
      expect(aff.brewSource, id).toBe(false);
    }
  });

  it("resolves surfaces, containers, and brew sources", () => {
    expect(affordanceForObject({ id: "anton_desk", name: "Anton's desk" })).toMatchObject({
      pickable: false, propName: null, surface: true, container: false, brewSource: false,
    });
    expect(affordanceForObject({ id: "meeting_table", name: "Meeting table" })).toMatchObject({
      surface: true, pickable: false,
    });
    expect(affordanceForObject({ id: "gym_bag", name: "Gym bag" })).toMatchObject({
      pickable: true, propName: "bag", container: true,
    });
    expect(affordanceForObject({ id: "top_drawer", name: "Top drawer" })).toMatchObject({
      pickable: false, container: true,
    });
    expect(affordanceForObject({ id: "storage_box", name: "Storage box" })).toMatchObject({
      pickable: false, container: true,
    });
    expect(affordanceForObject({ id: "filing_cabinet", name: "Filing cabinet" })).toMatchObject({
      pickable: false, container: true,
    });
    expect(affordanceForObject({ id: "coffee_machine", name: "Coffee machine" })).toMatchObject({
      pickable: false, brewSource: true,
    });
    expect(affordanceForObject({ id: "kettle_1", name: "Kettle" })).toMatchObject({
      brewSource: true, pickable: false,
    });
  });

  it("defaults unknown kinds to non-holdable", () => {
    for (const [id, name] of [["spare_chair", "Spare chair"], ["ficus", "Ficus plant"], ["rug_1", "Rug"]]) {
      expect(affordanceForObject({ id, name })).toEqual({
        pickable: false, propName: null, surface: false, container: false, brewSource: false,
      });
    }
  });

  it("first match wins on `${id} ${name}`", () => {
    // "coffee mug" contains "coffee" but the mug row comes first.
    expect(affordanceForObject({ id: "coffee_mug", name: "Coffee mug" }).propName).toBe("cup");
  });
});

// ---------------------------------------------------------------------------
// Text helpers.
// ---------------------------------------------------------------------------

describe("kindWordProp", () => {
  it("maps holdable kind words to canonical props", () => {
    expect(kindWordProp("Pick up the mug")).toBe("cup");
    expect(kindWordProp("grab a cup")).toBe("cup");
    expect(kindWordProp("open the laptop")).toBe("laptop");
    expect(kindWordProp("take the papers")).toBe("papers");
    expect(kindWordProp("hand over the report")).toBe("report");
    expect(kindWordProp("answer the phone")).toBe("phone");
    expect(kindWordProp("read the book")).toBe("book");
    expect(kindWordProp("grab the bottle")).toBe("bottle");
    expect(kindWordProp("take the bag")).toBe("bag");
    expect(kindWordProp("pour the coffee")).toBe("cup");
    expect(kindWordProp("sip the tea")).toBe("cup");
  });

  it("returns null for non-kind text", () => {
    expect(kindWordProp("Walk to the door")).toBeNull();
    expect(kindWordProp("Open the door")).toBeNull();
    expect(kindWordProp("Shake hands")).toBeNull();
  });
});

describe("mentionsObject", () => {
  const o = { id: "anton_mug", name: "Anton's mug" };
  it("matches id, spaced id, and name with word boundaries", () => {
    expect(mentionsObject("Pick up anton_mug", o)).toBe(true);
    expect(mentionsObject("Pick up the anton mug", o)).toBe(true);
    expect(mentionsObject("Pick up Anton's mug", o)).toBe(true);
  });

  it("rejects bare kind words and partial matches", () => {
    expect(mentionsObject("Pick up the mug", o)).toBe(false);
    expect(mentionsObject("Pick up anton_mugg", o)).toBe(false);
  });
});

describe("resolveContactMention", () => {
  const actors = [actor({ id: "u", name: "U" }), actor({ id: "n", name: "Nadia" }), actor({ id: "j", name: "Jeff" })];
  it("resolves the recipient of a transfer verb", () => {
    expect(resolveContactMention(actors, "u", "Hand the report to Nadia")).toBe("n");
    expect(resolveContactMention(actors, "u", "Give Jeff the papers")).toBe("j");
    expect(resolveContactMention(actors, "u", "Pass the bottle to Nadia, please")).toBe("n");
  });

  it("excludes shake-hands and self mentions", () => {
    expect(resolveContactMention(actors, "u", "Shake Nadia's hand warmly")).toBeNull();
    expect(resolveContactMention(actors, "u", "Anton shook her hand.")).toBeNull();
    expect(resolveContactMention(actors, "u", "They shake hands.")).toBeNull();
    expect(resolveContactMention(actors, "u", "Hand it to U")).toBeNull();
    // A longer "shake ..." phrase is not the idiom — the later transfer
    // verb still counts.
    expect(resolveContactMention(actors, "u", "Shake the bottle and hand it to Nadia")).toBe("n");
  });

  it("returns null with no hand-over verb or no named actor", () => {
    expect(resolveContactMention(actors, "u", "Walk to Nadia")).toBeNull();
    expect(resolveContactMention(actors, "u", "Hand it over")).toBeNull();
    expect(resolveContactMention(actors, "u", "Hand the report to a stranger")).toBeNull();
  });
});

describe("distanceToObjectCenter", () => {
  it("measures actor point to object center", () => {
    expect(distanceToObjectCenter({ x: 0, y: 0 }, { x: 1, y: 1, w: 2, h: 2 })).toBeCloseTo(Math.hypot(2, 2));
    expect(distanceToObjectCenter({ x: 3, y: 4 }, { x: 3, y: 4, w: 0, h: 0 })).toBe(0);
  });
});

describe("nearestKindObject", () => {
  it("returns the nearest in-reach object of the kind", () => {
    const s = oneActor([
      obj({ id: "mug_far", name: "Far mug", x: 3, y: 0 }),
      obj({ id: "mug_near", name: "Near mug", x: 1, y: 0 }),
    ]);
    expect(nearestKindObject(s, s.actors[0]!, "cup")!.id).toBe("mug_near");
  });

  it("breaks ties by object id", () => {
    const s = oneActor([
      obj({ id: "mug_b", name: "B mug", x: 1, y: 0 }),
      obj({ id: "mug_a", name: "A mug", x: -1, y: 0 }),
    ]);
    expect(nearestKindObject(s, s.actors[0]!, "cup")!.id).toBe("mug_a");
  });

  it("returns null when nothing of the kind is in reach", () => {
    const s = oneActor([obj({ id: "mug_far", name: "Far mug", x: MANIPULATION_REACH + 1, y: 0 })]);
    expect(nearestKindObject(s, s.actors[0]!, "cup")).toBeNull();
    expect(nearestKindObject(oneActor([]), oneActor([]).actors[0]!, "cup")).toBeNull();
    // A desk is not a cup even when adjacent.
    const s2 = oneActor([obj({ id: "desk_1", name: "Desk", x: 0, y: 0 })]);
    expect(nearestKindObject(s2, s2.actors[0]!, "cup")).toBeNull();
  });
});

describe("nearBrewSource", () => {
  it("detects brew sources within reach", () => {
    const s = oneActor([obj({ id: "coffee_machine", name: "Coffee machine", x: 2, y: 0 })]);
    expect(nearBrewSource(s, s.actors[0]!)).toBe(true);
    const far = oneActor([obj({ id: "coffee_machine", name: "Coffee machine", x: 9, y: 0 })]);
    expect(nearBrewSource(far, far.actors[0]!)).toBe(false);
    expect(nearBrewSource(oneActor([]), oneActor([]).actors[0]!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planManipulation — pick-up.
// ---------------------------------------------------------------------------

describe("planManipulation pick-up", () => {
  it("plans an explicit pick-up of a mentioned object in reach", () => {
    const s = oneActor([obj({ id: "dana_laptop", name: "Dana's laptop", x: 1, y: 0 })]);
    const plan = planManipulation(s, "u", "Pick up the laptop.");
    expect(plan).toMatchObject({ kind: "pick-up", actorId: "u", objectId: "dana_laptop", propName: "laptop" });
    expect(plan!.rule).toContain("pick-up:verb+mention(dana_laptop)");
  });

  it("plans grab/take/hold/carry + kind word", () => {
    const s = oneActor([
      obj({ id: "mug_1", name: "Mug", x: 1, y: 0 }),
      obj({ id: "report_1", name: "Q3 report", x: 1, y: 0 }),
      obj({ id: "bag_1", name: "Gym bag", x: 1, y: 0 }),
    ]);
    expect(planManipulation(s, "u", "Grab the mug.")!.propName).toBe("cup");
    expect(planManipulation(s, "u", "Take the report.")!.propName).toBe("report");
    expect(planManipulation(s, "u", "Hold the cup.")!.propName).toBe("cup");
    expect(planManipulation(s, "u", "Carry the bag.")!.propName).toBe("bag");
  });

  it("plans use verbs: sip→cup, type→laptop, pour→cup by the brew source, open+kind", () => {
    const s = oneActor([
      obj({ id: "mug_1", name: "Mug", x: 1, y: 0 }),
      obj({ id: "laptop_1", name: "Laptop", x: 1, y: 0 }),
      obj({ id: "coffee_machine", name: "Coffee machine", x: 2, y: 0 }),
    ]);
    expect(planManipulation(s, "u", "Take a sip of coffee.")!.propName).toBe("cup");
    expect(planManipulation(s, "u", "Type on the laptop.")!.propName).toBe("laptop");
    expect(planManipulation(s, "u", "Pour a coffee.")!.propName).toBe("cup");
    expect(planManipulation(s, "u", "Open the laptop to work.")!.propName).toBe("laptop");
  });

  it("rejects pour far from any brew source (no thin-air coffee)", () => {
    const s = oneActor([obj({ id: "mug_1", name: "Mug", x: 1, y: 0 })]);
    expect(planManipulation(s, "u", "Pour a coffee.")).toBeNull();
  });

  it("rejects open without a holdable kind word", () => {
    const s = oneActor([obj({ id: "laptop_1", name: "Laptop", x: 1, y: 0 })]);
    expect(planManipulation(s, "u", "Open the door.")).toBeNull();
  });

  it("treats 'carry on' as resumption, not carrying", () => {
    const s = oneActor([obj({ id: "report_1", name: "Q3 report", x: 1, y: 0 })]);
    expect(planManipulation(s, "u", "Carry on with the report.")).toBeNull();
  });

  it("rejects take/hold verbs with no holdable kind word", () => {
    const s = oneActor([obj({ id: "mug_1", name: "Mug", x: 1, y: 0 })]);
    expect(planManipulation(s, "u", "Take a nap.")).toBeNull();
    expect(planManipulation(s, "u", "Hold on a second.")).toBeNull();
  });

  it("rejects pick-up when the actor already holds something", () => {
    const s = oneActor([obj({ id: "mug_1", name: "Mug", x: 1, y: 0 })], { prop: "phone" });
    expect(planManipulation(s, "u", "Pick up the mug.")).toBeNull();
  });

  it("rejects pick-up when the object is out of reach", () => {
    const s = oneActor([obj({ id: "mug_1", name: "Mug", x: MANIPULATION_REACH + 1, y: 0 })]);
    expect(planManipulation(s, "u", "Pick up the mug.")).toBeNull();
  });

  it("rejects pick-up of a non-pickable object", () => {
    const s = oneActor([obj({ id: "desk_1", name: "Desk", x: 1, y: 0 })]);
    expect(planManipulation(s, "u", "Pick up the desk.")).toBeNull();
  });

  it("rejects pick-up with no matching object at all (never invents props)", () => {
    const s = oneActor([]);
    expect(planManipulation(s, "u", "Take a sip of coffee.")).toBeNull();
    expect(planManipulation(s, "u", "Pick up the laptop.")).toBeNull();
  });

  it("prefers the explicitly mentioned object over a nearer same-kind one", () => {
    const s = oneActor([
      obj({ id: "mug_near", name: "Near mug", x: 1, y: 0 }),
      obj({ id: "jeff_mug", name: "Jeff's mug", x: 2, y: 0 }),
    ]);
    const plan = planManipulation(s, "u", "Grab jeff's mug.");
    expect(plan!.objectId).toBe("jeff_mug");
  });

  it("breaks mentioned-object distance ties by id", () => {
    const s = oneActor([
      obj({ id: "mug_b", name: "Mug", x: 1, y: 0 }),
      obj({ id: "mug_a", name: "Mug", x: -1, y: 0 }),
    ]);
    const plan = planManipulation(s, "u", "Grab the mug.");
    expect(plan!.objectId).toBe("mug_a");
  });

  it("returns null for an unknown actor", () => {
    const s = oneActor([]);
    expect(planManipulation(s, "ghost", "Pick up the mug.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// planManipulation — put-down.
// ---------------------------------------------------------------------------

describe("planManipulation put-down", () => {
  it("plans a put-down with a named in-reach surface", () => {
    const s = oneActor(
      [obj({ id: "laptop_1", name: "Laptop", x: 0, y: 0 }), obj({ id: "desk_1", name: "Desk", x: 1, y: 0 })],
      { prop: "laptop" },
    );
    const plan = planManipulation(s, "u", "Set the laptop down on the desk.");
    expect(plan).toMatchObject({
      kind: "put-down", actorId: "u", objectId: "laptop_1", propName: "laptop", surfaceId: "desk_1",
    });
    expect(plan!.rule).toContain("put-down:held(laptop)+surface(desk_1)");
  });

  it("plans a put-down with no surface (at the actor's feet)", () => {
    const s = oneActor([obj({ id: "mug_1", name: "Mug", x: 0, y: 0 })], { prop: "cup" });
    const plan = planManipulation(s, "u", "Set down the mug.");
    expect(plan).toMatchObject({ kind: "put-down", propName: "cup" });
    expect(plan!.surfaceId).toBeUndefined();
    expect(plan!.rule).toBe("put-down:held(cup)");
  });

  it("ignores a surface that is mentioned but out of reach", () => {
    const s = oneActor(
      [obj({ id: "mug_1", name: "Mug", x: 0, y: 0 }), obj({ id: "desk_1", name: "Desk", x: 9, y: 0 })],
      { prop: "cup" },
    );
    const plan = planManipulation(s, "u", "Place the mug on the desk.");
    expect(plan!.surfaceId).toBeUndefined();
  });

  it("rejects put-down with empty hands", () => {
    const s = oneActor([obj({ id: "desk_1", name: "Desk", x: 1, y: 0 })]);
    expect(planManipulation(s, "u", "Set down the mug.")).toBeNull();
  });

  it("put-down still works when the held prop has no scene object nearby", () => {
    const s = oneActor([], { prop: "phone" });
    const plan = planManipulation(s, "u", "Set down the phone.");
    expect(plan).toMatchObject({ kind: "put-down", objectId: null, propName: "phone" });
  });
});

// ---------------------------------------------------------------------------
// planManipulation — hand-over.
// ---------------------------------------------------------------------------

describe("planManipulation hand-over", () => {
  function twoActors(overU: Partial<CoreActor> = {}, overN: Partial<CoreActor> = {}): ManipulationSnapshot {
    return snap(
      [actor({ id: "u", name: "U", ...overU }), actor({ id: "n", name: "Nadia", x: 1, y: 0, ...overN })],
      [obj({ id: "report_1", name: "Q3 report", x: 0, y: 0 })],
    );
  }

  it("plans a hand-over to a mentioned adjacent actor", () => {
    const plan = planManipulation(twoActors({ prop: "report" }), "u", "Hand the report to Nadia.");
    expect(plan).toMatchObject({
      kind: "hand-over", actorId: "u", objectId: "report_1", propName: "report", targetActorId: "n",
    });
    expect(plan!.rule).toBe("hand-over:held(report)->n");
  });

  it("uses the contactActorId when the text names no recipient", () => {
    const plan = planManipulation(twoActors({ prop: "report" }), "u", "Give it to her.", "n");
    expect(plan!.targetActorId).toBe("n");
  });

  it("rejects hand-over to a distant recipient", () => {
    const s = twoActors({ prop: "report" }, { x: HAND_OVER_REACH + 1, y: 0 });
    expect(planManipulation(s, "u", "Hand the report to Nadia.")).toBeNull();
  });

  it("rejects hand-over when the actor holds nothing", () => {
    expect(planManipulation(twoActors(), "u", "Hand the report to Nadia.")).toBeNull();
  });

  it("rejects hand-over when the recipient's hands are full", () => {
    const s = twoActors({ prop: "report" }, { prop: "phone" });
    expect(planManipulation(s, "u", "Hand the report to Nadia.")).toBeNull();
  });

  it("rejects hand-over with no recipient", () => {
    const s = twoActors({ prop: "report" });
    expect(planManipulation(s, "u", "Hand it over.")).toBeNull();
  });

  it("rejects hand-over to self", () => {
    const s = twoActors({ prop: "report" });
    expect(planManipulation(s, "u", "Hand it over.", "u")).toBeNull();
  });

  it("rejects hand-over to an unknown recipient", () => {
    const s = twoActors({ prop: "report" });
    expect(planManipulation(s, "u", "Give it to her.", "ghost")).toBeNull();
  });

  it("never treats 'shake hands' as a transfer", () => {
    const s = twoActors({ prop: "report" });
    expect(planManipulation(s, "u", "Shake Nadia's hand warmly.")).toBeNull();
    expect(planManipulation(s, "u", "Anton shook Nadia's hand.")).toBeNull();
  });

  it("Stage-2 B1: body-part hand nouns never plan a hand-over", () => {
    const s = twoActors({ prop: "report" });
    expect(planManipulation(s, "u", "Raise a hand in a friendly wave to Nadia.")).toBeNull();
    expect(planManipulation(s, "u", "Take Nadia's hand and smile.")).toBeNull();
    // Transfer frames still plan.
    const plan = planManipulation(s, "u", "Hand the report to Nadia.");
    expect(plan).toMatchObject({ kind: "hand-over", targetActorId: "n" });
  });

  it("hand-over works when the held prop has no scene object nearby", () => {
    const s = snap(
      [actor({ id: "u", name: "U", prop: "phone" }), actor({ id: "n", name: "Nadia", x: 1, y: 0 })],
      [],
    );
    const plan = planManipulation(s, "u", "Hand the phone to Nadia.");
    expect(plan).toMatchObject({ kind: "hand-over", objectId: null, targetActorId: "n" });
  });
});

// ---------------------------------------------------------------------------
// planManipulation — single-manipulation contract and null semantics.
// ---------------------------------------------------------------------------

describe("planManipulation contract", () => {
  function rich(): ManipulationSnapshot {
    return snap(
      [
        actor({ id: "u", name: "U" }),
        actor({ id: "n", name: "Nadia", x: 1, y: 0 }),
      ],
      [
        obj({ id: "mug_1", name: "Mug", x: 1, y: 0 }),
        obj({ id: "laptop_1", name: "Laptop", x: 1, y: 0 }),
        obj({ id: "desk_1", name: "Desk", x: 1, y: 0 }),
      ],
    );
  }

  it("returns null when the text implies two manipulations (split across turns)", () => {
    const s = snap(
      [actor({ id: "u", name: "U", prop: "cup" }), actor({ id: "n", name: "Nadia", x: 1, y: 0 })],
      [obj({ id: "mug_1", name: "Mug", x: 1, y: 0 }), obj({ id: "laptop_1", name: "Laptop", x: 1, y: 0 })],
    );
    expect(planManipulation(s, "u", "Pick up the laptop and hand the mug to Nadia.")).toBeNull();
    expect(planManipulation(s, "u", "Pick up the laptop and set it down on the desk.")).toBeNull();
    expect(planManipulation(rich(), "u", "Set down the mug and pick up the laptop.")).toBeNull();
  });

  it("returns null for non-manipulation actions", () => {
    const s = rich();
    expect(planManipulation(s, "u", "Walk to the door.")).toBeNull();
    expect(planManipulation(s, "u", "Ask Nadia about the deploy.")).toBeNull();
    expect(planManipulation(s, "u", "Sit down.")).toBeNull();
    expect(planManipulation(s, "u", "")).toBeNull();
  });

  it("does not mutate the snapshot", () => {
    const s = oneActor([obj({ id: "mug_1", name: "Mug", x: 1, y: 0 })]);
    const before = JSON.stringify(s);
    planManipulation(s, "u", "Pick up the mug.");
    expect(JSON.stringify(s)).toBe(before);
  });

  it("is deterministic across calls", () => {
    const s = rich();
    const a = planManipulation(s, "u", "Grab the mug.");
    const b = planManipulation(s, "u", "Grab the mug.");
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// describeManipulation.
// ---------------------------------------------------------------------------

describe("describeManipulation", () => {
  it("describes pick-up, put-down, and hand-over as fact lines", () => {
    const pick: ManipulationPlan = {
      kind: "pick-up", actorId: "u", objectId: "mug_1", propName: "cup", rule: "r",
    };
    expect(describeManipulation(pick, "Dana")).toContain("Dana picked up the cup (mug_1)");
    expect(describeManipulation(pick, "Dana")).toContain("Dana now holds the cup.");
    // No scene object (held prop with no nearby match): no id suffix.
    const pickBare: ManipulationPlan = { ...pick, objectId: null };
    expect(describeManipulation(pickBare, "Dana")).toBe(
      "Dana picked up the cup — Dana now holds the cup.",
    );
    const drop: ManipulationPlan = {
      kind: "put-down", actorId: "u", objectId: "mug_1", propName: "cup", rule: "r",
    };
    expect(describeManipulation(drop, "Dana")).toContain("Dana set down the cup");
    expect(describeManipulation(drop, "Dana")).toContain("Dana now holds nothing.");
    const dropSurface: ManipulationPlan = { ...drop, surfaceId: "desk_1" };
    expect(describeManipulation(dropSurface, "Dana")).toContain("on desk_1");
    const give: ManipulationPlan = {
      kind: "hand-over", actorId: "u", objectId: "report_1", propName: "report",
      targetActorId: "n", rule: "r",
    };
    expect(describeManipulation(give, "Anton", "Tanya")).toContain(
      "Anton handed the report to Tanya",
    );
    expect(describeManipulation(give, "Anton", "Tanya")).toContain(
      "Tanya now holds the report, Anton holds nothing.",
    );
    // Falls back to the raw actor id when no display name is given.
    expect(describeManipulation(give, "Anton")).toContain("to n —");
  });
});

// ---------------------------------------------------------------------------
// detectNarrativeManipulation — the phantom-manipulation gate's verb set.
// ---------------------------------------------------------------------------

describe("detectNarrativeManipulation", () => {
  it("detects transfer events", () => {
    expect(detectNarrativeManipulation("Dana picks up the mug.")).toEqual(["pick-up"]);
    expect(detectNarrativeManipulation("He grabbed the report.")).toEqual(["pick-up"]);
    expect(detectNarrativeManipulation("She sets down the bag.")).toEqual(["put-down"]);
    expect(detectNarrativeManipulation("Anton hands the report to Tanya.")).toEqual(["hand-over"]);
    expect(detectNarrativeManipulation("He gave her the phone.")).toEqual(["hand-over"]);
  });

  it("ignores stative holds, use verbs, and handshakes", () => {
    expect(detectNarrativeManipulation("Dana holds the cup.")).toEqual([]);
    expect(detectNarrativeManipulation("He carries the bag across the room.")).toEqual([]);
    expect(detectNarrativeManipulation("She sips her coffee.")).toEqual([]);
    expect(detectNarrativeManipulation("He types on the laptop.")).toEqual([]);
    expect(detectNarrativeManipulation("Anton shakes Tanya's hand.")).toEqual([]);
    expect(detectNarrativeManipulation("Anton shook Tanya's hand.")).toEqual([]);
    expect(detectNarrativeManipulation("Nothing much happens.")).toEqual([]);
  });

  it("Stage-2 B1: body-part hand nouns are not transfers", () => {
    // False positives from the Stage-2 live run (tick 3): the bare noun
    // "hand"/"hands" is a body part, not a transfer event.
    expect(detectNarrativeManipulation("Anton raises a hand in a friendly wave.")).toEqual([]);
    expect(detectNarrativeManipulation("She takes her hand and smiles.")).toEqual([]);
    expect(detectNarrativeManipulation("Anton stands beside the desk, hands empty.")).toEqual([]);
    expect(detectNarrativeManipulation("He waves a hand at Tanya.")).toEqual([]);
    expect(detectNarrativeManipulation("She returns to the task at hand.")).toEqual([]);
    expect(detectNarrativeManipulation("He lends a hand to the new intern.")).toEqual([]);
  });

  it("Stage-2 B1: hand-over still detected inside transfer frames", () => {
    expect(detectNarrativeManipulation("Anton hands the report to Tanya.")).toEqual(["hand-over"]);
    expect(detectNarrativeManipulation("She picks up the mug and hands it to Tanya.")).toEqual([
      "pick-up",
      "hand-over",
    ]);
    expect(detectNarrativeManipulation("He handed the report over.")).toEqual(["hand-over"]);
    expect(detectNarrativeManipulation("Anton hands Nadia's report to Tanya.")).toEqual(["hand-over"]);
    expect(detectNarrativeManipulation("He gave her the phone.")).toEqual(["hand-over"]);
  });

  it("collects multiple transfer events in one narrative", () => {
    expect(
      detectNarrativeManipulation("She picks up the mug and hands it to Tanya."),
    ).toEqual(["pick-up", "hand-over"]);
  });
});

// ---------------------------------------------------------------------------
// assertManipulationInvariants.
// ---------------------------------------------------------------------------

describe("assertManipulationInvariants", () => {
  function base(): ManipulationSnapshot {
    return snap(
      [actor({ id: "u", name: "U" }), actor({ id: "n", name: "Nadia", x: 1, y: 0 })],
      [obj({ id: "mug_1", name: "Mug", x: 1, y: 0 }), obj({ id: "desk_1", name: "Desk", x: 1, y: 0 })],
    );
  }

  it("accepts a sound pick-up plan", () => {
    const s = base();
    const plan = planManipulation(s, "u", "Pick up the mug.")!;
    expect(assertManipulationInvariants(s, plan)).toEqual([]);
  });

  it("accepts sound put-down and hand-over plans", () => {
    const s = snap(
      [actor({ id: "u", name: "U", prop: "cup" }), actor({ id: "n", name: "Nadia", x: 1, y: 0 })],
      [obj({ id: "mug_1", name: "Mug", x: 1, y: 0 })],
    );
    expect(
      assertManipulationInvariants(s, planManipulation(s, "u", "Set down the mug.")!),
    ).toEqual([]);
    expect(
      assertManipulationInvariants(s, planManipulation(s, "u", "Hand the mug to Nadia.")!),
    ).toEqual([]);
  });

  it("flags unknown actors and objects", () => {
    const s = base();
    const plan = planManipulation(s, "u", "Pick up the mug.")!;
    expect(assertManipulationInvariants(s, { ...plan, actorId: "ghost" })).toEqual([
      "unknown actor ghost",
    ]);
    expect(assertManipulationInvariants(s, { ...plan, objectId: "ghost_mug" })).toEqual([
      "unknown object ghost_mug",
    ]);
  });

  it("flags pick-up of a non-pickable object and of an already-held prop", () => {
    const s = snap([actor({ id: "u", name: "U", prop: "phone" })], [
      obj({ id: "mug_1", name: "Mug", x: 1, y: 0 }),
      obj({ id: "desk_1", name: "Desk", x: 1, y: 0 }),
    ]);
    const plan = planManipulation(base(), "u", "Pick up the mug.")!;
    expect(assertManipulationInvariants(s, plan)).toEqual(["actor u already holds phone"]);
    expect(
      assertManipulationInvariants(base(), { ...plan, objectId: "desk_1" }),
    ).toEqual(["object desk_1 is not pickable"]);
  });

  it("flags a put-down/hand-over plan that moves the wrong prop", () => {
    const s = snap([actor({ id: "u", name: "U", prop: "phone" })], []);
    const plan: ManipulationPlan = {
      kind: "put-down", actorId: "u", objectId: null, propName: "cup", rule: "r",
    };
    expect(assertManipulationInvariants(s, plan)).toEqual([
      "actor u holds phone, plan moves cup",
    ]);
  });

  it("flags hand-over with no/unknown/far/occupied recipient", () => {
    const s = snap([actor({ id: "u", name: "U", prop: "cup" })], []);
    const plan: ManipulationPlan = {
      kind: "hand-over", actorId: "u", objectId: null, propName: "cup", rule: "r",
    };
    expect(assertManipulationInvariants(s, plan)).toEqual(["hand-over has no recipient"]);
    expect(assertManipulationInvariants(s, { ...plan, targetActorId: "ghost" })).toEqual([
      "unknown recipient ghost",
    ]);
    const far = snap(
      [actor({ id: "u", name: "U", prop: "cup" }), actor({ id: "n", name: "Nadia", x: 9, y: 0 })],
      [],
    );
    expect(
      assertManipulationInvariants(far, { ...plan, propName: "cup", targetActorId: "n" }),
    ).toEqual(["recipient n out of hand-over reach"]);
    const busy = snap(
      [actor({ id: "u", name: "U", prop: "cup" }), actor({ id: "n", name: "Nadia", x: 1, y: 0, prop: "phone" })],
      [],
    );
    expect(
      assertManipulationInvariants(busy, { ...plan, propName: "cup", targetActorId: "n" }),
    ).toEqual(["recipient n already holds phone"]);
  });
});
