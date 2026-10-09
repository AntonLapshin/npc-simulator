// Regression tests for Experiment-6 action items implemented on the
// exp6-fixes branch.
//
// Model-side:
// Item 1 (M1): the greeting-stub attractor — "<Name> greets the office."
//   no longer appears as the consequence example; the STUB-BAN line names
//   the attractor shape explicitly.
// Item 2 (S3): user-turn directive — the consequence engine leads with
//   USER_TURN_DIRECTIVE when opts.isUserTurn is set (the player's words
//   are ground truth, not a suggestion).
// Item 3 (S2): thinking-model control — isThinkingModel detects qwen3*;
//   OllamaProvider sends think:false when configured; hosted gateways
//   never receive the flag.
// Item 4 (M5/S6): renderability-matched proposals — contact/use verbs
//   that cannot be grounded are filtered before selection.
//
// Simulation-side:
// Item 5 (S2): thinking-aware budgets — isTruncationAtBudget detects the
//   tick-4 shape (completionTokens == maxTokens); the budget raise caps
//   at MAX_RAISED_BUDGET.
// Item 6 (S1): model-aware timeouts — explicit LLM_TIMEOUT_MS wins;
//   otherwise the default derives from the recorded per-model latency
//   (4x median, clamped 60s..600s).
// Item 7 (S4): accept-path gates — stranger labels for known coworkers
//   (tick-10 repro) and invented cross-actor contact on description
//   patches (tick-13 coffee-stain repro) reject on recheckAcceptedProse.
// Item 8 (M8): user-turn fallback voice — "Anton tried: I turn…" is
//   rewritten to third person (quoted speech preserved).
// Item 9 (S7): cluster-normalized ban keys — "move dana_papers…" and
//   "shifts the dana_papers…" core to the same adjust|papers key, while
//   locomotion keeps move|tanya.
// Item 10 (S5): cell-verified state labels — "at Tanya's chair" requires
//   pose sit AND the actor on/against the chair cell.
// Item 11 (S8): RULE-C early abort — growing hard-error tails abort
//   (pure shouldAbortRetries).
// Item 12 (S6): typing→laptop prop stub requires a nearby laptop object.
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSuffix, STUB_BAN_LINE } from "../../src/llm/prompts.js";
import { LLMConsequenceEngine } from "../../src/llm/llmConsequenceEngine.js";
import {
  isThinkingModel,
  JoinGonkaProvider,
  OllamaProvider,
  defaultTimeoutMsFor,
  readModelLatencyMs,
  recordModelLatencyMs,
  latencyCachePath,
} from "../../src/llm/index.js";
import { isTruncationAtBudget, MAX_RAISED_BUDGET } from "../../src/llm/complete.js";
import type { LLMProvider } from "../../src/llm/index.js";
import { createTestLogger } from "../../src/logging/logger.js";
import {
  thirdPersonFallbackText,
  validateRelationshipLabel,
} from "../../src/engine/validate/narrative.js";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import { suggestionCore } from "../../src/engine/contextBuilder.js";
import { describePosition } from "../../src/engine/patchApplier.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import type { Action, ConsequenceResult, World } from "../../src/types.js";

function officeWorld(): World {
  return loadScenario({
    version: 1,
    id: "office-exp6-test",
    title: "Office",
    narrative: "An office.",
    userActorId: "anton",
    order: ["anton", "tanya", "dana"],
    scene: {
      width: 20,
      height: 20,
      objects: [
        {
          id: "coffee_machine", name: "Coffee machine", description: "Coffee.",
          x: 2, y: 1, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
        },
        {
          id: "tanya_chair", name: "Tanya's chair", description: "A chair.",
          x: 8, y: 7, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
        },
        {
          id: "tanya_papers", name: "Tanya's papers", description: "Papers.",
          x: 7, y: 9, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
        },
        {
          id: "dana_laptop", name: "Dana's laptop", description: "A laptop.",
          x: 15, y: 11, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
        },
      ],
    },
    actors: [
      {
        id: "anton", name: "Anton", persona: "New backend hire.", x: 3, y: 3,
        state: "standing", emotion: "nervous", pose: "stand",
        goal: "Settle in.", memories: [], beliefs: [],
        relationships: [
          "Anton knows Tanya from working together at Sixt and trusts her.",
          "Anton has not met Dana yet.",
        ],
      },
      {
        id: "tanya", name: "Tanya", persona: "QA engineer.", x: 8, y: 6,
        state: "standing", emotion: "focused", pose: "stand",
        goal: "Finish testing.", memories: [], beliefs: [],
        relationships: [
          "Tanya knows Dana as a coworker.",
          "Tanya knows Anton from Sixt and referred him for this job.",
        ],
      },
      {
        id: "dana", name: "Dana", persona: "Recruiter.", x: 15, y: 11,
        state: "sitting at his desk", emotion: "stressed", pose: "sit",
        goal: "Screen candidates.", memories: [], beliefs: [],
        relationships: [
          "Dana knows Tanya as a coworker.",
          "Dana has not met Anton yet.",
        ],
      },
    ],
  });
}

