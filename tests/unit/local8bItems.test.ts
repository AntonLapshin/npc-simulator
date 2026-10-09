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
import { consequenceSuffix } from "../../src/llm/prompts.js";
import {
  createLlmEngines,
  userCapableTierBackend,
} from "../../src/llm/index.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { defaultConfig } from "../../src/config.js";
import { makeTinyWorld, makeTestDeps, loadOfficeScenario } from "../helpers.js";
import {
  applyConsequence,
  describePosition,
  summarizeNarrativeForMemory,
} from "../../src/engine/patchApplier.js";
import {
  countHardErrors,
  sanitizeThoughts,
  synthesizeActionNarrative,
  trySalvageConsequence,
} from "../../src/engine/turnSalvage.js";
import { validateNarrativeActors } from "../../src/engine/validate/narrative.js";
import { validateActionVerbCoverage } from "../../src/engine/validate/objects.js";
import {
  hasDisplacementToken,
  maskResumedActivity,
} from "../../src/engine/deterministicSemantics.js";
import { hasOwnUtterance, maskReportedSpeech } from "../../src/engine/validate/speech.js";
import { extractDirectionHint } from "../../src/core/text.js";
import { computeMovementOutcome, suggestStep } from "../../src/core/movement.js";
import { resolveNamedDestination } from "../../src/engine/textHints.js";
import { resolveWithValidation } from "../../src/engine/turnOrchestrator.js";

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

  it("consequenceSuffix carries the discipline line when roster ids are given", () => {
    for (const mode of ["short", "full"] as const) {
      const s = consequenceSuffix(mode, ["jeff", "ana", "dan"]);
      expect(s).toContain("ROSTER DISCIPLINE");
      expect(s).toContain('"jeff", "ana", "dan"');
      expect(s).toContain('"Anton"');
    }
  });

  it("consequenceSuffix without roster ids keeps the old text", () => {
    expect(consequenceSuffix("short")).not.toContain("ROSTER DISCIPLINE");
    expect(consequenceSuffix("full")).not.toContain("ROSTER DISCIPLINE");
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
      userCapableTierBackend(env, undefined, { proposal: new StubProvider() }),
    ).toBeUndefined();
  });

  it("a per-task consequence override does not drag the user tier down", () => {
    const env = {
      LLM_BACKEND: "ollama",
      LLM_SIMPLE_BACKEND: "laya-local",
      LLM_BACKEND_CONSEQUENCE: "laya-local",
    } as unknown as NodeJS.ProcessEnv;
    // The capable tier stays the hard-task default (ollama), not the
    // weakened per-task consequence backend.
    expect(userCapableTierBackend(env)).toBe("ollama");
  });

  it("getEnginesForTurn: NPC turns unchanged, user turns get hard-tier proposal+consequence", () => {
    const env = {
      LLM_BACKEND: "ollama",
      LLM_SIMPLE_BACKEND: "laya-local",
    } as unknown as NodeJS.ProcessEnv;
    const engines = createLlmEngines(createTestLogger(), { env });
    const npc = engines.getEnginesForTurn(false);
    expect(npc.proposal).toBe(engines.proposalEngine);
    expect(npc.selection).toBe(engines.selectionEngine);
    expect(npc.consequence).toBe(engines.consequenceEngine);
    expect(npc.judge).toBe(engines.semanticJudge);
    const user = engines.getEnginesForTurn(true);
    expect(user.proposal).not.toBe(engines.proposalEngine);
    expect(user.consequence).not.toBe(engines.consequenceEngine);
    // Selection is skipped for users anyway; the judge stays standard.
    expect(user.selection).toBe(engines.selectionEngine);
    expect(user.judge).toBe(engines.semanticJudge);
  });

  it("getEnginesForTurn falls back silently when tiers are identical", () => {
    const env = {
      LLM_BACKEND: "ollama",
      LLM_SIMPLE_BACKEND: "ollama",
    } as unknown as NodeJS.ProcessEnv;
    const engines = createLlmEngines(createTestLogger(), { env });
    const user = engines.getEnginesForTurn(true);
    expect(user.proposal).toBe(engines.proposalEngine);
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

  it("applyConsequence appends a deterministic memory when the model appends none", () => {
    const world = makeTinyWorld();
    const result: ConsequenceResult = {
      narrative: "U walks toward N.",
      actorPatches: [{ actorId: "u", thoughts: "Going." }],
      objectPatches: [],
      reasoning: "r",
    };
    const next = applyConsequence(world, result, { actorId: "u", text: "Walk toward N." });
    const u = next.actors.find((a) => a.id === "u")!;
    expect(u.memories).toContain("U: U walks toward N.");
  });

  it("skips the append when the model appended memories, on fallback, or on tail dup", () => {
    const world = makeTinyWorld();
    const withModel: ConsequenceResult = {
      narrative: "U walks toward N.",
      actorPatches: [{ actorId: "u", memoriesAppend: ["Model memory."] }],
      objectPatches: [],
      reasoning: "r",
    };
    const next = applyConsequence(world, withModel, { actorId: "u", text: "Walk." });
    expect(next.actors.find((a) => a.id === "u")!.memories).toEqual(["Model memory."]);

    const fallback: ConsequenceResult = {
      narrative: "Nothing changes.",
      actorPatches: [],
      objectPatches: [],
      reasoning: "r",
    };
    const nextFallback = applyConsequence(world, fallback, { actorId: "u", text: "Walk." }, defaultConfig, {
      fallback: true,
    });
    expect(nextFallback.actors.find((a) => a.id === "u")!.memories).toEqual([]);

    const dupWorld = makeTinyWorld();
    dupWorld.actors.find((a) => a.id === "u")!.memories = ["U: U walks toward N."];
    const dup: ConsequenceResult = {
      narrative: "U walks toward N.",
      actorPatches: [{ actorId: "u", thoughts: "Again." }],
      objectPatches: [],
      reasoning: "r",
    };
    const nextDup = applyConsequence(dupWorld, dup, { actorId: "u", text: "Walk." });
    expect(nextDup.actors.find((a) => a.id === "u")!.memories).toEqual(["U: U walks toward N."]);
  });
});

