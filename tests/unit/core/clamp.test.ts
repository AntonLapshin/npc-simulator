// PLAN_V2 Phase 3: unit tests for the clamp policy (src/core/clamp.ts).
// One test per clamp rule, over the pure functions — no LLM, no I/O.
import { describe, expect, it } from "vitest";
import {
  allowsCallOut,
  clampContact,
  clampManipulation,
  clampMovement,
  CONTACT_REACH,
  describeClamp,
} from "../../../src/core/clamp.js";
import { diagnoseManipulation } from "../../../src/core/objects.js";
import { computeMovementOutcome } from "../../../src/core/movement.js";
import { buildManipulationSnapshot } from "../../../src/engine/objects.js";
import type { World } from "../../../src/types.js";
import { makeTinyWorld } from "../../helpers.js";

/** 6x6 empty room, u at (1,1), n at (4,4) — dist ≈ 4.24 cells. */
function tiny(): World {
  return makeTinyWorld();
}

function addObject(
  world: World,
  id: string,
  name: string,
  x: number,
  y: number,
): void {
  world.scene.objects.push({
    id,
    name,
    description: `a ${name}`,
    x,
    y,
    w: 1,
    h: 1,
    passable: false,
    blocksVision: false,
    blocksSound: false,
  });
}

/** u boxed in by non-passable 1x1 objects on all four sides. */
function boxedWorld(): World {
  const world = tiny();
  for (const [id, x, y] of [
    ["w1", 0, 1],
    ["w2", 2, 1],
    ["w3", 1, 0],
    ["w4", 1, 2],
  ] as const) {
    world.scene.objects.push({
      id,
      name: id,
      description: "wall",
      x,
      y,
      w: 1,
      h: 1,
      passable: false,
      blocksVision: false,
      blocksSound: false,
    });
  }
  return world;
}

describe("clampContact — out-of-reach contact", () => {
  it("records the attempt with no teleport when the target is beyond reach", () => {
    const world = tiny(); // u(1,1) → n(4,4): ≈4.24 cells > CONTACT_REACH
    const record = clampContact(world, "u", "U shakes N's hand.", {
      targetActorId: "n",
      exactQuote: null,
      outcome: null,
    });
    expect(record).not.toBeNull();
    expect(record!.attempted).toBe("U tried to shake hands with N.");
    expect(record!.executed).toContain("4 cells away");
    expect(record!.executed).toContain("beyond contact reach");
    expect(record!.executed).toContain("No contact happened");
    // No call-out conversion without speech verbs.
    expect(record!.executed).not.toContain("called out");
  });

  it("converts to calling out when the action carries quoted speech", () => {
    const world = tiny();
    const record = clampContact(world, "u", `U shakes N's hand. "Hey!"`, {
      targetActorId: "n",
      exactQuote: "Hey!",
      outcome: null,
    });
    expect(record).not.toBeNull();
    expect(record!.attempted).toBe("U tried to shake hands with N.");
    expect(record!.executed).toContain("No contact happened");
    expect(record!.executed).toContain('called out to N instead ("Hey!")');
  });

  it("converts to calling out when the action has a call/shout verb", () => {
    const world = tiny();
    const record = clampContact(world, "u", "U calls out to N and shakes N's hand.", {
      targetActorId: "n",
      exactQuote: null,
      outcome: null,
    });
    expect(record).not.toBeNull();
    expect(record!.executed).toContain("called out to N instead");
  });

  it("fails gracefully with an honest record when the verbs do not allow calling out", () => {
    const world = tiny();
    const record = clampContact(world, "u", "U hugs N.", {
      targetActorId: "n",
      exactQuote: null,
      outcome: null,
    });
    expect(record).not.toBeNull();
    expect(record!.attempted).toBe("U tried to hug N.");
    expect(record!.executed).toContain("reached toward N");
    expect(record!.executed).toContain("No contact happened");
    expect(record!.executed).not.toContain("called out");
  });

  it("returns null when contact is achieved (adjacent after the move)", () => {
    const world = tiny();
    const n = world.actors.find((a) => a.id === "n")!;
    n.x = 2;
    n.y = 1; // 1 cell from u — within reach
    const record = clampContact(world, "u", "U shakes N's hand.", {
      targetActorId: "n",
      exactQuote: null,
      outcome: null,
    });
    expect(record).toBeNull();
  });

  it("returns null when no contact target resolved, or the target is self", () => {
    const world = tiny();
    expect(
      clampContact(world, "u", "U shakes N's hand.", {
        targetActorId: undefined,
        exactQuote: null,
        outcome: null,
      }),
    ).toBeNull();
    expect(
      clampContact(world, "u", "U shakes N's hand.", {
        targetActorId: "u",
        exactQuote: null,
        outcome: null,
      }),
    ).toBeNull();
  });

  it("returns null when the text has no contact verb (manipulation channel owns it)", () => {
    const world = tiny();
    // "give the report to N" resolves a contact target in the Laya path,
    // but it is a hand-over attempt, not a touch — no contact record.
    expect(
      clampContact(world, "u", "U gives the report to N.", {
        targetActorId: "n",
        exactQuote: null,
        outcome: null,
      }),
    ).toBeNull();
  });

  it("CONTACT_REACH matches the narrate prompt's physical-contact rule", () => {
    expect(CONTACT_REACH).toBe(2.5);
  });
});