const action = (actorId: string, text: string): Action => ({ actorId, text });

describe("exp-6 item 1: greeting-stub attractor", () => {
  it("no longer uses 'greets the office' as the example narrative", () => {
    const s = renderSuffix(["anton", "tanya"]);
    // The STUB-BAN negative example quotes the attractor by design;
    // the *positive* example must not be the copyable greeting shape.
    expect(s).not.toContain('narrative": "Anton greets the office.');
    expect(s).not.toMatch(/"narrative": "[A-Za-z]+ greets the office\."/);
  });

  it("names the attractor shape in a STUB-BAN line", () => {
    expect(STUB_BAN_LINE).toContain("greets the office");
    expect(renderSuffix(["anton"])).toContain("STUB-BAN");
  });

  it("the render prompt demands verbatim quotes (SPEECH IS ENGINE-OWNED)", () => {
    const s = renderSuffix(["anton", "tanya"]);
    expect(s).toContain("SPEECH IS ENGINE-OWNED");
    expect(s).toMatch(/character-for-character/i);
  });
});

describe("exp-6 item 2: user-turn directive", () => {
  const validJson = JSON.stringify({
    narrative: "Anton waves.",
    thoughts: "Hi.",
    reasoning: "test",
  });

  function capturingEngine(): { engine: LLMConsequenceEngine; prompts: string[] } {
    const prompts: string[] = [];
    const provider: LLMProvider = {
      name: "stub",
      complete: async (_sys: string, user: string) => {
        prompts.push(user);
        return validJson;
      },
    };
    return { engine: new LLMConsequenceEngine(createTestLogger(), provider), prompts };
  }

  it("leads the prompt with USER_TURN_DIRECTIVE on user turns", async () => {
    const { engine, prompts } = capturingEngine();
    const world = officeWorld();
    await engine.resolve(world, action("anton", "I wave hello."), undefined, {
      isUserTurn: true,
    });
    expect(prompts.length).toBe(1);
    expect(prompts[0]!.startsWith(LLMConsequenceEngine.V2_USER_TURN_DIRECTIVE)).toBe(true);
  });

  it("omits the directive on NPC turns", async () => {
    const { engine, prompts } = capturingEngine();
    const world = officeWorld();
    await engine.resolve(world, action("tanya", "Tanya waves."), undefined, {
      isUserTurn: false,
    });
    expect(prompts.length).toBe(1);
    expect(prompts[0]!.includes("USER TURN")).toBe(false);
  });
});