// ---------------------------------------------------------------------------
// Items C4/C11: prop auto-hints + deterministic prop stubs + scenario props.
// ---------------------------------------------------------------------------
describe("C4/C11 prop support", () => {
  it("consequenceSuffix carries prop auto-hint examples", () => {
    for (const mode of ["short", "full"] as const) {
      const s = consequenceSuffix(mode, ["ana"]);
      expect(s).toContain("PROP AUTO-HINTS");
      expect(s).toContain('prop:"laptop"');
      expect(s).toContain('prop:"cup"');
    }
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

  it("salvage stubs prop:laptop for typing near a laptop", () => {
    const world = typingWorld();
    const out = trySalvageConsequence(
      world,
      { actorId: "n", text: "Sit down and type on the laptop." },
      {
        narrative: "N types on the laptop.",
        actorPatches: [{ actorId: "n", pose: "sit", thoughts: "Working." }],
        objectPatches: [],
        reasoning: "r",
      },
      { moves: false, speaks: false, quotedSpeech: [] },
      createTestLogger(),
    );
    expect(out).not.toBeNull();
    expect(out!.salvaged.actorPatches.find((p) => p.actorId === "n")!.prop).toBe("laptop");
    expect(out!.warnings).toEqual([]);
  });

  it("salvage stubs prop:cup for grab+mug near a mug", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "n_mug", name: "N's mug", description: "A mug.",
      x: 4, y: 5, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    const out = trySalvageConsequence(
      world,
      { actorId: "n", text: "Grab the mug from the desk." },
      {
        narrative: "N grabs the mug.",
        actorPatches: [{ actorId: "n", thoughts: "Coffee time." }],
        objectPatches: [],
        reasoning: "r",
      },
      { moves: false, speaks: false, quotedSpeech: [] },
      createTestLogger(),
    );
    expect(out).not.toBeNull();
    expect(out!.salvaged.actorPatches.find((p) => p.actorId === "n")!.prop).toBe("cup");
  });

  it("no stub when no matching object is within 4 cells", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "far_laptop", name: "Far laptop", description: "A laptop.",
      x: 0, y: 0, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    // n is at (4,4); the laptop is >4 cells away — no invention.
    const out = trySalvageConsequence(
      world,
      { actorId: "n", text: "Type on the laptop." },
      {
        narrative: "N types on the laptop.",
        actorPatches: [{ actorId: "n", thoughts: "Working." }],
        objectPatches: [],
        reasoning: "r",
      },
      { moves: false, speaks: false, quotedSpeech: [] },
      createTestLogger(),
    );
    expect(out).not.toBeNull();
    expect(out!.salvaged.actorPatches.find((p) => p.actorId === "n")!.prop).toBeUndefined();
    // The wording miss downgrades to a warning instead (tier-2 behavior).
    expect(out!.warnings.some((w) => w.code === "object_grounding.sip_no_prop")).toBe(true);
  });

  it("no stub when the actor already holds something", () => {
    const world = typingWorld();
    world.actors.find((a) => a.id === "n")!.prop = "cup";
    const out = trySalvageConsequence(
      world,
      { actorId: "n", text: "Type on the laptop." },
      {
        narrative: "N types on the laptop.",
        actorPatches: [{ actorId: "n", thoughts: "Working." }],
        objectPatches: [],
        reasoning: "r",
      },
      { moves: false, speaks: false, quotedSpeech: [] },
      createTestLogger(),
    );
    expect(out).not.toBeNull();
    // No prop override — already holding the cup.
    expect(out!.salvaged.actorPatches.find((p) => p.actorId === "n")!.prop).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Item C5 (S2): salvage re-runs the prose gates after patch-stripping.
// ---------------------------------------------------------------------------
describe("C5 salvage prose re-gating", () => {
  it("synthesizeActionNarrative builds action-derived prose", () => {
    expect(synthesizeActionNarrative({ actorId: "n", text: "Walk toward U and greet everyone." }, "N")).toBe(
      "N: Walk toward U and greet everyone.",
    );
    expect(
      synthesizeActionNarrative({ actorId: "n", text: 'Say "hello there" loudly.' }, "N"),
    ).toBe('N says "hello there"');
    const long = `N ${"walks ".repeat(80)}east.`;
    expect(synthesizeActionNarrative({ actorId: "n", text: long }, "N").length).toBeLessThanOrEqual(270);
  });

  it("sanitizeThoughts replaces thoughts naming non-roster actors", () => {
    const world = makeTinyWorld();
    expect(sanitizeThoughts("Another day, same Liam.", world)).toBe(
      "Staying focused on what's in front of me.",
    );
    expect(sanitizeThoughts("Wonder what U is doing.", world)).toBe("Wonder what U is doing.");
    expect(sanitizeThoughts(undefined, world)).toBeUndefined();
  });

  it("countHardErrors ignores speech nits", () => {
    expect(
      countHardErrors([
        { code: "speech.dropped_words", message: "x" },
        { code: "speech.no_speech_rendered", message: "y" },
      ]),
    ).toBe(0);
    expect(
      countHardErrors([
        { code: "speech.dropped_words", message: "x" },
        { code: "narrative.unknown_actor", message: "y" },
      ]),
    ).toBe(1);
    expect(countHardErrors([])).toBe(0);
  });

  it("trySalvageConsequence synthesizes prose instead of keeping hallucinations", () => {
    const world = makeTinyWorld();
    const out = trySalvageConsequence(
      world,
      { actorId: "n", text: "Greet everyone on the way into the office." },
      {
        narrative: "Liam greets everyone on the way into the office.",
        actorPatches: [{ actorId: "n", thoughts: "Another day, same Liam." }],
        objectPatches: [],
        reasoning: "r",
      },
      { moves: false, speaks: false, quotedSpeech: [] },
      createTestLogger(),
    );
    expect(out).not.toBeNull();
    expect(out!.salvaged.narrative).toBe("N: Greet everyone on the way into the office.");
    expect(out!.salvaged.narrative).not.toContain("Liam");
    // The implanted false memory is gone too.
    expect(out!.salvaged.actorPatches.find((p) => p.actorId === "n")!.thoughts).toBe(
      "Staying focused on what's in front of me.",
    );
  });

  it("observer-as-subject prose is synthesized, not kept", () => {
    const world = makeTinyWorld();
    const [u, n] = world.actors;
    u!.id = "ursula";
    u!.name = "Ursula";
    n!.id = "ned";
    n!.name = "Ned";
    world.order = ["ursula", "ned"];
    world.userActorId = "ursula";
    const out = trySalvageConsequence(
      world,
      { actorId: "ned", text: "Wave at Ursula." },
      {
        narrative: "Ursula waves back cheerfully.",
        actorPatches: [{ actorId: "ned", thoughts: "Friendly." }],
        objectPatches: [],
        reasoning: "r",
      },
      { moves: false, speaks: false, quotedSpeech: [] },
      createTestLogger(),
    );
    expect(out).not.toBeNull();
    expect(out!.salvaged.narrative).toBe("Ned: Wave at Ursula.");
  });
});

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

  it("the gate no longer fires on reported speech, still fires on dropped utterances", () => {
    const world = makeTinyWorld();
    const norm = (narrative: string) => ({ narrative, actorPatches: [], objectPatches: [] });
    const reported = validateActionVerbCoverage(
      world,
      { actorId: "n", text: "Keep an ear open for what U says next." },
      norm("N keeps typing quietly."),
    );
    expect(reported.some((e) => e.code === "speech.no_speech_rendered")).toBe(false);

    const dropped = validateActionVerbCoverage(
      world,
      { actorId: "n", text: "Thank both, then head to the desk." },
      norm("N looks around."),
    );
    expect(dropped.some((e) => e.code === "speech.no_speech_rendered")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item C10 (S7): salvage the best attempt; abort retries on error growth.
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

function movingEffects(): ConsequenceResult["effects"] {
  return { moved: true, destinationActorId: "u", spoke: false, quotedSpeech: [] };
}

describe("C10 best-attempt salvage and early abort", () => {
  it("salvages the attempt with the fewest hard errors and aborts on growth", async () => {
    const logger = createTestLogger();
    // u at (1,1), n at (4,4). Hard-error counts: 1, 2, 3 — two consecutive
    // growths must abort the loop at 3 calls (not maxRetries+1 = 6).
    const engine = new ScriptedConsequenceEngine([
      {
        // Attempt 1: one hard error (unknown actor in prose); the movement
        // itself is a valid step toward u.
        narrative: "Liam greets everyone on the way over.",
        actorPatches: [{ actorId: "n", x: 3, y: 3, thoughts: "Going to say hi." }],
        objectPatches: [],
        reasoning: "r",
        effects: movingEffects(),
      },
      {
        // Attempt 2: unknown actor + moves AWAY from u.
        narrative: "Liam greets Tanya on the way over.",
        actorPatches: [{ actorId: "n", x: 5, y: 5, thoughts: "Going." }],
        objectPatches: [],
        reasoning: "r",
        effects: movingEffects(),
      },
      {
        // Attempt 3: unknown actor + away-move + observer teleport.
        narrative: "Liam greets Tanya while John watches.",
        actorPatches: [
          { actorId: "n", x: 5, y: 5, thoughts: "Going." },
          { actorId: "u", x: 2, y: 2, thoughts: "Huh." },
        ],
        objectPatches: [],
        reasoning: "r",
        effects: movingEffects(),
      },
    ]);
    const deps = makeTestDeps(logger, {
      consequenceEngine: engine,
      // Exp-7: the default outer cap is 2 — this RULE-C test needs the
      // headroom it was written for, so raise it explicitly.
      config: { ...defaultConfig, autosaveEnabled: false, maxRetries: 5, consequenceMaxAttempts: 6 },
    });
    const action: Action = { actorId: "n", text: "Walk toward U and greet everyone." };
    const salvaged = await resolveWithValidation(makeTinyWorld(), action, deps);

    expect(engine.calls).toBe(3);
    expect(logger.store.events()).toContain("retry_aborted");
    // Salvaged from attempt 1 (fewest hard errors): prose synthesized from
    // the action text, attempt-1's engine movement kept. Phase 1: the
    // model's (3,3) is ignored — the engine steps n toward u itself.
    expect(salvaged.narrative).toBe("N: Walk toward U and greet everyone.");
    expect(salvaged.narrative).not.toContain("Liam");
    const nPatch = salvaged.actorPatches.find((p) => p.actorId === "n")!;
    const expected = computeMovementOutcome(makeTinyWorld(), "n", { destinationActorId: "u" }, null)!;
    expect([nPatch.x, nPatch.y]).toEqual([expected.x, expected.y]);
  });

  it("retry feedback repeats the roster ids on unknown-actor failures", async () => {
    const logger = createTestLogger();
    const engine = new ScriptedConsequenceEngine([
      {
        narrative: "Liam waves.",
        actorPatches: [{ actorId: "n", thoughts: "Hi." }],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: false, spoke: false, quotedSpeech: [] },
      },
      {
        narrative: "N waves.",
        actorPatches: [{ actorId: "n", thoughts: "Hi." }],
        objectPatches: [],
        reasoning: "r",
        effects: { moved: false, spoke: false, quotedSpeech: [] },
      },
    ]);
    const deps = makeTestDeps(logger, {
      consequenceEngine: engine,
      config: { ...defaultConfig, autosaveEnabled: false, maxRetries: 1 },
    });
    const result = await resolveWithValidation(
      makeTinyWorld(),
      { actorId: "n", text: "Wave." },
      deps,
    );
    expect(result.narrative).toBe("N waves.");
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

  it("applyConsequence auto-fills state on a move without a state patch", () => {
    const world = machineWorld();
    const result: ConsequenceResult = {
      narrative: "U walks to the coffee machine.",
      actorPatches: [{ actorId: "u", x: 3, y: 3, thoughts: "Coffee." }],
      objectPatches: [],
      reasoning: "r",
    };
    const next = applyConsequence(world, result, { actorId: "u", text: "Walk." });
    expect(next.actors.find((a) => a.id === "u")!.state).toBe("at the coffee machine");
  });

  it("an explicit state patch still wins", () => {
    const world = machineWorld();
    const result: ConsequenceResult = {
      narrative: "U walks to the coffee machine.",
      actorPatches: [{ actorId: "u", x: 3, y: 3, state: "standing by the machine, waiting" }],
      objectPatches: [],
      reasoning: "r",
    };
    const next = applyConsequence(world, result, { actorId: "u", text: "Walk." });
    expect(next.actors.find((a) => a.id === "u")!.state).toBe("standing by the machine, waiting");
  });

  it("no auto-fill when the position does not change", () => {
    const world = machineWorld();
    const before = world.actors.find((a) => a.id === "u")!.state;
    const result: ConsequenceResult = {
      narrative: "U waits.",
      actorPatches: [{ actorId: "u", x: 1, y: 1, thoughts: "Waiting." }],
      objectPatches: [],
      reasoning: "r",
    };
    const next = applyConsequence(world, result, { actorId: "u", text: "Wait." });
    expect(next.actors.find((a) => a.id === "u")!.state).toBe(before);
  });
});