describe("clampMovement — unreachable destination", () => {
  it("records stayed-in-place when no legal step exists (boxed in)", () => {
    const world = boxedWorld();
    // The real engine: no step toward n is legal → null outcome.
    const outcome = computeMovementOutcome(world, "u", { destinationActorId: "n" });
    expect(outcome).toBeNull();
    const record = clampMovement(world, "u", {
      moves: true,
      destinationActorId: "n",
      outcome,
    });
    expect(record).not.toBeNull();
    expect(record!.attempted).toBe("U tried to walk to N.");
    expect(record!.executed).toContain("stayed in place");
    expect(record!.executed).toContain("no legal step toward N");
  });

  it("records the partial approach when the destination stays out of reach", () => {
    const world = tiny();
    // Fabricated closest-reachable outcome: u reaches (2,2), n is at
    // (4,4) — 2.83 cells away, still beyond contact reach.
    const record = clampMovement(world, "u", {
      moves: true,
      destinationActorId: "n",
      outcome: {
        from: { x: 1, y: 1 },
        x: 2,
        y: 2,
        path: [],
        destination: { kind: "actor", id: "n", x: 4, y: 4 },
      },
    });
    expect(record).not.toBeNull();
    expect(record!.attempted).toBe("U tried to walk to N.");
    expect(record!.executed).toContain("moved 1 cell toward N");
    expect(record!.executed).toContain("still 3 cells away");
    expect(record!.executed).toContain("too far to touch");
  });

  it("returns null when the destination is reached (executed as attempted)", () => {
    const world = tiny();
    const record = clampMovement(world, "u", {
      moves: true,
      destinationActorId: "n",
      outcome: {
        from: { x: 1, y: 1 },
        x: 3,
        y: 3,
        path: [],
        destination: { kind: "actor", id: "n", x: 4, y: 4 },
      },
    });
    // (3,3) → (4,4) is 1.41 cells: adjacent — nothing to record.
    expect(record).toBeNull();
  });

  it("returns null for stationary turns and undirected movement", () => {
    const world = tiny();
    expect(
      clampMovement(world, "u", { moves: false, outcome: null }),
    ).toBeNull();
    expect(
      clampMovement(world, "u", {
        moves: true,
        outcome: { from: { x: 1, y: 1 }, x: 2, y: 1, path: [], destination: null },
      }),
    ).toBeNull();
  });
});

describe("clampMovement — occupied cell", () => {
  it("records the gap when the target's cell is occupied and the engine stops at the closest reachable cell", () => {
    const world = tiny();
    // n's own cell is occupied (by n) — the engine never stacks, so the
    // closest reachable cell still leaves u short of contact reach.
    const record = clampMovement(world, "u", {
      moves: true,
      destinationActorId: "n",
      outcome: {
        from: { x: 1, y: 1 },
        x: 2,
        y: 2,
        path: [],
        destination: { kind: "actor", id: "n", x: 4, y: 4 },
      },
    });
    expect(record).not.toBeNull();
    expect(record!.attempted).toBe("U tried to walk to N.");
    expect(record!.executed).toContain("still 3 cells away");
  });

  it("records the gap for an object destination not fully reached", () => {
    const world = tiny();
    addObject(world, "desk1", "desk", 4, 4);
    const record = clampMovement(world, "u", {
      moves: true,
      destinationObjectId: "desk1",
      outcome: {
        from: { x: 1, y: 1 },
        x: 2,
        y: 2,
        path: [],
        destination: { kind: "object", id: "desk1", x: 4.5, y: 4.5 },
      },
    });
    expect(record).not.toBeNull();
    expect(record!.attempted).toBe("U tried to walk to the desk.");
    expect(record!.executed).toContain("still 3 cells from it");
  });

  it("returns null when the actor reaches the object (standing next to it)", () => {
    const world = tiny();
    addObject(world, "desk1", "desk", 4, 4);
    const record = clampMovement(world, "u", {
      moves: true,
      destinationObjectId: "desk1",
      outcome: {
        from: { x: 1, y: 1 },
        x: 4,
        y: 3,
        path: [],
        destination: { kind: "object", id: "desk1", x: 4.5, y: 4.5 },
      },
    });
    // distanceToRect((4,3), desk) = 1: standing next to it — arrived.
    expect(record).toBeNull();
  });
});

