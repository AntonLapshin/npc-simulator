// Exhaustive unit tests for the pure decision core (src/core/decision.ts).
// Phase 5 mandate: every core module gets a unit test file aiming at 100%
// line + branch coverage (no coverage tool installed — branches are
// enumerated deliberately below).
import { describe, expect, it } from "vitest";
import type { World } from "../../../src/types.js";
import type { Intent } from "../../../src/decision/decisionTypes.js";
import {
  attachTarget,
  buildTargetQuestion,
  describeIntent,
  INTERACT_CANDIDATE_RADIUS,
  landmarkNames,
  MAX_TARGET_OPTIONS,
  nearbyObjectNames,
  rankOptionsByProbability,
  renderIntentCandidates,
  resolveTargetId,
  rosterNames,
} from "../../../src/core/decision.js";
import { makeTinyWorld } from "../../helpers.js";

/** 6x6 empty room, u=U at (1,1), n=N at (4,4). */
function tiny(): World {
  return makeTinyWorld();
}

/** Tiny world + a desk (furniture, not pickable) near u and a mug near n. */
function furnished(): World {
  const w = tiny();
  w.scene.objects.push(
    {
      id: "desk1", name: "desk", description: "a desk",
      x: 2, y: 1, w: 2, h: 1, passable: false,
      blocksVision: false, blocksSound: false,
    },
    {
      id: "mug1", name: "mug", description: "a mug",
      x: 4, y: 3, w: 1, h: 1, passable: true,
      blocksVision: false, blocksSound: false,
    },
  );
  return w;
}

function intent(partial: Partial<Intent> & { kind: Intent["kind"] }): Intent {
  return { ...partial };
}

describe("rosterNames", () => {
  it("lists everyone but the acting actor", () => {
    expect(rosterNames(tiny(), "u")).toEqual(["N"]);
    expect(rosterNames(tiny(), "n")).toEqual(["U"]);
  });
  it("skips blank names", () => {
    const w = tiny();
    w.actors.push({
      id: "x", name: "  ", persona: "p", x: 0, y: 0,
      state: "s", emotion: "e", goal: "g", thoughts: "",
      memories: [], beliefs: [], relationships: [],
    });
    expect(rosterNames(w, "u")).toEqual(["N"]);
  });
  it("is empty when the actor is alone", () => {
    const w = tiny();
    w.actors = w.actors.filter((a) => a.id === "u");
    expect(rosterNames(w, "u")).toEqual([]);
  });
});

