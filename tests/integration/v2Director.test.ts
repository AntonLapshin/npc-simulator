// PLAN_V2 Phase 5 (the director): the deterministic staleness trigger.
// Scripted providers, no network — a boring loop must fire the director,
// a lively scene must not.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runTurn, runTurns } from "../../src/engine/turnOrchestrator.js";
import type { EngineDependencies } from "../../src/engine/turnOrchestrator.js";
import { MockIntentEngine } from "../../src/mocks/mockIntentEngine.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import type { World } from "../../src/types.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld } from "../helpers.js";
import { saveWorld, loadWorld } from "../../src/engine/persistence.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

const TURN_LOOP_ENV = "TURN_LOOP";
let savedTurnLoop: string | undefined;

beforeEach(() => {
  savedTurnLoop = process.env[TURN_LOOP_ENV];
  process.env[TURN_LOOP_ENV] = "v2";
});

afterEach(() => {
  if (savedTurnLoop === undefined) delete process.env[TURN_LOOP_ENV];
  else process.env[TURN_LOOP_ENV] = savedTurnLoop;
});

const ALARM = "The fire alarm starts ringing.";
const COURIER = "A courier arrives with a large box.";

function makeDirectorWorld(threshold?: number): World {
  const world = makeTinyWorld();
  world.directorEvents = [
    { id: "alarm", text: ALARM },
    { id: "courier", text: COURIER },
  ];
  if (threshold !== undefined) world.directorStalenessThreshold = threshold;
  return world;
}

const BORING = "waits and observes the situation.";
const BORING_KEY = BORING.toLowerCase();

function makeBoringDeps(
  logger: ReturnType<typeof createTestLogger>,
  overrides: Partial<EngineDependencies> = {},
): EngineDependencies {
  return makeTestDeps(logger, {
    forceAllNpc: true,
    intentEngine: new MockIntentEngine(logger, {
      u: { action: BORING, quote: "" },
      n: { action: BORING, quote: "" },
    }),
    consequenceEngine: new MockConsequenceEngine(logger, {
      [`u::${BORING_KEY}`]: {
        narrative: "U waits quietly, observing nothing in particular.",
        thoughts: "Calm.",
        emotion: "calm",
        reasoning: "scripted boring turn",
      },
      [`n::${BORING_KEY}`]: {
        narrative: "N waits quietly, observing nothing in particular.",
        thoughts: "Calm.",
        emotion: "calm",
        reasoning: "scripted boring turn",
      },
    }),
    ...overrides,
  });
}

