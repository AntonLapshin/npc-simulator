// Tests for the exp local-8b action items C1–C12 (S1–S8).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action, ConsequenceResult, World } from "../../src/types.js";
import type { ConsequenceEngine } from "../../src/intelligence/types.js";
import type { LLMProvider } from "../../src/llm/index.js";
import {
  buildRosterDisciplineLine,
  buildRosterRetryLine,
} from "../../src/llm/rosterDiscipline.js";
import { renderSuffix } from "../../src/llm/prompts.js";
import {
  createLlmEngines,
  userCapableTierBackend,
} from "../../src/llm/index.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { defaultConfig } from "../../src/config.js";
import { makeTinyWorld, makeTestDeps, loadOfficeScenario } from "../helpers.js";
import {
  applyRenderResult,
  describePosition,
  summarizeNarrativeForMemory,
} from "../../src/engine/patchApplier.js";
import { validateNarrativeActors } from "../../src/engine/validate/narrative.js";
import {
  hasDisplacementToken,
  maskResumedActivity,
} from "../../src/engine/deterministicSemantics.js";
import { hasOwnUtterance, maskReportedSpeech } from "../../src/engine/validate/speech.js";
import { extractDirectionHint } from "../../src/core/text.js";
import { computeMovementOutcome, suggestStep } from "../../src/core/movement.js";
import { resolveNamedDestination } from "../../src/engine/textHints.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import { resolveRender } from "../../src/engine/turnOrchestrator.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadAntonScenario(): World {
  const raw = JSON.parse(readFileSync(join(here, "../../scenarios/office-anton.json"), "utf-8"));
  // Minimal shape check — the loader is covered by scenarioLoader.test.ts.
  return raw as World;
}

// ---------------------------------------------------------------------------
// Item C1: roster-discipline prompt line + retry feedback roster repeat.
// ---------------------------------------------------------------------------
describe("C1 roster discipline", () => {
  it("buildRosterDisciplineLine repeats the ids with a negative example", () => {
    const line = buildRosterDisciplineLine(["jeff", "ana", "dan"]);
    expect(line).toContain('"jeff", "ana", "dan"');
    // Negative example names the invented people, not roster members.
    expect(line).toContain('"Anton"');
    expect(line).toContain('"Tanya"');
    expect(line).toMatch(/INVALID/i);
  });

  it("negative-example names avoid the actual roster", () => {
    const line = buildRosterDisciplineLine(["anton", "tanya", "dana"]);
    // Exp-3 item 1: "Leon" is the exp-3 invention shape; "Liam" second.
    expect(line).toContain('"Leon"');
    expect(line).toContain('"Liam"');
    expect(line).not.toMatch(/writing "Anton" or "Tanya"/);
  });

  it("buildRosterRetryLine repeats the ids for the retry feedback", () => {
    const line = buildRosterRetryLine(["u", "n"]);
    expect(line).toContain('"u", "n"');
    expect(line).toMatch(/ONLY valid actor ids/i);
  });

  it("renderSuffix carries the discipline line when roster ids are given", () => {
    const s = renderSuffix(["jeff", "ana", "dan"]);
    expect(s).toContain("ROSTER DISCIPLINE");
    expect(s).toContain('"jeff", "ana", "dan"');
    expect(s).toContain('"Anton"');
  });

  it("renderSuffix without roster ids still carries the discipline line", () => {
    // Phase 4: the roster line is unconditional — empty rosters list "(none)".
    expect(renderSuffix()).toContain("ROSTER DISCIPLINE");
    expect(renderSuffix()).toContain("(none)");
  });
});

// ---------------------------------------------------------------------------
// Item C2: user-turn capable-tier routing.
// ---------------------------------------------------------------------------
class StubProvider implements LLMProvider {
  readonly name = "stub";
  async complete(): Promise<string> {
    return "{}";
  }
}

