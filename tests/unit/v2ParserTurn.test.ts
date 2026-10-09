// PLAN_V2 Phase 2: the parse step wired into the turn.
//
// - Executors accept pre-parsed ActionSemantics (and keep their
//   deterministic text behavior when it is absent).
// - On the v2 path the parse runs right after the intent call (NPC) and
//   on the human's text (player turns) — no special casing.
// - Fail-open: Laya down or unwired → deterministic parsers, the turn
//   still completes honestly, `parser_fallback` is logged.
// - v1 path: the parser is never invoked.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action, ActionSemantics, World } from "../../src/types.js";
import type { LayaAnswer } from "../../src/decision/decisionTypes.js";
import { LayaClient } from "../../src/decision/layaClient.js";
import type { LayaTurnWiring } from "../../src/engine/layaTurn.js";
import { readLayaRuntimeConfig } from "../../src/config.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { makeTestDeps } from "../helpers.js";
import type { IntentEngine } from "../../src/intelligence/types.js";
import { runTurn } from "../../src/engine/turnOrchestrator.js";
import { plannedMovementFromSemantics } from "../../src/core/semantics.js";
import { planMovementSemantics } from "../../src/engine/movementExecutor.js";
import { planSpeech } from "../../src/engine/speechExecutor.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";

function scriptedClient(
  script: Record<string, LayaAnswer>,
  onCall?: (ids: string[]) => void,
): LayaClient {
  return new LayaClient({
    baseUrl: "http://stub",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const ids = Object.keys(body.questions ?? {});
      onCall?.(ids);
      const answers: Record<string, unknown> = {};
      for (const id of ids) {
        const a = script[id];
        if (!a) throw new Error(`no scripted answer for "${id}"`);
        if (a.type === "choice") {
          answers[id] = {
            type: "choice",
            choice: a.winner,
            probabilities: a.probabilities,
            confidence: a.confidence,
          };
        } else if (a.type === "noul") {
          answers[id] = { type: "noul", noul: a.pTrue };
        } else {
          throw new Error(`unexpected scripted answer type for "${id}"`);
        }
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch,
  });
}

function downClient(): LayaClient {
  return new LayaClient({
    baseUrl: "http://stub",
    fetchImpl: (async () => {
      throw new Error("laya down");
    }) as typeof fetch,
  });
}

function choice(winner: string, options: string[]): LayaAnswer {
  const probabilities: Record<string, number> = {};
  for (const o of options) probabilities[o] = o === winner ? 0.9 : 0.1 / Math.max(1, options.length - 1);
  return { type: "choice", winner, probabilities, confidence: 0.9 };
}

function stubWiring(client: LayaClient): LayaTurnWiring {
  const config = readLayaRuntimeConfig({ LAYA_MODE: "static", LAYA_SALIENCE: "1" });
  return {
    client,
    // Isolate the parse step: the locomotion veto and the renderability
    // screen (both default-on in static mode, pre-existing Phase 1 wiring
    // on the shared NPC branch) would each burn their own decide call.
    config: {
      ...config,
      toggles: { ...config.toggles, locomotion: false, renderability: false },
    },
    salienceThreshold: 3,
    plausibility: false,
  };
}

function makeParserWorld(): World {
  const actor = (id: string, name: string, x: number, y: number) => ({
    id,
    name,
    persona: `${name} persona.`,
    x,
    y,
    state: "standing",
    emotion: "calm",
    goal: "Idle.",
    memories: [] as string[],
    beliefs: [] as string[],
    relationships: [] as string[],
  });
  return loadScenario({
    version: 1,
    id: "parser",
    title: "Parser office",
    narrative: "A small office.",
    userActorId: "anton",
    order: ["anton", "tanya", "dana"],
    scene: {
      width: 12,
      height: 12,
      objects: [
        { id: "o-desk", name: "desk", description: "A desk.", x: 2, y: 2, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false },
      ],
    },
    actors: [actor("anton", "Anton", 1, 1), actor("tanya", "Tanya", 5, 5), actor("dana", "Dana", 9, 9)],
  });
}

/** The scripted parse of: Anton says "Hi Tanya" and keeps typing. */
function parseScript(): Record<string, LayaAnswer> {
  const people = ["Anton", "Tanya", "Dana"];
  return {
    q_moves: { type: "noul", pTrue: 0.92 },
    q_speaks: { type: "noul", pTrue: 0.95 },
    q_addressee: choice("Tanya", [...people, "nobody in particular"]),
    q_destination: choice("Tanya", ["desk", ...people, "stays put / nowhere"]),
    q_contact: choice("no physical contact", [...people, "no physical contact"]),
  };
}

const INTENT_ACTION = 'Anton says "Hi Tanya" and keeps typing.';

function stubIntentEngine(action: string = INTENT_ACTION): IntentEngine {
  return { intent: async () => ({ action, quote: "" }) };
}

describe("plannedMovementFromSemantics (pure)", () => {
  it("passes fields through and drops a destination naming the acting actor", () => {
    const s: ActionSemantics = {
      moves: true,
      speaks: false,
      quotedSpeech: [],
      destinationActorId: "anton",
      destinationObjectId: "o-desk",
      contactActorId: "tanya",
    };
    expect(plannedMovementFromSemantics(s, "anton")).toEqual({
      moves: true,
      destinationObjectId: "o-desk",
      contactActorId: "tanya",
    });
  });

  it("keeps a stationary parse stationary", () => {
    const s: ActionSemantics = { moves: false, speaks: true, quotedSpeech: ["Hi"] };
    expect(plannedMovementFromSemantics(s, "anton")).toEqual({ moves: false });
  });
});

describe("executors accept pre-parsed semantics", () => {
  it("planMovementSemantics prefers pre-parsed semantics over the text", () => {
    const world = makeParserWorld();
    const action: Action = { actorId: "anton", text: "Anton keeps typing." };
    // Text alone: stationary.
    expect(planMovementSemantics(world, action)).toEqual({ moves: false });
    // Pre-parsed: locomotion toward Tanya, even though the text says otherwise.
    const semantics: ActionSemantics = {
      moves: true,
      speaks: false,
      quotedSpeech: [],
      destinationActorId: "tanya",
    };
    expect(planMovementSemantics(world, action, undefined, semantics)).toEqual({
      moves: true,
      destinationActorId: "tanya",
    });
  });

  it("planSpeech prefers the parsed quote list over re-parsing the text", () => {
    const action: Action = { actorId: "anton", text: "Anton keeps typing." };
    expect(planSpeech(action)).toBeNull();
    expect(planSpeech(action, undefined, { quotedSpeech: ["Hi Tanya"] })).toBe("Hi Tanya");
    expect(planSpeech(action, undefined, { quotedSpeech: [] })).toBeNull();
  });

  it("executeManipulation takes the recipient from pre-parsed contact", () => {
    const world = makeParserWorld();
    const anton = world.actors.find((a) => a.id === "anton")!;
    const tanya = world.actors.find((a) => a.id === "tanya")!;
    // Anton holds the laptop; Tanya is within reach and holds nothing.
    world.scene.objects.push({
      id: "laptop_1", name: "laptop", description: "A laptop.",
      x: anton.x, y: anton.y, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false,
    });
    anton.prop = "laptop";
    anton.heldObjectId = "laptop_1";
    tanya.x = anton.x + 1;
    tanya.y = anton.y;
    const action: Action = { actorId: "anton", text: "Hand the laptop to them." };
    // No named recipient in the text → no hand-over without semantics.
    expect(executeManipulation(world, action)).toBeNull();
    // With the parsed contact → hand-over to Tanya.
    const out = executeManipulation(world, action, { contactActorId: "tanya" });
    expect(out?.plan.kind).toBe("hand-over");
    expect(out?.plan).toMatchObject({ targetActorId: "tanya" });
  });
});

describe("v2 turn: the parse step", () => {
  const OLD = process.env.TURN_LOOP;
  beforeEach(() => {
    process.env.TURN_LOOP = "v2";
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.TURN_LOOP;
    else process.env.TURN_LOOP = OLD;
  });

  it("runs the parser after the intent call and the executors use its output", async () => {
    const logger = createTestLogger("v2-parse-up");
    let decideCalls = 0;
    const deps = makeTestDeps(logger, {
      intentEngine: stubIntentEngine(),
      forceAllNpc: true,
      laya: stubWiring(scriptedClient(parseScript(), () => decideCalls++)),
    });
    const world = makeParserWorld();
    const next = await runTurn(world, deps);

    // Exactly one batched decide.
    expect(decideCalls).toBe(1);
    // parser_completed carries the ActionSemantics.
    const completed = logger.store.byEvent("parser_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.output).toEqual({
      moves: true,
      speaks: true,
      quotedSpeech: ["Hi Tanya"],
      addresseeActorId: "tanya",
      destinationActorId: "tanya",
    });
    // The movement executor planned from the PARSED semantics — the text
    // alone ("keeps typing") is stationary, so moves:true here proves the
    // pre-parsed path was used.
    const planned = logger.store.byEvent("movement_planned");
    expect(planned).toHaveLength(1);
    const plannedInput = planned[0]!.input as { plannedMovement: unknown };
    expect(plannedInput.plannedMovement).toEqual({
      moves: true,
      destinationActorId: "tanya",
    });
    // The speech executor used the parsed quote list.
    const speech = logger.store.byEvent("speech_planned");
    expect(speech).toHaveLength(1);
    expect(speech[0]!.output).toEqual({ exactQuote: "Hi Tanya" });
    // The turn completed.
    expect(logger.store.byEvent("turn_completed")).toHaveLength(1);
    expect(next.tick).toBe(world.tick + 1);
  });

  it("fails open when Laya is down: deterministic parsers, honest turn, parser_fallback logged", async () => {
    const logger = createTestLogger("v2-parse-down");
    const deps = makeTestDeps(logger, {
      intentEngine: stubIntentEngine(),
      forceAllNpc: true,
      laya: stubWiring(downClient()),
    });
    const world = makeParserWorld();
    const next = await runTurn(world, deps);

    expect(logger.store.byEvent("parser_completed")).toHaveLength(0);
    const fallback = logger.store.byEvent("parser_fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.error).toMatch(/falling back to deterministic text parsers/);
    // Deterministic text parse: "keeps typing" is stationary → no movement
    // planned; the quote is still extracted honestly from the text.
    expect(logger.store.byEvent("movement_planned")).toHaveLength(0);
    const speech = logger.store.byEvent("speech_planned");
    expect(speech).toHaveLength(1);
    expect(speech[0]!.output).toEqual({ exactQuote: "Hi Tanya" });
    // The turn never blocked on the parser.
    expect(logger.store.byEvent("turn_completed")).toHaveLength(1);
    expect(next.tick).toBe(world.tick + 1);
  });

  it("fails open when the parser is disabled (no Laya wiring): v2 turn completes on text parsers", async () => {
    const logger = createTestLogger("v2-parse-disabled");
    const deps = makeTestDeps(logger, {
      intentEngine: stubIntentEngine(),
      forceAllNpc: true,
      // No laya wiring at all.
    });
    const world = makeParserWorld();
    const next = await runTurn(world, deps);

    expect(logger.store.byEvent("parser_completed")).toHaveLength(0);
    expect(logger.store.byEvent("parser_fallback")).toHaveLength(0);
    expect(logger.store.byEvent("turn_completed")).toHaveLength(1);
    expect(next.tick).toBe(world.tick + 1);
  });

  it("parses the human player's text on the v2 path too (no special casing)", async () => {
    const logger = createTestLogger("v2-parse-human");
    const userText = 'Anton says "Hi Tanya" and keeps typing.';
    const deps = makeTestDeps(logger, {
      // No intentEngine needed: user turns skip the intent call.
      getUserAction: async () => userText,
      laya: stubWiring(scriptedClient(parseScript())),
    });
    const world = makeParserWorld(); // userActorId "anton", turnIndex 0 → user turn
    await runTurn(world, deps);

    const completed = logger.store.byEvent("parser_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.input).toEqual({ actionText: userText });
    expect(logger.store.byEvent("turn_completed")).toHaveLength(1);
  });
});

describe("v1 path: the parser is never invoked", () => {
  const OLD = process.env.TURN_LOOP;
  beforeEach(() => {
    delete process.env.TURN_LOOP;
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.TURN_LOOP;
    else process.env.TURN_LOOP = OLD;
  });

  it("does not call decide even with Laya wiring injected", async () => {
    const logger = createTestLogger("v1-parse-untouched");
    let decideCalls = 0;
    const deps = makeTestDeps(logger, {
      getUserAction: async () => "Anton keeps typing.",
      laya: stubWiring(scriptedClient(parseScript(), () => decideCalls++)),
    });
    await runTurn(makeParserWorld(), deps);

    expect(decideCalls).toBe(0);
    expect(logger.store.byEvent("parser_completed")).toHaveLength(0);
    expect(logger.store.byEvent("parser_fallback")).toHaveLength(0);
    expect(logger.store.byEvent("turn_completed")).toHaveLength(1);
  });
});