describe("clampManipulation — distant object", () => {
  it("records the graceful fail when the named object is beyond reach", () => {
    const world = tiny();
    addObject(world, "cup1", "cup", 5, 5); // ≈6.4 cells from u — beyond reach 4
    const snapshot = buildManipulationSnapshot(world);
    const diagnosis = diagnoseManipulation(snapshot, "u", "U picks up the cup.");
    expect(diagnosis.kind).toBe("rejected");
    if (diagnosis.kind !== "rejected") throw new Error("expected rejection");
    expect(diagnosis.reason).toBe("object-too-far");
    const record = clampManipulation(world, "u", diagnosis);
    expect(record).not.toBeNull();
    expect(record!.attempted).toBe("U tried to pick up the cup.");
    expect(record!.executed).toContain("the cup is 6 cells away, beyond reach");
  });

  it("records a hand-over rejected for a too-distant recipient", () => {
    const world = tiny();
    const u = world.actors.find((a) => a.id === "u")!;
    u.prop = "report"; // u holds the report; n is ≈4.24 cells away (> 2.5)
    const snapshot = buildManipulationSnapshot(world);
    // Single-letter names don't mention-resolve — the engine passes the
    // parser's contactActorId, so the test does the same.
    const diagnosis = diagnoseManipulation(snapshot, "u", "U hands the report to N.", "n");
    expect(diagnosis.kind).toBe("rejected");
    if (diagnosis.kind !== "rejected") throw new Error("expected rejection");
    expect(diagnosis.reason).toBe("recipient-too-far");
    const record = clampManipulation(world, "u", diagnosis);
    expect(record).not.toBeNull();
    expect(record!.attempted).toBe("U tried to hand the report over to N.");
    expect(record!.executed).toContain("N is 4 cells away, too far to hand anything to");
  });
});

describe("clampManipulation — unheld object", () => {
  it("records the graceful fail when putting down with empty hands", () => {
    const world = tiny();
    const snapshot = buildManipulationSnapshot(world);
    const diagnosis = diagnoseManipulation(snapshot, "u", "U puts down the laptop.");
    expect(diagnosis.kind).toBe("rejected");
    if (diagnosis.kind !== "rejected") throw new Error("expected rejection");
    expect(diagnosis.reason).toBe("nothing-held");
    const record = clampManipulation(world, "u", diagnosis);
    expect(record).not.toBeNull();
    // Nothing is held, so there is no subject to name — "something" is
    // the honest phrasing.
    expect(record!.attempted).toBe("U tried to put something down.");
    expect(record!.executed).toContain("holding nothing");
  });

  it("records the graceful fail when handing over with empty hands", () => {
    const world = tiny();
    const snapshot = buildManipulationSnapshot(world);
    const diagnosis = diagnoseManipulation(snapshot, "u", "U hands the report to N.", "n");
    expect(diagnosis.kind).toBe("rejected");
    if (diagnosis.kind !== "rejected") throw new Error("expected rejection");
    expect(diagnosis.reason).toBe("nothing-held");
    const record = clampManipulation(world, "u", diagnosis);
    expect(record).not.toBeNull();
    expect(record!.attempted).toBe("U tried to hand something over to N.");
    expect(record!.executed).toContain("holding nothing");
  });

  it("returns null when the manipulation executes or nothing is implied", () => {
    const world = tiny();
    addObject(world, "cup1", "cup", 1, 2); // within reach of u(1,1)
    const snapshot = buildManipulationSnapshot(world);
    const executed = diagnoseManipulation(snapshot, "u", "U picks up the cup.");
    expect(executed.kind).toBe("executed");
    expect(clampManipulation(world, "u", executed)).toBeNull();
    const none = diagnoseManipulation(snapshot, "u", "U looks around.");
    expect(none.kind).toBe("none");
    expect(clampManipulation(world, "u", none)).toBeNull();
  });
});

describe("allowsCallOut", () => {
  it("is true with quoted speech or call/shout verbs, false otherwise", () => {
    expect(allowsCallOut("U shakes N's hand.", "Hey!")).toBe(true);
    expect(allowsCallOut("U shouts to N and shakes N's hand.", null)).toBe(true);
    expect(allowsCallOut("U calls out to N.", null)).toBe(true);
    expect(allowsCallOut("U shakes N's hand.", null)).toBe(false);
    expect(allowsCallOut("U hugs N.", null)).toBe(false);
  });
});

describe("describeClamp", () => {
  it("renders the ATTEMPTED vs EXECUTED block with one line pair per gapped channel", () => {
    const world = tiny();
    const lines = describeClamp(world, "u", {
      movement: {
        attempted: "U tried to walk to N.",
        executed: "U stayed in place — no legal step toward N this turn.",
      },
      contact: {
        attempted: "U tried to shake hands with N.",
        executed: "U could not reach N — 4 cells away, beyond contact reach. No contact happened.",
      },
      manipulation: null,
    });
    expect(lines[0]).toContain("ATTEMPTED vs EXECUTED");
    expect(lines).toContain("- MOVEMENT — ATTEMPTED: U tried to walk to N.");
    expect(lines).toContain("  EXECUTED: U stayed in place — no legal step toward N this turn.");
    expect(lines).toContain("- CONTACT — ATTEMPTED: U tried to shake hands with N.");
    expect(lines.some((l) => l.startsWith("- MANIPULATION"))).toBe(false);
  });

  it("emits only the header when every channel is null", () => {
    const world = tiny();
    const lines = describeClamp(world, "u", {
      movement: null,
      contact: null,
      manipulation: null,
    });
    expect(lines).toHaveLength(1);
  });
});
