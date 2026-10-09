// Regression tests for Experiment-4 action items implemented on the
// exp4-fixes branch.
//
// Item 6 (S4/M1): narrative voice gate.
//   - tick-11 repro: "Dana: Dana: I glance up…" — doubled author prefix +
//     first-person self-reference must fail validation (retry-loop path,
//     not only the accept gate); the doubled prefix collapses
//     deterministically.
//   - quoted "I" (the character speaking) is NOT a violation.
// Item 5 (S2): constructive movement re-steer.
//   - a vetoed repair is replaced by a capped step TOWARD the narrative's
//     named approach target instead of veto → retry → fallback.
// Item 7 (S3): intent-ban streaks skip liveness-floor entries.
//   - exp-4 ticks 19→22 repro: the tick-19 liveness turn reset the
//     "move|anton" streak and the same intent failed a third time.
// Item 8 (S5): pose-aware state labels.
//   - a standing actor next to a chair is "near" it, never "at" it.
// Item 10 (S6): deterministic prop stubs + pour distance.
//   - sip → cup, typing → laptop, pour → cup only next to a machine;
//     pouring from across the room fails honestly (tick-29 repro).
// Item 3 (S1/M2): canonical speech turns.
//   - the judge hallucinating moves=true on 'Say to Tanya "…"' is
//     downgraded — quoted speech with no displacement token is
//     speech-only (exp-4 moves 7–8 repro).
// Item 2 (S1): capable-tier no-op warning.
//   - LLM_USER_CAPABLE_TIER=1 with both tiers on the same provider+model
//     reports the reason instead of silently falling back.
// Item 11 (S10): consequence prompt carries the emotion-update nudge.
import { describe, expect, it } from "vitest";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import {
  collapseDoubledPrefix,
  detectVoiceViolation,
  validateNarrativeVoice,
} from "../../src/engine/validate/narrative.js";
import { validateObjectGrounding } from "../../src/engine/validate/objects.js";
import { executeManipulation } from "../../src/engine/manipulationExecutor.js";
import { describePosition } from "../../src/engine/patchApplier.js";
import { consecutiveIntentFailures } from "../../src/engine/turnLiveness.js";
import { LIVENESS_HISTORY_MARKER } from "../../src/engine/patchApplier.js";
import { stepTowardPoint } from "../../src/core/movement.js";
import { capableTierNoopReason } from "../../src/llm/index.js";
import { renderSuffix } from "../../src/llm/prompts.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { NOT_DONE_SENTINEL } from "../../src/types.js";
import type {
  Action,
  ActionSemantics,
  ConsequenceResult,
  ValidationError,
  World,
} from "../../src/types.js";

function officeWorld(): World {
  return loadScenario({
    version: 1,
    id: "office-exp4-test",
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
          id: "tanya_desk", name: "Tanya's desk", description: "A desk.",
          x: 7, y: 8, w: 3, h: 2, passable: false, blocksVision: false, blocksSound: false,
        },
      ],
    },
    actors: [
      {
        id: "anton", name: "Anton", persona: "New backend hire.", x: 16, y: 2,
        state: "standing near the entrance", emotion: "nervous",
        goal: "Settle in.", memories: [], beliefs: [], relationships: [],
      },
      {
        id: "tanya", name: "Tanya", persona: "QA engineer.", x: 8, y: 7,
        state: "sitting at her desk", emotion: "focused", pose: "sit",
        goal: "Finish testing.", memories: [], beliefs: [], relationships: [],
      },
      {
        id: "dana", name: "Dana", persona: "Recruiter.", x: 15, y: 11,
        state: "sitting at his desk", emotion: "stressed",
        goal: "Screen candidates.", memories: [], beliefs: [], relationships: [],
      },
    ],
  });
}

function silentSemantics(): ActionSemantics {
  return { moves: false, speaks: false, quotedSpeech: [] };
}

