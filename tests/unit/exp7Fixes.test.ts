// Regression tests for Experiment-7 action items, implemented on the
// exp7-fixes branch (office-anton.json, autonomous, local qwen3:14b).
//
// A1  VRAM-contention check in diagnose:ai (+ --device passthrough in the
//     laya serve scripts) — script-level, covered by manual verification.
// A2  diagnose-ai.ts stray brace — the script runs (regression: it crashed
//     with an esbuild TransformError before the fix).
// A3  probe:think script — run on hardware (npm run probe:think).
// A4  ECHO-BAN line present in both consequence suffix modes.
// A5  Anti-echo: the preceding turn's narrative is dropped from the
//     consequence history window.
// A6  Pronouns: explicit actor.pronouns in prompts + validator check.
// A7  Stationary-work verbs no longer demand x/y patches.
// A8  (covered by A7 + the existing prop-stub repair path)
// A9  Plain-language history notes (codes stay in log records).
// A10 Output sanitization (sentinel/control codes stripped at display).
// A11 Consequence temperature 0.5 in .env.example — config surface only.
// A12 Save filenames carry the scenario file stem.
// A13 --auto per-turn timing/ETA — UI surface, covered by manual runs.
// A14 intent_cluster_banned + selection_substituted regression (tick 10).
// T4  turn_completed logged with the turn's own tick.
import { describe, expect, it } from "vitest";
import { NOT_DONE_SENTINEL } from "../../src/types.js";
import { sanitizeDisplayText } from "../../src/util/sanitize.js";
import { plainLanguageNote } from "../../src/engine/turnSalvage.js";
import { hasStationaryWorkToken } from "../../src/engine/deterministicSemantics.js";
import { resolveActionSemantics } from "../../src/engine/actionSemantics.js";
import { validateNarrativePronouns, validateStatePronouns } from "../../src/engine/validate/narrative.js";
import { validateConsequence } from "../../src/engine/physicalValidator.js";
import {
  resolveWithValidation,
  runTurn,
} from "../../src/engine/turnOrchestrator.js";
import { defaultConfig } from "../../src/config.js";
import { ECHO_BAN_LINE, consequenceSuffix } from "../../src/llm/prompts.js";
import { buildConsequenceContext } from "../../src/engine/contextBuilder.js";
import { historyEntryText } from "../../src/logging/storyTrace.js";
import { scenarioStemOf } from "../../src/ui/text/textUi.js";
import { Logger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld, hist, triedHist } from "../helpers.js";
import type { Action, ConsequenceResult, World } from "../../src/types.js";

function pronWorld(): World {
  const world = makeTinyWorld();
  const dana = world.actors.find((a) => a.id === "n")!;
  dana.id = "dana";
  dana.name = "Dana";
  dana.pronouns = "he/him";
  dana.persona = "Dana is a tech recruiter.";
  world.order = ["u", "dana"];
  world.userActorId = "u";
  return world;
}

describe("exp7 A10: sanitizeDisplayText", () => {
  it("strips the NOT_DONE_SENTINEL (T3 garbage codepoint)", () => {
    expect(sanitizeDisplayText(`Anton tried: walk (not done)${NOT_DONE_SENTINEL}`)).toBe(
      "Anton tried: walk (not done)",
    );
  });

  it("strips control codes but keeps newlines and tabs", () => {
    const withControls = "a" + String.fromCharCode(0x00) + "b" + String.fromCharCode(0x07) + "c";
    expect(sanitizeDisplayText(withControls)).toBe("abc");
    expect(sanitizeDisplayText("a\nb\tc")).toBe("a\nb\tc");
  });

  it("leaves normal text untouched", () => {
    const t = "Dana says, \"Morning!\" — waving.";
    expect(sanitizeDisplayText(t)).toBe(t);
  });

  it("historyEntryText never leaks the sentinel to display", () => {
    const world = makeTinyWorld();
    const entry = triedHist(world, "N tried: Walk over.");
    expect(entry.text).toContain(NOT_DONE_SENTINEL);
    expect(historyEntryText(entry)).not.toContain(NOT_DONE_SENTINEL);
    expect(historyEntryText(entry)).toContain("(not done)");
  });
});

describe("exp7 A9: plainLanguageNote", () => {
  it("maps validator codes to plain phrases", () => {
    expect(
      plainLanguageNote([{ code: "speech.invented_dialogue", message: "x" }]),
    ).toBe("partial — some dialogue was improvised");
    expect(plainLanguageNote([])).toBe("partial");
  });

  it("dedupes and joins multiple categories", () => {
    const note = plainLanguageNote([
      { code: "speech.invented_dialogue", message: "x" },
      { code: "movement.no_position_change", message: "y" },
      { code: "speech.dropped_words", message: "z" },
    ]);
    expect(note).toBe("partial — some dialogue was improvised; the movement didn't fully happen");
  });

  it("gives the quote-reinsertion salvage a speech-shaped phrase", () => {
    expect(plainLanguageNote([{ code: "salvage.quote_reinserted", message: "x" }])).toBe(
      "partial — dropped dialogue was restored",
    );
  });
});