describe("nearbyObjectNames", () => {
  it("returns named objects within radius, nearest-first", () => {
    const names = nearbyObjectNames(furnished(), "u");
    // desk center (3,1.5) is ~2.06 from u (1,1); mug center (4.5,3.5) ~4.3.
    expect(names).toEqual(["desk", "mug"]);
  });
  it("excludes objects beyond the radius", () => {
    expect(nearbyObjectNames(furnished(), "u", 1)).toEqual([]);
  });
  it("excludes blank names", () => {
    const w = furnished();
    w.scene.objects.push({
      id: "blank", name: "   ", description: "", x: 1, y: 2,
      w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    expect(nearbyObjectNames(w, "u")).not.toContain("   ");
  });
  it("caps at MAX_TARGET_OPTIONS", () => {
    const w = tiny();
    for (let i = 0; i < MAX_TARGET_OPTIONS + 5; i++) {
      w.scene.objects.push({
        id: `o${i}`, name: `obj${i}`, description: "", x: 1, y: 1,
        w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
      });
    }
    expect(nearbyObjectNames(w, "u").length).toBe(MAX_TARGET_OPTIONS);
  });
  it("returns [] for an unknown actor", () => {
    expect(nearbyObjectNames(tiny(), "ghost")).toEqual([]);
  });
  it("breaks distance ties by name", () => {
    const w = tiny();
    w.scene.objects.push(
      {
        id: "b", name: "beta", description: "", x: 2, y: 1,
        w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
      },
      {
        id: "a", name: "alpha", description: "", x: 1, y: 2,
        w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
      },
    );
    // Both centers are 1.0 from u (1,1): tie broken by name.
    expect(nearbyObjectNames(w, "u").slice(0, 2)).toEqual(["alpha", "beta"]);
  });
});

describe("landmarkNames", () => {
  it("returns unique sorted names, capped", () => {
    const w = furnished();
    w.scene.objects.push({
      id: "desk2", name: "desk", description: "", x: 0, y: 0,
      w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    expect(landmarkNames(w)).toEqual(["desk", "mug"]);
  });
  it("is empty with no named objects", () => {
    expect(landmarkNames(tiny())).toEqual([]);
  });
});

describe("buildTargetQuestion", () => {
  it("builds a speak addressee question over the roster", () => {
    const q = buildTargetQuestion("speak", "actor", tiny(), "u");
    expect(q).toEqual({
      type: "choice",
      instructions: "Who does U speak to?",
      options: ["N"],
    });
  });
  it("builds a move destination question over the roster", () => {
    const q = buildTargetQuestion("move", "actor", tiny(), "u");
    expect(q?.type).toBe("choice");
    if (q?.type !== "choice") throw new Error("expected a choice question");
    expect(q.options).toEqual(["N"]);
    expect(q.instructions).toContain("move toward");
  });
  it("builds a move landmark question over scene objects", () => {
    const q = buildTargetQuestion("move", "landmark", furnished(), "u");
    if (q?.type !== "choice") throw new Error("expected a choice question");
    expect(q.options).toEqual(["desk", "mug"]);
  });
  it("builds an interact question over nearby objects", () => {
    const q = buildTargetQuestion("interact", "object", furnished(), "u");
    if (q?.type !== "choice") throw new Error("expected a choice question");
    expect(q.options).toEqual(["desk", "mug"]);
  });
  it("returns null for targetKind none", () => {
    expect(buildTargetQuestion("speak", "none", tiny(), "u")).toBeNull();
    expect(buildTargetQuestion("move", "none", tiny(), "u")).toBeNull();
  });
  it("returns null for undefined targetKind", () => {
    expect(buildTargetQuestion("speak", undefined, tiny(), "u")).toBeNull();
  });
  it("returns null when the roster is empty", () => {
    const w = tiny();
    w.actors = w.actors.filter((a) => a.id === "u");
    expect(buildTargetQuestion("speak", "actor", w, "u")).toBeNull();
  });
  it("returns null when there are no landmarks", () => {
    expect(buildTargetQuestion("move", "landmark", tiny(), "u")).toBeNull();
  });
  it("returns null when no objects are near", () => {
    expect(buildTargetQuestion("interact", "object", tiny(), "u")).toBeNull();
  });
});

describe("resolveTargetId", () => {
  it("resolves an actor by name (case-insensitive)", () => {
    expect(resolveTargetId(tiny(), "u", "actor", "N")).toEqual({ id: "n", kind: "actor" });
    expect(resolveTargetId(tiny(), "u", "actor", "n")).toEqual({ id: "n", kind: "actor" });
  });
  it("never resolves the acting actor", () => {
    expect(resolveTargetId(tiny(), "u", "actor", "U")).toBeUndefined();
  });
  it("returns undefined for an unknown actor name", () => {
    expect(resolveTargetId(tiny(), "u", "actor", "Zed")).toBeUndefined();
  });
  it("resolves an object by name", () => {
    expect(resolveTargetId(furnished(), "u", "object", "mug")).toEqual({ id: "mug1", kind: "object" });
  });
  it("resolves a landmark to the scene object id", () => {
    expect(resolveTargetId(furnished(), "u", "landmark", "desk")).toEqual({ id: "desk1", kind: "object" });
  });
  it("picks the nearest on duplicate names, id tie-break", () => {
    const w = tiny();
    // Two mugs: mug-b at (1,2) d=1.0 from u; mug-a at (2,1) d=1.0 — tie → id "a" wins.
    w.scene.objects.push(
      {
        id: "mug-b", name: "mug", description: "", x: 1, y: 2,
        w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
      },
      {
        id: "mug-a", name: "mug", description: "", x: 2, y: 1,
        w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
      },
    );
    expect(resolveTargetId(w, "u", "object", "mug")).toEqual({ id: "mug-a", kind: "object" });
  });
  it("returns undefined for blank or unknown names", () => {
    expect(resolveTargetId(furnished(), "u", "object", "  ")).toBeUndefined();
    expect(resolveTargetId(furnished(), "u", "object", "sofa")).toBeUndefined();
    expect(resolveTargetId(furnished(), "u", "none", "mug")).toBeUndefined();
  });
});

describe("attachTarget", () => {
  it("returns a new intent with targetId/targetKind", () => {
    const base = intent({ kind: "speak", targetKind: "actor" });
    const out = attachTarget(base, { id: "n", kind: "actor" }, "actor");
    expect(out).toEqual({ kind: "speak", targetKind: "actor", targetId: "n" });
    expect(base.targetId).toBeUndefined();
  });
});

describe("renderIntentCandidates", () => {
  it("renders speak candidates naming the target actor", () => {
    const out = renderIntentCandidates(
      tiny(), "u",
      intent({ kind: "speak", targetKind: "actor", targetId: "n" }),
    );
    expect(out).toHaveLength(4);
    expect(out[0]).toBe("U greets N warmly");
    for (const c of out) {
      expect(c).toContain("N");
      expect(c).not.toMatch(/"/); // never renders quotes
    }
  });
  it("renders target-less speak candidates", () => {
    const out = renderIntentCandidates(tiny(), "u", intent({ kind: "speak", targetKind: "none" }));
    expect(out).toEqual([
      "U thinks out loud",
      "U hums quietly to themselves",
      "U mutters under their breath",
    ]);
  });
  it("renders move candidates for an actor target", () => {
    const out = renderIntentCandidates(
      tiny(), "u",
      intent({ kind: "move", targetKind: "actor", targetId: "n" }),
    );
    expect(out[0]).toBe("U walks over to N");
    expect(out).toHaveLength(3);
  });
  it("renders move candidates for a landmark with 'the'", () => {
    const out = renderIntentCandidates(
      furnished(), "u",
      intent({ kind: "move", targetKind: "landmark", targetId: "desk1" }),
    );
    expect(out[0]).toBe("U walks over to the desk");
  });
  it("renders wander candidates without a target", () => {
    const out = renderIntentCandidates(tiny(), "u", intent({ kind: "move", targetKind: "none" }));
    expect(out).toContain("U wanders aimlessly");
  });
  it("renders interact candidates for an object", () => {
    const out = renderIntentCandidates(
      furnished(), "u",
      intent({ kind: "interact", targetKind: "object", targetId: "mug1" }),
    );
    expect(out).toEqual([
      "U picks up the mug",
      "U examines the mug",
      "U uses the mug",
    ]);
  });
  it("renders a fallback interact candidate without a target", () => {
    const out = renderIntentCandidates(tiny(), "u", intent({ kind: "interact", targetKind: "none" }));
    expect(out).toEqual(["U looks around for something to do"]);
  });
  it("renders gesture candidates with and without a target", () => {
    const withT = renderIntentCandidates(
      tiny(), "u",
      intent({ kind: "gesture", targetKind: "actor", targetId: "n" }),
    );
    expect(withT).toEqual(["U nods at N", "U waves at N", "U smiles at N"]);
    const solo = renderIntentCandidates(tiny(), "u", intent({ kind: "gesture" }));
    expect(solo).toEqual(["U nods thoughtfully", "U stretches", "U smiles to themselves"]);
  });
  it("renders wait candidates", () => {
    expect(renderIntentCandidates(tiny(), "u", intent({ kind: "wait" }))).toEqual([
      "U waits quietly",
      "U observes the room",
      "U sits back and watches",
    ]);
  });
  it("falls back to the raw targetId when the name is unresolvable", () => {
    const out = renderIntentCandidates(
      tiny(), "u",
      intent({ kind: "speak", targetKind: "actor", targetId: "ghost" }),
    );
    expect(out[0]).toContain("ghost");
  });
  it("never renders quotes in any candidate (all kinds)", () => {
    const kinds: Intent["kind"][] = ["speak", "move", "interact", "gesture", "wait"];
    for (const kind of kinds) {
      const out = renderIntentCandidates(
        furnished(), "u",
        intent({ kind, targetKind: "actor", targetId: "n" }),
      );
      for (const c of out) expect(c).not.toMatch(/"/);
    }
  });
});

describe("rankOptionsByProbability", () => {
  it("orders by descending probability", () => {
    expect(
      rankOptionsByProbability({ a: 0.2, b: 0.7, c: 0.1 }, ["a", "b", "c"]),
    ).toEqual(["b", "a", "c"]);
  });
  it("breaks ties by option order", () => {
    expect(rankOptionsByProbability({ a: 0.5, b: 0.5 }, ["a", "b"])).toEqual(["a", "b"]);
    expect(rankOptionsByProbability({ a: 0.5, b: 0.5 }, ["b", "a"])).toEqual(["b", "a"]);
  });
  it("treats missing probabilities as zero", () => {
    expect(rankOptionsByProbability({}, ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("describeIntent", () => {
  it("describes kind, target, manner, and quote", () => {
    expect(
      describeIntent(
        intent({ kind: "speak", targetKind: "actor", targetId: "n", manner: "warmly", quote: "hi" }),
        tiny(), "u",
      ),
    ).toBe('U: speak → N (warmly) quote="hi"');
  });
  it("falls back to targetKind when no targetId", () => {
    expect(describeIntent(intent({ kind: "move", targetKind: "none" }), tiny(), "u")).toBe(
      "U: move → none",
    );
  });
  it("uses the raw id when the name is unresolvable", () => {
    expect(
      describeIntent(intent({ kind: "move", targetKind: "actor", targetId: "ghost" }), tiny(), "u"),
    ).toBe("U: move → ghost");
  });
});

describe("INTERACT_CANDIDATE_RADIUS", () => {
  it("is a positive constant", () => {
    expect(INTERACT_CANDIDATE_RADIUS).toBeGreaterThan(0);
  });
});