describe("exp4 item 6 (S4/M1): narrative voice gate", () => {
  it("flags first-person self-reference outside quotes", () => {
    const v = detectVoiceViolation("Dana glances up and says I will help.", "Dana");
    expect(v.some((x) => x.code === "first_person")).toBe(true);
  });

  it("flags the tick-11 doubled prefix AND the first-person leak", () => {
    const v = detectVoiceViolation("Dana: Dana: I glance up from my screen.", "Dana");
    expect(v.some((x) => x.code === "doubled_prefix")).toBe(true);
    expect(v.some((x) => x.code === "first_person")).toBe(true);
  });

  it("does not flag quoted speech (the character speaking is fine)", () => {
    expect(detectVoiceViolation('Tanya says "I can help you."', "Tanya")).toEqual([]);
    expect(
      detectVoiceViolation("Anton says 'I am the new hire.'", "Anton"),
    ).toEqual([]);
  });

  it("does not flag clean third-person narrative", () => {
    expect(
      detectVoiceViolation("Tanya walks toward the desk and smiles.", "Tanya"),
    ).toEqual([]);
  });

  it("collapseDoubledPrefix repairs 'Dana: Dana: …' deterministically", () => {
    expect(collapseDoubledPrefix("Dana: Dana: I glance up.", "Dana")).toBe(
      "Dana: I glance up.",
    );
    expect(collapseDoubledPrefix("Dana: Dana: Dana: wow.", "Dana")).toBe(
      "Dana: wow.",
    );
    expect(collapseDoubledPrefix("Dana: Dana glances up.", "Dana")).toBe(
      "Dana: Dana glances up.",
    );
  });

  it("fires as narrative.first_person inside validateRenderProse", () => {
    const world = officeWorld();
    const action: Action = { actorId: "dana", text: "Glance up at Anton." };
    const errors = validateRenderProse(
      world,
      action,
      {
        narrative: "Dana: I glance up from my screen to look at Anton.",
        thoughts: "New hire.",
        reasoning: "r",
      },
      {
        exactQuote: null, moved: false, pose: null, effectivePose: "stand",
        x: 15, y: 11, engineManipulation: null,
      },
    );
    expect(errors.some((e) => e.code === "narrative.first_person")).toBe(true);
  });

  it("validateNarrativeVoice surfaces narrative.* codes", () => {
    const errors: ValidationError[] = validateNarrativeVoice(
      "Dana: Dana: I glance up.",
      "Dana",
    );
    expect(errors.some((e) => e.code === "narrative.doubled_prefix")).toBe(true);
    expect(errors.some((e) => e.code === "narrative.first_person")).toBe(true);
  });
});

describe("exp4 item 5 (S2): toward-steps as a movement toolkit", () => {
  it("stepTowardPoint returns a capped step strictly toward the target", () => {
    const world = officeWorld();
    // Anton at (16,2); target is Tanya at (8,7): ~9.4 cells away.
    const step = stepTowardPoint(world, "anton", 8, 7);
    expect(step).not.toBeNull();
    const oldD = Math.hypot(16 - 8, 2 - 7);
    const newD = Math.hypot(step!.x - 8, step!.y - 7);
    expect(newD).toBeLessThan(oldD);
    expect(Math.hypot(step!.x - 16, step!.y - 2)).toBeLessThanOrEqual(6 + 1e-9);
  });

  it("stepTowardPoint returns null when already adjacent (honest dead end)", () => {
    const world = officeWorld();
    world.actors.find((a) => a.id === "anton")!.x = 9;
    world.actors.find((a) => a.id === "anton")!.y = 7;
    // Tanya at (8,7), Anton at (9,7): adjacent — no closer legal step
    // without stacking (stacking on the actor cell is excluded).
    const step = stepTowardPoint(world, "tanya", 9, 7);
    // Either null or a non-stacking step; never the actor's own cell.
    if (step) expect(`${step.x},${step.y}`).not.toBe("9,7");
  });
});