describe("exp7 A7: stationary-work verbs", () => {
  it("detects typing/staring/sipping-class verbs", () => {
    expect(hasStationaryWorkToken("Dana types furiously on his laptop.")).toBe(true);
    expect(hasStationaryWorkToken("Dana stares blankly at his monitor.")).toBe(true);
    expect(hasStationaryWorkToken("She sips her coffee.")).toBe(true);
  });

  it("does not fire for locomotion", () => {
    expect(hasStationaryWorkToken("Walk to Tanya's desk.")).toBe(false);
    expect(hasStationaryWorkToken("Say hello.")).toBe(false);
  });

  it("downgrades a model-hallucinated moves=true on stationary work (B7)", async () => {
    const world = pronWorld();
    const action: Action = { actorId: "dana", text: "Dana types furiously on his laptop." };
    const result: ConsequenceResult = {
      narrative: "Dana types furiously on his laptop.",
      actorPatches: [],
      objectPatches: [],
      effects: { moved: true, spoke: false, quotedSpeech: [] },
      reasoning: "r",
    };
    const resolved = await resolveActionSemantics(world, action, result, undefined);
    expect(resolved.semantics?.moves).toBe(false);
  });

  it("keeps moves=true when a displacement token is present (walk-then-type)", async () => {
    const world = pronWorld();
    const action: Action = { actorId: "dana", text: "Dana walks to his desk and types up the report." };
    const result: ConsequenceResult = {
      narrative: "Dana walks to his desk and types up the report.",
      actorPatches: [{ actorId: "dana", x: 3, y: 3, thoughts: "t" }],
      objectPatches: [],
      effects: { moved: true, spoke: false, quotedSpeech: [] },
      reasoning: "r",
    };
    const resolved = await resolveActionSemantics(world, action, result, undefined);
    expect(resolved.semantics?.moves).toBe(true);
  });
});