describe("director staleness trigger", () => {
  it("fires exactly when stale: K boring turns arm it, the next turn injects", async () => {
    const logger = createTestLogger("v2director-arm");
    const deps = makeBoringDeps(logger);
    let world = makeDirectorWorld(); // default threshold 6

    world = await runTurns(world, deps, 5);
    // Armed but silent: the counter is one short of the threshold.
    expect(world.directorStalenessCount).toBe(5);
    expect(world.directorEventsConsumed ?? []).toEqual([]);
    expect(logger.store.byEvent("director_event_injected")).toHaveLength(0);
    expect(world.history.map((e) => e.text)).not.toContain(ALARM);

    world = await runTurn(world, deps); // 6th boring turn — n's turn
    // The trigger fired exactly on the Kth boring turn: consumed, in
    // history, logged; the counter reset for the next cycle.
    expect(world.directorStalenessCount).toBe(0);
    expect(world.directorEventsConsumed).toEqual(["alarm"]);
    expect(world.history.map((e) => e.text)).toContain(ALARM);
    // The incident is a world fact: perceived by every actor.
    const incident = world.history.find((e) => e.text === ALARM)!;
    expect([...incident.perceivers].sort()).toEqual(["n", "u"]);
    expect(incident.actionText).toBeUndefined();

    const injected = logger.store.byEvent("director_event_injected");
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({
      module: "director",
      event: "director_event_injected",
      actorId: "n",
    });
    expect(injected[0]!.output).toMatchObject({ eventId: "alarm", text: ALARM });

    world = await runTurn(world, deps); // 7th turn — u's turn, tick 6
    // …and the incident rode into the intent prompt as a world fact,
    // exactly once.
    const prompt = logger
      .store.byEvent("intent_started")
      .find((e) => e.tick === 6 && e.actorId === "u")!.prompt!;
    expect(prompt).toContain("WORLD FACT — NEW INCIDENT:");
    expect(prompt).toContain(ALARM);
    expect(world.directorPendingIncident).toBeUndefined();
    // Earlier prompts carry no incident.
    const firstPrompt = logger
      .store.byEvent("intent_started")
      .find((e) => e.tick === 0)!.prompt!;
    expect(firstPrompt).not.toContain("WORLD FACT");
  });

  it("acceptance: 15-turn boring loop fires both incidents and the history visibly changes", async () => {
    const logger = createTestLogger("v2director-15");
    const deps = makeBoringDeps(logger);
    let world = makeDirectorWorld();

    world = await runTurns(world, deps, 15);

    // Both incidents consumed exactly once, in scenario order.
    expect(world.directorEventsConsumed).toEqual(["alarm", "courier"]);
    const texts = world.history.map((e) => e.text);
    expect(texts).toContain(ALARM);
    expect(texts).toContain(COURIER);
    expect(texts.filter((t) => t === ALARM)).toHaveLength(1);
    expect(texts.filter((t) => t === COURIER)).toHaveLength(1);
    expect(logger.store.byEvent("director_event_injected")).toHaveLength(2);

    // The world visibly changed: the incident entries sit in history
    // (which is what the picture renders from), interleaved with turns.
    const alarmIdx = texts.indexOf(ALARM);
    const courierIdx = texts.indexOf(COURIER);
    expect(alarmIdx).toBeGreaterThan(-1);
    expect(courierIdx).toBeGreaterThan(alarmIdx);
  });

  it("consumes each event once; an exhausted list stays silent without crashing", async () => {
    const logger = createTestLogger("v2director-exhaust");
    const deps = makeBoringDeps(logger);
    let world = makeDirectorWorld(2); // threshold 2, 2 events

    world = await runTurns(world, deps, 2); // injection #1 at end of turn 2
    expect(world.directorEventsConsumed).toEqual(["alarm"]);
    world = await runTurns(world, deps, 2); // injection #2 at end of turn 4
    expect(world.directorEventsConsumed).toEqual(["alarm", "courier"]);
    world = await runTurns(world, deps, 5); // turns 5-9: nothing left
    expect(world.directorEventsConsumed).toEqual(["alarm", "courier"]);
    expect(logger.store.byEvent("director_event_injected")).toHaveLength(2);
    const texts = world.history.map((e) => e.text);
    expect(texts.filter((t) => t === ALARM)).toHaveLength(1);
    expect(texts.filter((t) => t === COURIER)).toHaveLength(1);
    expect(world.tick).toBe(9);
  });

  it("respects a custom staleness threshold", async () => {
    const logger = createTestLogger("v2director-threshold");
    const deps = makeBoringDeps(logger);
    const world = await runTurns(makeDirectorWorld(2), deps, 2);
    expect(world.directorStalenessCount).toBe(0);
    expect(world.directorEventsConsumed).toEqual(["alarm"]);
    expect(logger.store.byEvent("director_event_injected")).toHaveLength(1);
  });

  it("stays silent when the scene is lively: varied action cores reset the counter", async () => {
    const logger = createTestLogger("v2director-lively");
    // 12 turns, 12 distinct verb|noun cores, no world changes.
    const actions: Array<[string, number, string, string]> = [
      ["u", 0, "U waves.", "U waves hello."],
      ["n", 1, "N sits down.", "N sits down."],
      ["u", 2, "U stands up.", "U stands up."],
      ["n", 3, "N looks around.", "N looks around the room."],
      ["u", 4, "U pours coffee.", "U pours coffee."],
      ["n", 5, "N picks up the papers.", "N picks up the papers."],
      ["u", 6, "U tells a story.", "U tells a story."],
      ["n", 7, "N asks a question.", "N asks a question."],
      ["u", 8, "U thanks everyone.", "U thanks everyone."],
      ["n", 9, "N offers help.", "N offers help."],
      ["u", 10, "U pushes the chair.", "U pushes the chair."],
      ["n", 11, "N adjusts the papers.", "N adjusts the papers."],
    ];
    const intentScript: Record<string, { action: string; quote: string }> = {};
    const consequenceScript: Record<
      string,
      { narrative: string; thoughts: string; emotion: string; reasoning: string }
    > = {};
    for (const [actor, tick, action, narrative] of actions) {
      intentScript[`${actor}@tick${tick}`] = { action, quote: "" };
      consequenceScript[`${actor}::${action.toLowerCase()}`] = {
        narrative,
        thoughts: "Busy.",
        emotion: "calm",
        reasoning: "scripted lively turn",
      };
    }
    const deps = makeTestDeps(logger, {
      forceAllNpc: true,
      intentEngine: new MockIntentEngine(logger, intentScript),
      consequenceEngine: new MockConsequenceEngine(logger, consequenceScript),
    });

    const world = await runTurns(makeDirectorWorld(), deps, 12);
    expect(world.directorStalenessCount).toBe(0);
    expect(world.directorEventsConsumed ?? []).toEqual([]);
    expect(logger.store.byEvent("director_event_injected")).toHaveLength(0);
    expect(world.history.map((e) => e.text)).not.toContain(ALARM);
  });

  it("stays silent when world changes reset the counter", async () => {
    const logger = createTestLogger("v2director-worldchange");
    // u repeats one core (each repeat is substituted with the fallback —
    // same "other|" core, still stale); n alternates three DISTINCT
    // world-changing actions (sit / stand / walk) so the world changes
    // every n turn and the counter never reaches the threshold of 2.
    // (The v2 repetition screen substitutes an actor's own verbatim
    // repeats, so the world-changing actions must have distinct cores.)
    const deps = makeTestDeps(logger, {
      forceAllNpc: true,
      intentEngine: new MockIntentEngine(logger, {
        "u@tick0": { action: "U waits quietly.", quote: "" },
        "u@tick2": { action: "U waits quietly.", quote: "" },
        "u@tick4": { action: "U waits quietly.", quote: "" },
        "n@tick1": { action: "N sits down.", quote: "" },
        "n@tick3": { action: "N stands up.", quote: "" },
        "n@tick5": { action: "N walks toward U.", quote: "" },
      }),
      consequenceEngine: new MockConsequenceEngine(logger, {
        "u::u waits quietly.": {
          narrative: "U waits quietly.",
          thoughts: "Calm.",
          emotion: "calm",
          reasoning: "scripted",
        },
        "n::n sits down.": {
          narrative: "N sits down.",
          thoughts: "Tired.",
          emotion: "calm",
          reasoning: "scripted",
        },
        "n::n stands up.": {
          narrative: "N stands up.",
          thoughts: "Restless.",
          emotion: "calm",
          reasoning: "scripted",
        },
        "n::n walks toward u.": {
          narrative: "N walks toward U.",
          thoughts: "Going.",
          emotion: "calm",
          reasoning: "scripted",
        },
      }),
    });

    const world = await runTurns(makeDirectorWorld(2), deps, 6);
    expect(world.directorEventsConsumed ?? []).toEqual([]);
    expect(logger.store.byEvent("director_event_injected")).toHaveLength(0);
    // Sanity: the world really did change on n's turns (pose + position).
    const n = world.actors.find((a) => a.id === "n")!;
    expect([n.x, n.y]).not.toEqual([4, 4]);
  });

  it("leaves scenarios without directorEvents completely untouched", async () => {
    const logger = createTestLogger("v2director-off");
    const deps = makeBoringDeps(logger);
    const world = await runTurns(makeTinyWorld(), deps, 8);
    expect(world.directorStalenessCount).toBeUndefined();
    expect(world.directorEventsConsumed).toBeUndefined();
    expect(logger.store.byEvent("director_event_injected")).toHaveLength(0);
    for (const e of logger.store.byEvent("intent_started")) {
      expect(e.prompt).not.toContain("WORLD FACT");
    }
  });

  it("persists the staleness counter and consumed ids across save/load", async () => {
    const logger = createTestLogger("v2director-save");
    const deps = makeBoringDeps(logger);
    let world = makeDirectorWorld();
    world = await runTurns(world, deps, 7); // first injection at end of turn 6
    expect(world.directorEventsConsumed).toEqual(["alarm"]);

    const dir = mkdtempSync(join(tmpdir(), "v2director-"));
    const path = join(dir, "world.json");
    await saveWorld(path, world, logger);
    const loaded = await loadWorld(path, logger);
    expect(loaded.directorEventsConsumed).toEqual(["alarm"]);
    expect(loaded.directorStalenessCount).toBe(1);
    expect(loaded.directorEvents).toHaveLength(2);
    // …and the reloaded world keeps directing: the second event still fires.
    const logger2 = createTestLogger("v2director-save2");
    const deps2 = makeBoringDeps(logger2);
    const resumed = await runTurns(loaded, deps2, 6);
    expect(resumed.directorEventsConsumed).toEqual(["alarm", "courier"]);
  });

  it("ships the director style guide in the narrate prompt", async () => {
    const logger = createTestLogger("v2director-style");
    const deps = makeBoringDeps(logger);
    await runTurn(makeDirectorWorld(), deps);
    const prompts = logger
      .store.byEvent("consequence_started")
      .map((e) => e.prompt ?? "");
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toContain("DIRECTOR STYLE GUIDE");
      expect(prompt).toContain("narrating a living scene, not transcribing one");
    }
  });
});