describe("C2 user-turn capable-tier routing", () => {
  it("userCapableTierBackend returns the hard backend by default", () => {
    expect(userCapableTierBackend({} as NodeJS.ProcessEnv)).toBe("joingonka");
  });

  it("falls back silently when the tiers are identical", () => {
    const env = { LLM_BACKEND: "ollama", LLM_SIMPLE_BACKEND: "ollama" } as unknown as NodeJS.ProcessEnv;
    expect(userCapableTierBackend(env)).toBeUndefined();
  });

  it("LLM_USER_CAPABLE_TIER=0 disables it", () => {
    const env = { LLM_USER_CAPABLE_TIER: "0" } as unknown as NodeJS.ProcessEnv;
    expect(userCapableTierBackend(env)).toBeUndefined();
    const env2 = { LLM_USER_CAPABLE_TIER: "false" } as unknown as NodeJS.ProcessEnv;
    expect(userCapableTierBackend(env2)).toBeUndefined();
  });

  it("explicit provider instances make the tier opaque (silent fallback)", () => {
    const env = { LLM_BACKEND: "ollama", LLM_SIMPLE_BACKEND: "laya-local" } as unknown as NodeJS.ProcessEnv;
    expect(
      userCapableTierBackend(env, undefined, { consequence: new StubProvider() }),
    ).toBeUndefined();
  });

  it("a per-task intent override does not drag the user tier down", () => {
    const env = {
      LLM_BACKEND: "ollama",
      LLM_SIMPLE_BACKEND: "laya-local",
      LLM_BACKEND_INTENT: "joingonka",
    } as unknown as NodeJS.ProcessEnv;
    // The capable tier stays the hard-task default (ollama) — the intent
    // override is a simple-tier task and doesn't move the hard tier.
    expect(userCapableTierBackend(env)).toBe("ollama");
  });

  it("a consequence override onto the simple tier is a silent no-op", () => {
    const env = {
      LLM_BACKEND: "ollama",
      LLM_SIMPLE_BACKEND: "laya-local",
      LLM_BACKEND_CONSEQUENCE: "laya-local",
    } as unknown as NodeJS.ProcessEnv;
    // Consequence is the representative hard task: the override moves the
    // tier onto the simple tier, so the capable tier is a no-op.
    expect(userCapableTierBackend(env)).toBeUndefined();
  });

  it("getEnginesForTurn: NPC turns unchanged, user turns get the hard-tier consequence engine", () => {
    const env = {
      LLM_BACKEND: "ollama",
      LLM_SIMPLE_BACKEND: "laya-local",
    } as unknown as NodeJS.ProcessEnv;
    const engines = createLlmEngines(createTestLogger(), { env });
    const npc = engines.getEnginesForTurn(false);
    expect(npc.consequence).toBe(engines.consequenceEngine);
    const user = engines.getEnginesForTurn(true);
    expect(user.consequence).not.toBe(engines.consequenceEngine);
  });

  it("getEnginesForTurn falls back silently when tiers are identical", () => {
    const env = {
      LLM_BACKEND: "ollama",
      LLM_SIMPLE_BACKEND: "ollama",
    } as unknown as NodeJS.ProcessEnv;
    const engines = createLlmEngines(createTestLogger(), { env });
    const user = engines.getEnginesForTurn(true);
    expect(user.consequence).toBe(engines.consequenceEngine);
  });
});