describe("exp7 A6: pronouns", () => {
  it("flags she/her prose for a he/him actor (B5)", () => {
    const world = pronWorld();
    const action: Action = { actorId: "dana", text: "Dana sits down." };
    const errors = validateNarrativePronouns(world, "Dana sits at her desk, and she sighs.", action);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("narrative.pronoun_mismatch");
  });

  it("ignores pronouns inside quoted speech", () => {
    const world = pronWorld();
    const action: Action = { actorId: "dana", text: "Dana speaks." };
    const errors = validateNarrativePronouns(world, "Dana says, \"She told me about the role.\"", action);
    expect(errors).toHaveLength(0);
  });

  it("does not flag pronouns referring to another named actor", () => {
    const world = pronWorld();
    world.actors.push({
      id: "tanya",
      name: "Tanya",
      persona: "QA engineer.",
      pronouns: "she/her",
      x: 8,
      y: 7,
      state: "sitting",
      emotion: "calm",
      goal: "Work.",
      thoughts: "",
      memories: [],
      beliefs: [],
      relationships: [],
    });
    const action: Action = { actorId: "dana", text: "Dana approaches Tanya." };
    const errors = validateNarrativePronouns(
      world,
      "Dana approaches Tanya's desk and greets her.",
      action,
    );
    expect(errors).toHaveLength(0);
  });

  it("still flags the exp-7 B5 shape: 'holding her laptop as she says'", () => {
    const world = pronWorld();
    const action: Action = { actorId: "dana", text: "Dana walks." };
    const errors = validateNarrativePronouns(
      world,
      "Dana walks toward the door, holding her laptop as she says, \"One moment.\"",
      action,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("narrative.pronoun_mismatch");
  });

  it("flags the exp-7 tick-8 shape: plagiarized state string (state.pronoun_mismatch)", () => {
    const world = pronWorld();
    const errors = validateStatePronouns(
      world,
      "dana",
      "sitting at her desk and working on a laptop",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("state.pronoun_mismatch");
    expect(validateStatePronouns(world, "dana", "sitting at his desk")).toHaveLength(0);
  });

  it("is opt-in: no pronouns set, no check", () => {
    const world = makeTinyWorld();
    const action: Action = { actorId: "n", text: "N sits down." };
    expect(validateNarrativePronouns(world, "N sits at her desk.", action)).toHaveLength(0);
  });

  it("passes he/him prose for a he/him actor", () => {
    const world = pronWorld();
    const action: Action = { actorId: "dana", text: "Dana sits down." };
    expect(validateNarrativePronouns(world, "Dana walks to his desk.", action)).toHaveLength(0);
  });

  it("surfaces through validateConsequence", () => {
    const world = pronWorld();
    const action: Action = { actorId: "dana", text: "Dana nods." };
    const result: ConsequenceResult = {
      narrative: "Dana nods, and she smiles.",
      actorPatches: [{ actorId: "dana", thoughts: "t" }],
      objectPatches: [],
      reasoning: "r",
    };
    const errors = validateConsequence(world, result, action, undefined);
    expect(errors.errors.some((e) => e.code === "narrative.pronoun_mismatch")).toBe(true);
  });
});

describe("exp7 structural: consequence retry cap", () => {
  it("defaults to 2 outer attempts", () => {
    expect(defaultConfig.consequenceMaxAttempts).toBe(2);
  });

  it("burns at most 2 consequence resolves on an always-invalid engine", async () => {
    const logger = new Logger({ sessionId: "exp7-cap", writeToFile: false });
    const world = makeTinyWorld();
    const bad: ConsequenceResult = {
      narrative: "Nope.",
      actorPatches: [{ actorId: "ghost", thoughts: "x" }],
      objectPatches: [],
      reasoning: "r",
    };
    let calls = 0;
    const deps = makeTestDeps(logger, {
      consequenceEngine: {
        resolve: async () => {
          calls++;
          return structuredClone(bad);
        },
      } as never,
    });
    await resolveWithValidation(world, { actorId: "n", text: "Wave." }, deps);
    expect(calls).toBe(2);
  });
});

describe("exp7 A4/A5: echo hardening in the consequence prompt", () => {
  it("ECHO-BAN ships in both suffix modes", () => {
    expect(ECHO_BAN_LINE).toContain("BAD");
    expect(consequenceSuffix("short")).toContain("ECHO-BAN");
    expect(consequenceSuffix("full")).toContain("ECHO-BAN");
  });

  it("the preceding turn's narrative is excluded from the consequence history window", () => {
    const world = makeTinyWorld();
    world.history.push(
      hist(world, "U: Hello there."),
      hist(world, "N: Morning, everyone — first day, be gentle."),
    );
    const ctx = buildConsequenceContext(world, { actorId: "n", text: "Wave." }, undefined);
    expect(ctx).not.toContain("first day, be gentle");
    expect(ctx).toContain("Hello there.");
  });
});

describe("exp7 A12: scenario-stem save naming", () => {
  it("derives the stem from the scenario path", () => {
    expect(scenarioStemOf("scenarios/office-anton.json")).toBe("office-anton");
    expect(scenarioStemOf("/tmp/x.json")).toBe("x");
  });
});

describe("exp7 A14: intent-cluster ban regression (tick 10)", () => {
  it("cluster-banned pick is substituted without burning consequence attempts", async () => {
    const logger = new Logger({ sessionId: "exp7-ban", writeToFile: false });
    const world = makeTinyWorld();
    const [anton, tanya] = world.actors;
    anton!.id = "anton";
    anton!.name = "Anton";
    tanya!.id = "tanya";
    tanya!.name = "Tanya";
    world.order = ["anton", "tanya"];
    world.userActorId = "anton";
    world.turnIndex = 1; // tanya's turn
    // Two consecutive own fallbacks on the desk cluster, different intent
    // keys (move|anton vs move|desk) — the exp-7 tick-10 shape: the intent
    // ban does NOT fire, the cluster ban must.
    world.history.push(
      triedHist(world, "Tanya tried: Walk over to Anton's desk to greet him."),
      triedHist(world, "Tanya tried: Head to the desk and set up the laptop."),
    );
    const { MockProposalEngine } = await import("../../src/mocks/mockProposalEngine.js");
    const { MockSelectionEngine } = await import("../../src/mocks/mockSelectionEngine.js");
    const { MockConsequenceEngine } = await import("../../src/mocks/mockConsequenceEngine.js");
    const deps = makeTestDeps(logger, {
      proposalEngine: new MockProposalEngine(logger, {
        "tanya@tick0": {
          suggestions: [
            "Approach the desk to check the setup.",
            "Pause and review the test plan quietly.",
          ],
          reasoning: "scripted",
        },
      }),
      selectionEngine: new MockSelectionEngine(logger, {
        "tanya@tick0": { action: "Approach the desk to check the setup.", reasoning: "scripted" },
      }),
      consequenceEngine: new MockConsequenceEngine(logger),
    });
    await runTurn(world, deps);
    expect(logger.store.byEvent("intent_banned")).toHaveLength(0);
    expect(logger.store.byEvent("intent_cluster_banned")).toHaveLength(1);
    const substituted = logger.store.byEvent("selection_substituted");
    expect(substituted).toHaveLength(1);
    expect(substituted[0]!.output).toMatchObject({
      action: "Pause and review the test plan quietly.",
    });
    const chosen = logger.store.byEvent("action_chosen");
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.output).toMatchObject({
      text: "Pause and review the test plan quietly.",
    });
  });
});

describe("exp7 T4: turn_completed tick", () => {
  it("logs the completed turn's own tick, not the next tick", async () => {
    const logger = new Logger({ sessionId: "exp7-t4", writeToFile: false });
    const world = makeTinyWorld();
    world.userActorId = "u";
    const deps = makeTestDeps(logger, {
      getUserAction: async () => "Wave.",
      config: { ...makeTestDeps(logger).config!, maxRetries: 0, autosaveEnabled: false },
    });
    const tickBefore = world.tick;
    await runTurn(world, deps);
    const completed = logger.store.byEvent("turn_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.tick).toBe(tickBefore);
  });
});