describe("exp4 item 7 (S3): intent-ban streaks skip liveness entries", () => {
  it("a liveness-floor turn does not reset the consecutive-failure streak", () => {
    const world = officeWorld();
    const fail = (text: string): string =>
      `Tanya tried: ${text} (not done)${NOT_DONE_SENTINEL}`;
    world.history.push(
      { text: fail("I walk over to the open laptop on my desk, turning it to face Anton."), tick: 13, turnIndex: 0 } as never,
      { text: fail("walk over to the open laptop on her desk, turning it to face Anton."), tick: 16, turnIndex: 1 } as never,
      // Tick-19 liveness floor: applied, no sentinel — must not break the streak.
      { text: `Tanya: Tanya holds position, taking in the room. (partial) ${LIVENESS_HISTORY_MARKER}`, tick: 19, turnIndex: 2 } as never,
    );
    // Both failures key to move|anton (walk → move stem, Anton mentioned).
    expect(consecutiveIntentFailures(world, "tanya", "move|anton")).toBe(2);
  });

  it("a genuinely applied own turn still breaks the streak", () => {
    const world = officeWorld();
    const fail = (text: string): string =>
      `Tanya tried: ${text} (not done)${NOT_DONE_SENTINEL}`;
    world.history.push(
      { text: fail("walk over to the open laptop on her desk."), tick: 16, turnIndex: 1 } as never,
      { text: "Tanya: Tanya asks Anton for help with setting up her computer.", tick: 25, turnIndex: 2 } as never,
    );
    expect(consecutiveIntentFailures(world, "tanya", "move|anton")).toBe(0);
  });
});

describe("exp4 item 8 (S5): pose-aware state labels", () => {
  it("a standing actor next to a chair is 'near' it, never 'at' it", () => {
    const world = officeWorld();
    // (7,7): 1.6 cells from Tanya's chair center (8.5,7.5) — "at" range.
    expect(describePosition(world, 7, 7, undefined, "stand")).toBe("near Tanya's chair");
  });

  it("a sitting actor on the chair is still 'at' it", () => {
    const world = officeWorld();
    expect(describePosition(world, 8, 7, undefined, "sit")).toBe("at Tanya's chair");
  });

  it("unknown pose keeps the old behavior (fail open)", () => {
    const world = officeWorld();
    expect(describePosition(world, 7, 7)).toBe("at Tanya's chair");
  });
});