describe("exp-6 item 3: thinking-model control", () => {
  it("detects thinking-class models", () => {
    expect(isThinkingModel("qwen3:14b")).toBe(true);
    expect(isThinkingModel("qwq:32b")).toBe(true);
    expect(isThinkingModel("deepseek-r1:8b")).toBe(true);
    expect(isThinkingModel("fluffy/l3-8b-stheno-v3.2")).toBe(false);
    expect(isThinkingModel("huihui_ai/llama3.2-abliterate:3b")).toBe(false);
  });

  it("OllamaProvider sends think:false when configured", async () => {
    const bodies: unknown[] = [];
    const provider = new OllamaProvider({
      model: "qwen3:14b",
      think: false,
      fetchImpl: (async (_url: unknown, init: unknown) => {
        bodies.push(JSON.parse((init as { body: string }).body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        };
      }) as typeof fetch,
    });
    await provider.complete("sys", "user");
    expect(bodies.length).toBe(1);
    expect((bodies[0] as Record<string, unknown>)["think"]).toBe(false);
  });

  it("OllamaProvider omits think when unset (model default)", async () => {
    const bodies: unknown[] = [];
    const provider = new OllamaProvider({
      model: "qwen3:14b",
      fetchImpl: (async (_url: unknown, init: unknown) => {
        bodies.push(JSON.parse((init as { body: string }).body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        };
      }) as typeof fetch,
    });
    await provider.complete("sys", "user");
    expect("think" in (bodies[0] as Record<string, unknown>)).toBe(false);
  });

  it("hosted gateways never receive the think flag", async () => {
    const bodies: unknown[] = [];
    const provider = new JoinGonkaProvider({
      apiKey: "gk-test",
      model: "zai-org/GLM-5.3-Flash",
      // @ts-expect-error — JoinGonka options intentionally lack `think`
      think: false,
      fetchImpl: (async (_url: unknown, init: unknown) => {
        bodies.push(JSON.parse((init as { body: string }).body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        };
      }) as typeof fetch,
    });
    await provider.complete("sys", "user");
    expect("think" in (bodies[0] as Record<string, unknown>)).toBe(false);
  });
});

describe("exp-6 item 5: truncation-at-budget detection", () => {
  it("flags finish_reason=length", () => {
    expect(isTruncationAtBudget("ollama: empty response (finish_reason=length)", undefined, 1500)).toBe(
      true,
    );
  });

  it("flags completionTokens hitting the budget exactly (tick-4 shape)", () => {
    expect(
      isTruncationAtBudget("schema mismatch: narrative: Required", {
        promptTokens: 2050,
        completionTokens: 1500,
        totalTokens: 3550,
      }, 1500),
    ).toBe(true);
  });

  it("does not flag content errors under budget", () => {
    expect(
      isTruncationAtBudget("schema mismatch: narrative: Required", {
        promptTokens: 2050,
        completionTokens: 772,
        totalTokens: 2822,
      }, 1500),
    ).toBe(false);
  });

  it("the raise ceiling is bounded", () => {
    expect(MAX_RAISED_BUDGET).toBe(8000);
  });
});

describe("exp-6 item 6: model-aware timeouts", () => {
  const realHome = process.env["HOME"];
  afterEach(() => {
    process.env["HOME"] = realHome;
  });

  it("explicit LLM_TIMEOUT_MS always wins", () => {
    expect(defaultTimeoutMsFor("ollama", "qwen3:14b", 45_000)).toBe(45_000);
  });

  it("derives 4x the recorded median when unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "latency-"));
    process.env["HOME"] = dir;
    expect(latencyCachePath()).toContain(dir);
    recordModelLatencyMs("ollama", "qwen3:14b", 59_100);
    expect(readModelLatencyMs("ollama", "qwen3:14b")).toBe(59_100);
    // 4 * 59100 = 236400, within the 60s..600s clamp.
    expect(defaultTimeoutMsFor("ollama", "qwen3:14b", undefined)).toBe(236_400);
  });

  it("clamps the derived timeout to 600s", () => {
    const dir = mkdtempSync(join(tmpdir(), "latency-"));
    process.env["HOME"] = dir;
    recordModelLatencyMs("ollama", "qwen3:14b", 300_000);
    expect(defaultTimeoutMsFor("ollama", "qwen3:14b", undefined)).toBe(600_000);
  });

  it("falls back to 60s with no observations", () => {
    const dir = mkdtempSync(join(tmpdir(), "latency-"));
    process.env["HOME"] = dir;
    expect(defaultTimeoutMsFor("ollama", "qwen3:14b", undefined)).toBe(60_000);
  });

  it("recordModelLatencyMs blends across runs (EMA)", () => {
    const dir = mkdtempSync(join(tmpdir(), "latency-"));
    const path = join(dir, "l.json");
    recordModelLatencyMs("ollama", "qwen3:14b", 100_000, path);
    recordModelLatencyMs("ollama", "qwen3:14b", 200_000, path);
    // 0.7*100000 + 0.3*200000 = 130000
    expect(readModelLatencyMs("ollama", "qwen3:14b", path)).toBe(130_000);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, { samples: number }>;
    expect(raw["ollama:qwen3:14b"]!.samples).toBe(2);
  });
});

describe("exp-6 item 7: accept-path gates", () => {
  // Phase 4: the accept gate is validateRenderProse. The invented-contact
  // patch validator (object.invented_contact) is deleted with the patch
  // channel — there are no objectPatches left to invent contact on.

  it("tick-10 repro: 'approach the stranger' fails for a known coworker", () => {
    const world = officeWorld();
    const errors = validateRelationshipLabel(
      world,
      "Tanya: approach the stranger",
      action("tanya", "Approach Anton."),
    );
    expect(errors.map((e) => e.code)).toEqual(["narrative.stranger_label"]);
  });

  it("'has not met yet' does not count as knowing (Dana may say stranger)", () => {
    const world = officeWorld();
    const errors = validateRelationshipLabel(
      world,
      "Dana glances at the stranger by the door",
      action("dana", "Look at the newcomer."),
    );
    expect(errors).toEqual([]);
  });

  it("tick-13 repro (Phase 4): no objectPatch channel, nothing to invent contact on", () => {
    // The coffee-stain failure needed a model-emitted description patch.
    // Phase 4 deletes the whole channel — the render schema has no
    // objectPatches field, so this failure is impossible by construction.
    const world = officeWorld();
    const errors = validateRenderProse(
      world,
      action("tanya", "Pick up her mug."),
      { narrative: "Tanya glances at her mug.", thoughts: "Careful.", reasoning: "r" },
      {
        exactQuote: null, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
        x: 8, y: 7, engineManipulation: null,
      },
    );
    expect(errors).toEqual([]);
  });

  it("validateRenderProse catches the stranger receipt on the accept path", () => {
    const world = officeWorld();
    const stranger = validateRenderProse(
      world,
      action("tanya", "Approach Anton."),
      { narrative: "Tanya: approach the stranger", thoughts: "Who is that.", reasoning: "r" },
      {
        exactQuote: null, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
        x: 8, y: 7, engineManipulation: null,
      },
    );
    expect(stranger.map((e) => e.code)).toContain("narrative.stranger_label");
  });
});

describe("exp-6 item 8: user-turn fallback voice", () => {
  it("tick-9 repro: rewrites unquoted first-person, keeps quoted speech", () => {
    const out = thirdPersonFallbackText(
      "I turn toward Dana and say: Hi Dana, I am Anton, nice to meet you!",
    );
    expect(out).toBe(
      "They turn toward Dana and say: Hi Dana, I am Anton, nice to meet you!",
    );
  });

  it("tick-18 repro: contractions and possessives", () => {
    const out = thirdPersonFallbackText("I take a sip of coffee, then walk to my desk.");
    expect(out).toBe("They take a sip of coffee, then walk to their desk.");
  });

  it("leaves third-person text untouched", () => {
    const text = "Anton walks to the coffee machine and pours coffee.";
    expect(thirdPersonFallbackText(text)).toBe(text);
  });

  it("capitalizes at sentence starts", () => {
    expect(thirdPersonFallbackText("I walk. I sit.")).toBe("They walk. They sit.");
  });
});

describe("exp-6 item 9: cluster-normalized ban keys", () => {
  it("papers-shift paraphrases core identically", () => {
    const world = officeWorld();
    const a = suggestionCore(world, "move dana_papers to the side to clear workspace", "dana");
    const b = suggestionCore(world, "Dana shifts the dana_papers to the left", "dana");
    expect(a).toBe("adjust|papers");
    expect(b).toBe("adjust|papers");
  });

  it("locomotion keeps the move verb for actor nouns", () => {
    const world = officeWorld();
    expect(suggestionCore(world, "Walk toward Tanya's desk.", "anton")).toBe("move|tanya");
    expect(suggestionCore(world, "Shake Anton's hand warmly.", "tanya")).toBe("shake|anton");
  });

  it("chair-push keeps its push key", () => {
    const world = officeWorld();
    expect(suggestionCore(world, "Push the chair in neatly.", "dana")).toBe("push|chair");
  });
});

describe("exp-6 item 10: cell-verified state labels", () => {
  it("adjacent-but-not-on chair is 'near', not 'at' (tick-10 repro)", () => {
    const world = officeWorld();
    // Tanya at (8,6), chair at (8,7), pose sit — not on the cell.
    const label = describePosition(world, 8, 6, undefined, "sit");
    expect(label).toBe("near Tanya's chair");
  });

  it("sitting ON the chair cell is 'at'", () => {
    const world = officeWorld();
    const label = describePosition(world, 8, 7, undefined, "sit");
    expect(label).toBe("at Tanya's chair");
  });

  it("standing next to the chair is 'near' regardless", () => {
    const world = officeWorld();
    const label = describePosition(world, 8, 6, undefined, "stand");
    expect(label).toBe("near Tanya's chair");
  });

  it("non-seating furniture keeps the 2-cell 'at' rule", () => {
    const world = officeWorld();
    // (3,3): coffee machine center (2.5,1.5) is ~1.6 away → at.
    expect(describePosition(world, 3, 3)).toBe("at the coffee machine");
  });
});


describe("exp-6 item 12 (Phase 3): typing→laptop needs a nearby laptop", () => {
  it("executor plans laptop when one is nearby", () => {
    // dana at (15,11); dana_laptop at (15,11). The executor reads the
    // ACTION text (ground truth) — the verb must be there, not just in
    // the narrative.
    const outcome = executeManipulation(officeWorld(), action("dana", "Dana types on the laptop."));
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.kind).toBe("pick-up");
    expect(outcome!.plan.propName).toBe("laptop");
    expect(outcome!.plan.objectId).toBe("dana_laptop");
  });

  it("executor refuses to invent a laptop out of thin air", () => {
    const world = officeWorld();
    world.scene.objects = world.scene.objects.filter((o) => o.id !== "dana_laptop");
    expect(executeManipulation(world, action("dana", "Work on the laptop."))).toBeNull();
  });

  it("executor plans cup for sipping when a mug is near", () => {
    const world = officeWorld();
    world.scene.objects.push({
      id: "anton_mug", name: "Anton's mug", description: "A mug.",
      x: 3, y: 4, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    const outcome = executeManipulation(world, action("anton", "Take a sip."));
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.propName).toBe("cup");
  });

  it("executor plans nothing for sipping with no cup in reach (no thin-air props)", () => {
    expect(executeManipulation(officeWorld(), action("anton", "Take a sip."))).toBeNull();
  });
});