// ---------------------------------------------------------------------------
// Item C3: deterministic memory append.
// ---------------------------------------------------------------------------
describe("C3 deterministic memory append", () => {
  it("summarizeNarrativeForMemory prefixes the actor and caps at ~160 chars", () => {
    expect(summarizeNarrativeForMemory("Jeff walks to the coffee machine.", "Jeff")).toBe(
      "Jeff: Jeff walks to the coffee machine.",
    );
    const long = `Jeff ${"walks ".repeat(60)}to the coffee machine.`;
    const summary = summarizeNarrativeForMemory(long, "Jeff");
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.startsWith("Jeff: ")).toBe(true);
  });

  it("applyRenderResult appends a deterministic memory line", () => {
    const world = makeTinyWorld();
    const next = applyRenderResult(
      world,
      { actorId: "u", text: "Walk toward N." },
      { narrative: "U walks toward N.", thoughts: "Going.", reasoning: "r" },
      { movement: null, pose: null, manipulation: null },
    );
    const u = next.actors.find((a) => a.id === "u")!;
    expect(u.memories).toContain("U: U walks toward N.");
  });

  it("skips the append on fallback or on tail dup", () => {
    const world = makeTinyWorld();
    const nextFallback = applyRenderResult(
      world,
      { actorId: "u", text: "Walk." },
      { narrative: "Nothing changes.", reasoning: "r" },
      { movement: null, pose: null, manipulation: null },
      defaultConfig,
      { fallback: true },
    );
    expect(nextFallback.actors.find((a) => a.id === "u")!.memories).toEqual([]);

    const dupWorld = makeTinyWorld();
    dupWorld.actors.find((a) => a.id === "u")!.memories = ["U: U walks toward N."];
    const nextDup = applyRenderResult(
      dupWorld,
      { actorId: "u", text: "Walk." },
      { narrative: "U walks toward N.", thoughts: "Again.", reasoning: "r" },
      { movement: null, pose: null, manipulation: null },
    );
    expect(nextDup.actors.find((a) => a.id === "u")!.memories).toEqual(["U: U walks toward N."]);
  });
});

// ---------------------------------------------------------------------------
// Items C4/C11: prop auto-hints + deterministic prop stubs + scenario props.
// ---------------------------------------------------------------------------
describe("C4/C11 prop support (Phase 3: engine-owned)", () => {
  it("renderSuffix states engine-owned manipulation, not prop auto-hints", () => {
    const s = renderSuffix(["ana"]);
    // Phase 3: the model never emits prop/object patches — the suffix
    // says so instead of teaching the patch convention.
    expect(s).not.toContain("PROP AUTO-HINTS");
    expect(s).toContain("MANIPULATION ARE ENGINE-OWNED");
    expect(s).toContain("EXECUTED MANIPULATION");
  });

  it("office.json has a mug by the coffee machine and laptops on desks", () => {
    const world = loadOfficeScenario();
    const byId = Object.fromEntries(world.scene.objects.map((o) => [o.id, o]));
    expect(byId["coffee_mug"]).toBeDefined();
    expect(byId["ana_laptop"]).toBeDefined();
    expect(byId["dan_laptop"]).toBeDefined();
    // Mug next to the coffee machine (18,12).
    expect(Math.hypot(byId["coffee_mug"].x - 18, byId["coffee_mug"].y - 12)).toBeLessThanOrEqual(2);
    // Laptops on the desk rects.
    const anaDesk = byId["ana_desk"];
    expect(byId["ana_laptop"].x).toBeGreaterThanOrEqual(anaDesk.x);
    expect(byId["ana_laptop"].x).toBeLessThanOrEqual(anaDesk.x + anaDesk.w);
    const danDesk = byId["dan_desk"];
    expect(byId["dan_laptop"].x).toBeGreaterThanOrEqual(danDesk.x);
    expect(byId["dan_laptop"].x).toBeLessThanOrEqual(danDesk.x + danDesk.w);
  });

  it("office-anton.json has a mug by the coffee machine", () => {
    const raw = loadAntonScenario();
    const byId = Object.fromEntries(raw.scene.objects.map((o) => [o.id, o]));
    expect(byId["coffee_mug"]).toBeDefined();
    const machine = byId["coffee_machine"];
    expect(
      Math.hypot(byId["coffee_mug"].x - machine.x, byId["coffee_mug"].y - machine.y),
    ).toBeLessThanOrEqual(2);
  });

  function typingWorld(): World {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "n_laptop", name: "N's laptop", description: "A laptop.",
      x: 4, y: 4, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    return world;
  }

  it("executor plans prop:laptop for typing near a laptop; applyRenderResult applies it", () => {
    const world = typingWorld();
    const outcome = executeManipulation(world, { actorId: "n", text: "Sit down and type on the laptop." });
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.kind).toBe("pick-up");
    expect(outcome!.plan.propName).toBe("laptop");
    const next = applyRenderResult(
      world,
      { actorId: "n", text: "Sit down and type on the laptop." },
      { narrative: "N types on the laptop.", thoughts: "Working.", reasoning: "r" },
      { movement: null, pose: "sit", manipulation: outcome },
    );
    expect(next.actors.find((x) => x.id === "n")!.prop).toBe("laptop");
  });

  it("executor plans prop:cup for grab+mug near a mug", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "n_mug", name: "N's mug", description: "A mug.",
      x: 4, y: 5, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    const outcome = executeManipulation(world, { actorId: "n", text: "Grab the mug from the desk." });
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.propName).toBe("cup");
    expect(outcome!.actorProps).toEqual([{ actorId: "n", prop: "cup" }]);
  });

  it("no invention when no matching object is within 4 cells", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "far_laptop", name: "Far laptop", description: "A laptop.",
      x: 0, y: 0, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    // n is at (4,4); the laptop is >4 cells away — no thin-air props.
    expect(
      executeManipulation(world, { actorId: "n", text: "Type on the laptop." }),
    ).toBeNull();
  });

  it("no double-hold: typing while holding a cup plans nothing", () => {
    const world = typingWorld();
    world.actors.find((a) => a.id === "n")!.prop = "cup";
    expect(
      executeManipulation(world, { actorId: "n", text: "Type on the laptop." }),
    ).toBeNull();
  });

});