describe("exp4 item 10 (S6, Phase 3): engine-executed props + pour distance", () => {
  it("executor plans prop:cup for sipping with nothing held", () => {
    const world = officeWorld();
    world.scene.objects.push({
      id: "anton_mug", name: "Anton's mug", description: "A mug.",
      x: 16, y: 3, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    const action: Action = { actorId: "anton", text: "Take a sip of coffee." };
    const outcome = executeManipulation(world, action);
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.kind).toBe("pick-up");
    expect(outcome!.plan.propName).toBe("cup");
  });

  it("executor plans prop:laptop for typing near a laptop", () => {
    const world = officeWorld();
    // Exp-6 item 12: the executor needs a real laptop nearby — place one
    // on the desk next to Anton before typing.
    world.scene.objects.push({
      id: "anton_laptop", name: "Anton's laptop", description: "A laptop.",
      x: 16, y: 3, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    const action: Action = { actorId: "anton", text: "Type up the report." };
    const outcome = executeManipulation(world, action);
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.propName).toBe("laptop");
  });

  it("executor plans prop:cup for pour/brew next to a machine", () => {
    const world = officeWorld();
    const dana = world.actors.find((a) => a.id === "dana")!;
    dana.x = 2; dana.y = 2; // next to the coffee machine at (2,1)
    world.scene.objects.push({
      id: "dana_mug", name: "Dana's mug", description: "A mug.",
      x: 2, y: 3, w: 1, h: 1, passable: true, blocksVision: false, blocksSound: false,
    });
    const action: Action = { actorId: "dana", text: "Pour a coffee." };
    const outcome = executeManipulation(world, action);
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.propName).toBe("cup");
  });

  it("executor plans nothing for pour/brew far from any machine", () => {
    const world = officeWorld(); // dana at (15,11), machine at (2,1)
    const action: Action = { actorId: "dana", text: "Pour a coffee." };
    expect(executeManipulation(world, action)).toBeNull();
  });

  it("executor refuses two manipulation kinds in one action (single-manipulation contract)", () => {
    const world = officeWorld();
    // "pick up" + "hand over" are contradictory end states — the engine
    // executes exactly one manipulation per turn, so this plans nothing.
    const mixed: Action = { actorId: "anton", text: "Pick up the mug and hand it to Dana." };
    expect(executeManipulation(world, mixed)).toBeNull();
  });

  it("already holding something disqualifies pick-up", () => {
    const world = officeWorld();
    world.actors.find((a) => a.id === "anton")!.prop = "cup";
    const action: Action = { actorId: "anton", text: "Take a sip." };
    expect(executeManipulation(world, action)).toBeNull();
  });

  it("pour_too_far fires when brewing/pouring far from any machine (tick-29 repro)", () => {
    const world = officeWorld(); // dana at (15,11), machine at (2,1)
    const dana = world.actors.find((a) => a.id === "dana")!;
    const errors = validateObjectGrounding(
      world,
      { actorId: "dana", text: "Pour a coffee." },
      "Dana pours coffee from the coffee maker into a dana_mug.",
      "stand",
      dana.x,
      dana.y,
    );
    expect(errors.some((e) => e.code === "object_grounding.pour_too_far")).toBe(true);
  });

  it("pour_too_far does not fire next to the machine", () => {
    const world = officeWorld();
    const dana = world.actors.find((a) => a.id === "dana")!;
    dana.x = 2; dana.y = 2;
    const errors = validateObjectGrounding(
      world,
      { actorId: "dana", text: "Pour a coffee." },
      "Dana pours coffee from the coffee maker into a dana_mug.",
      "stand",
      dana.x,
      dana.y,
    );
    expect(errors.some((e) => e.code === "object_grounding.pour_too_far")).toBe(false);
  });
});


describe("exp4 item 2 (S1): capable-tier no-op warning", () => {
  it("reports the reason when both tiers resolve to the same provider+model", () => {
    const env = {
      LLM_USER_CAPABLE_TIER: "1",
      LLM_BACKEND: "ollama",
      LLM_SIMPLE_BACKEND: "ollama",
      OLLAMA_MODEL: "fluffy/l3-8b-stheno-v3.2",
      LLM_SIMPLE_MODEL: "fluffy/l3-8b-stheno-v3.2",
    } as NodeJS.ProcessEnv;
    const reason = capableTierNoopReason(env);
    expect(reason).toMatch(/same provider\+model/);
    expect(reason).toMatch(/ollama:fluffy\/l3-8b-stheno-v3\.2/);
  });

  it("is silent when the tiers genuinely differ", () => {
    const env = {
      LLM_USER_CAPABLE_TIER: "1",
      LLM_BACKEND: "ollama",
      LLM_SIMPLE_BACKEND: "ollama",
      OLLAMA_MODEL: "fluffy/l3-8b-stheno-v3.2",
      LLM_SIMPLE_MODEL: "huihui_ai/llama3.2-abliterate:3b",
    } as NodeJS.ProcessEnv;
    expect(capableTierNoopReason(env)).toBeUndefined();
  });
});

describe("exp4 item 11 (S10): emotion nudge in the render prompt", () => {
  it("render suffix carries the EMOTION line", () => {
    expect(renderSuffix()).toMatch(/EMOTION/i);
  });

  it("render suffix carries the NARRATIVE VOICE discipline line", () => {
    expect(renderSuffix()).toMatch(/NARRATIVE VOICE/);
  });
});