// ---------------------------------------------------------------------------
// Item C5 (S2): salvage re-runs the prose gates after patch-stripping.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Item C6 (S3): narrative verb-list audit.
// ---------------------------------------------------------------------------
describe("C6 narrative verb audit", () => {
  function audit(narrative: string): string[] {
    return validateNarrativeActors(makeTinyWorld(), { narrative }).map((e) => e.message);
  }

  it("catches the experiment's prose holes", () => {
    expect(audit("Liam greets everyone on the way into the office.")[0]).toMatch(/Liam/);
    expect(audit("John takes a drink from his glass of whiskey.")[0]).toMatch(/John/);
    expect(audit("Anton leans against the desk, facing the coffee machine.")[0]).toMatch(/Anton/);
  });

  it("covers ask/tell/answer and verb-first shapes", () => {
    expect(audit("Zoe asks about the deadline.")[0]).toMatch(/Zoe/);
    expect(audit("N tells Zoe the news.")[0]).toMatch(/Zoe/);
    expect(audit("U hands the report to Zoe.")[0]).toMatch(/Zoe/);
    expect(audit("Quinn answered the question.")[0]).toMatch(/Quinn/);
  });

  it("does not flag roster actors, pronouns, or scene prose", () => {
    expect(audit("U greets N warmly.")).toEqual([]);
    expect(audit("She walks to the door.")).toEqual([]);
    expect(audit("They walk over together.")).toEqual([]);
    expect(audit("N types on the laptop.")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Item C7 (S1): action-text movement hints.
// ---------------------------------------------------------------------------
describe("C7 action-text movement hints", () => {
  it("extractDirectionHint finds cardinal directions", () => {
    expect(extractDirectionHint("Take a few steps east, then stop.")).toBe("east");
    expect(extractDirectionHint("Walk NORTH toward the windows.")).toBe("north");
    expect(extractDirectionHint("Look around the room.")).toBeNull();
  });

  it("resolveNamedDestination resolves actors and objects by word boundary", () => {
    const world = loadOfficeScenario();
    expect(resolveNamedDestination("Walk toward Ana.", world, "jeff")).toEqual({
      kind: "actor",
      id: "ana",
    });
    expect(resolveNamedDestination("Head to the coffee machine.", world, "jeff")).toEqual({
      kind: "object",
      id: "coffee_machine",
    });
    expect(resolveNamedDestination("Say hello to everyone.", world, "jeff")).toBeNull();
    // "dan" must not match a "Dana"-style name by substring.
    const tiny = makeTinyWorld();
    tiny.actors.push({
      id: "dana", name: "Dana", persona: "Dana.", x: 5, y: 5,
      state: "standing", emotion: "calm", goal: "g", thoughts: "",
      memories: [], beliefs: [], relationships: [],
    });
    expect(resolveNamedDestination("Walk toward Dana.", tiny, "u")).toEqual({
      kind: "actor",
      id: "dana",
    });
  });

  it("suggestStep steers east for 'walk east' instead of west", () => {
    const world = makeTinyWorld();
    // n at (4,4) in an empty 6x6 room.
    const s = suggestStep(world, "n", null, extractDirectionHint("Take a few steps east."));
    expect(s).not.toBeNull();
    expect(s!.x).toBeGreaterThan(4);
  });

  it("suggestStep resolves a named destination from text and never moves away", () => {
    const world = makeTinyWorld();
    // n at (4,4); Dana added at (5,5) ("U" is a single letter and never
    // resolves as a name — actorMentionVariants requires 2+ chars).
    world.actors.push({
      id: "dana", name: "Dana", persona: "Dana.", x: 5, y: 5,
      state: "standing", emotion: "calm", goal: "g", thoughts: "",
      memories: [], beliefs: [], relationships: [],
    });
    const named = resolveNamedDestination("Walk toward Dana.", world, "n");
    expect(named).toEqual({ kind: "actor", id: "dana" });
    const s = suggestStep(world, "n", { x: 5, y: 5 }, extractDirectionHint("Walk toward Dana."));
    expect(s).not.toBeNull();
    const oldDist = Math.hypot(4 - 5, 4 - 5);
    expect(Math.hypot(s!.x - 5, s!.y - 5)).toBeLessThan(oldDist);
  });

  it("explicit destination ids still win over text", () => {
    const world = makeTinyWorld();
    // Destination U (southwest) beats the east hint.
    const s = suggestStep(world, "n", { x: 1, y: 1 }, extractDirectionHint("Walk east."));
    expect(s).not.toBeNull();
    // Toward U (southwest), not east.
    expect(s!.x + s!.y).toBeLessThan(8);
  });
});

// ---------------------------------------------------------------------------
// Item C8 (S4): resumed-activity mask covers return-focus shapes.
// ---------------------------------------------------------------------------
describe("C8 resumed-activity mask", () => {
  it("hasDisplacementToken ignores return-focus/attention shapes", () => {
    expect(hasDisplacementToken("Return focus to my laptop and keep typing.")).toBe(false);
    expect(hasDisplacementToken("She returns their attention to the task.")).toBe(false);
    expect(hasDisplacementToken("Return to the task at hand.")).toBe(false);
    expect(hasDisplacementToken("Get back to my laptop.")).toBe(false);
  });

  it("real locomotion still reads as movement", () => {
    expect(hasDisplacementToken("Return to the door.")).toBe(true);
    expect(hasDisplacementToken("Walk to the door.")).toBe(true);
    expect(hasDisplacementToken("Return to my desk.")).toBe(true);
  });

  it("maskResumedActivity strips the new shapes", () => {
    expect(maskResumedActivity("She returned their attention to the task.")).not.toMatch(/return/i);
    expect(maskResumedActivity("Return focus to my laptop.")).not.toMatch(/return/i);
  });
});

// ---------------------------------------------------------------------------
// Item C9 (S5): speech.no_speech_rendered only for the actor's own utterance.
// ---------------------------------------------------------------------------
describe("C9 own-utterance detector", () => {
  it("hasOwnUtterance detects quotes and direct speech verbs", () => {
    expect(hasOwnUtterance('Say "hello everyone".')).toBe(true);
    expect(hasOwnUtterance("Nod and start explaining the task.")).toBe(true);
    expect(hasOwnUtterance("Thank both, then head to the desk.")).toBe(true);
    expect(hasOwnUtterance("Nod as I explain the task.")).toBe(true);
  });

  it("hasOwnUtterance ignores reported-speech mentions", () => {
    expect(hasOwnUtterance("keep an ear open for what Jeff says next")).toBe(false);
    expect(hasOwnUtterance("Think about what Ana said yesterday.")).toBe(false);
    expect(hasOwnUtterance("as Ana explains the layout, take notes")).toBe(false);
    expect(hasOwnUtterance("Look around the room.")).toBe(false);
  });

  it("maskReportedSpeech strips the subordinate clause", () => {
    expect(maskReportedSpeech("keep an ear open for what Jeff says next")).not.toMatch(/says/i);
  });

});

// ---------------------------------------------------------------------------
// Item C10 (S7): the single prose retry's feedback repeats the roster ids
// on unknown-actor failures (the retry loop itself is gone in Phase 4).
// ---------------------------------------------------------------------------
class ScriptedConsequenceEngine implements ConsequenceEngine {
  calls = 0;
  feedbacks: Array<string | undefined> = [];
  constructor(private readonly results: ConsequenceResult[]) {}
  async resolve(
    _world: World,
    _action: Action,
    feedback?: string,
  ): Promise<ConsequenceResult> {
    this.calls += 1;
    this.feedbacks.push(feedback);
    const r = this.results[Math.min(this.calls - 1, this.results.length - 1)]!;
    return structuredClone(r);
  }
}

describe("C10 prose retry feedback", () => {
  it("retry feedback repeats the roster ids on unknown-actor failures", async () => {
    const logger = createTestLogger();
    const engine = new ScriptedConsequenceEngine([
      { narrative: "Liam waves.", thoughts: "Hi.", reasoning: "r" },
      { narrative: "N waves.", thoughts: "Hi.", reasoning: "r" },
    ]);
    const deps = makeTestDeps(logger, {
      consequenceEngine: engine,
      config: { ...defaultConfig, autosaveEnabled: false, maxRetries: 1 },
    });
    const result = await resolveRender(
      makeTinyWorld(),
      { actorId: "n", text: "Wave." },
      deps,
    );
    expect(result.render.narrative).toBe("N waves.");
    const feedback = engine.feedbacks[1]!;
    expect(feedback).toContain("ROSTER REPEAT");
    expect(feedback).toContain('"u"');
    expect(feedback).toContain('"n"');
  });
});


// ---------------------------------------------------------------------------
// Item C12 (S8): auto-fill `state` when x/y changes without a state patch.
// ---------------------------------------------------------------------------
describe("C12 position-derived state", () => {
  function machineWorld(): World {
    const world = makeTinyWorld();
    world.scene.width = 20;
    world.scene.height = 20;
    world.scene.objects.push(
      {
        id: "coffee_machine", name: "Coffee machine", description: "A machine.",
        x: 2, y: 2, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false,
      },
      {
        id: "wall_north", name: "North wall", description: "A wall.",
        x: 0, y: 0, w: 20, h: 1, passable: false, blocksVision: true, blocksSound: true,
      },
    );
    return world;
  }

  it("describePosition names the nearest landmark within 6, else coordinates", () => {
    const world = machineWorld();
    expect(describePosition(world, 3, 3)).toBe("at the coffee machine");
    // Walls are not landmarks.
    expect(describePosition(world, 10, 0)).toBe("at (10, 0)");
    expect(describePosition(world, 19, 19)).toBe("at (19, 19)");
  });

  it("applyRenderResult derives the state label from the engine movement", () => {
    const world = machineWorld();
    const next = applyRenderResult(
      world,
      { actorId: "u", text: "Walk." },
      { narrative: "U walks to the coffee machine.", thoughts: "Coffee.", reasoning: "r" },
      {
        movement: {
          from: { x: 1, y: 1 }, x: 3, y: 3,
          path: [{ x: 2, y: 2 }, { x: 3, y: 3 }],
          destination: { kind: "object", id: "coffee_machine", x: 2, y: 2 },
        },
        pose: null,
        manipulation: null,
      },
    );
    // Phase 4: the state label is engine-derived — the model has no state
    // patch channel left.
    expect(next.actors.find((a) => a.id === "u")!.state).toBe("at the coffee machine");
  });

  it("no state change when the position does not change", () => {
    const world = machineWorld();
    const before = world.actors.find((a) => a.id === "u")!.state;
    const next = applyRenderResult(
      world,
      { actorId: "u", text: "Wait." },
      { narrative: "U waits.", thoughts: "Waiting.", reasoning: "r" },
      { movement: null, pose: null, manipulation: null },
    );
    expect(next.actors.find((a) => a.id === "u")!.state).toBe(before);
  });
});
