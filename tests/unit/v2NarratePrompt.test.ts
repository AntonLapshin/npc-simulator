// PLAN_V2 Phase 4: the narrate-from-executed-facts prompt (pure
// prompt-building) + the reused prose validator against the new prompt
// shape. No LLM — scripted narratives only.
import { describe, expect, it } from "vitest";
import {
  buildNarrateContext,
  executedPoseFacts,
  type NarrateContextFacts,
} from "../../src/engine/contextBuilder.js";
import {
  validateRenderProse,
  type RenderFacts,
} from "../../src/engine/validate/render.js";
import type { TurnClamp } from "../../src/core/clamp.js";
import { makeTinyWorld } from "../helpers.js";

const world = () => makeTinyWorld();
const action = { actorId: "n", text: "N waves at U." };

const EMPTY_FACTS: NarrateContextFacts = {
  engineMovement: null,
  exactQuote: null,
  enginePose: null,
  engineManipulation: null,
  clamp: null,
};

describe("buildNarrateContext — executed-facts prompt shape", () => {
  it("contains the executed facts as the source of truth", () => {
    const prompt = buildNarrateContext(world(), action, undefined, EMPTY_FACTS);
    expect(prompt).toContain("NARRATE THE EXECUTED FACTS");
    expect(prompt).toContain("These facts are FINAL");
    expect(prompt).toContain("EXECUTED MOVEMENT");
    expect(prompt).toContain("EXECUTED MANIPULATION");
    expect(prompt).toContain("EXECUTED POSE");
    expect(prompt).toContain("EXACT QUOTE");
    // The acting actor is named with final position.
    expect(prompt).toContain("Acting actor: N (n,");
    // Closed-world roster survives (the validator's observer gates need it).
    expect(prompt).toContain("ROSTER RULE:");
  });

  it("contains NO intended-action phrasing as the source of truth", () => {
    const prompt = buildNarrateContext(world(), action, undefined, EMPTY_FACTS);
    expect(prompt).not.toContain("Action text:");
    expect(prompt).not.toContain("Current Action");
    expect(prompt).not.toContain("Interpret the action naturally");
    expect(prompt).not.toContain("grounded strictly in the given action text");
    // The patch-era instruction vocabulary is gone from the narrate prompt
    // (the ownership prohibitions like "Do NOT emit objectPatches" stay —
    // they reinforce the prose-only contract, they don't ask for patches).
    expect(prompt).not.toContain("actorPatch");
    expect(prompt).not.toContain("EFFECTS DECLARATION");
    expect(prompt).not.toContain("Patch ONLY affected");
  });

  it("carries the ATTEMPTED-vs-EXECUTED block when a clamp fired, and omits it otherwise", () => {
    const clamp: TurnClamp = {
      movement: null,
      contact: {
        attempted: "N tried to shake hands with U.",
        executed: "No contact happened — U is beyond contact reach.",
      },
      manipulation: null,
    };
    const withClamp = buildNarrateContext(world(), action, undefined, {
      ...EMPTY_FACTS,
      clamp,
    });
    expect(withClamp).toContain("ATTEMPTED vs EXECUTED");
    expect(withClamp).toContain("ATTEMPTED: N tried to shake hands with U.");
    expect(withClamp).toContain("EXECUTED: No contact happened");

    const withoutClamp = buildNarrateContext(world(), action, undefined, EMPTY_FACTS);
    expect(withoutClamp).not.toContain("ATTEMPTED vs EXECUTED");
  });

  it("embeds validation feedback on the retry attempt", () => {
    const prompt = buildNarrateContext(
      world(),
      action,
      "Previous render was rejected: [movement.narrated_without_move] invented walk",
      EMPTY_FACTS,
    );
    expect(prompt).toContain("Validation Feedback (previous output was invalid)");
    expect(prompt).toContain("[movement.narrated_without_move]");
  });

  it("omits fact blocks whose outcome is unknown (undefined), keeping older callers safe", () => {
    const prompt = buildNarrateContext(world(), action, undefined, {});
    expect(prompt).toContain("NARRATE THE EXECUTED FACTS");
    // No fact blocks — only the grounding-rules mentions of the labels.
    expect(prompt).not.toContain("EXECUTED MOVEMENT:");
    expect(prompt).not.toContain("EXACT QUOTE: none");
    expect(prompt).not.toContain("EXACT QUOTE (engine-owned");
    expect(prompt).not.toContain("EXECUTED MANIPULATION:");
    expect(prompt).not.toContain("EXECUTED POSE");
  });
});

describe("executedPoseFacts", () => {
  it("reports no pose change when the engine planned none", () => {
    const lines = executedPoseFacts(world(), "n", null);
    expect(lines.join("\n")).toContain("EXECUTED POSE: no pose change");
  });

  it("reports the engine-set pose as the narratable body change", () => {
    const sit = executedPoseFacts(world(), "n", "sit").join("\n");
    expect(sit).toContain("EXECUTED POSE");
    expect(sit).toContain("is now sitting");
    const stand = executedPoseFacts(world(), "n", "stand").join("\n");
    expect(stand).toContain("is now standing");
  });
});

describe("validateRenderProse against the Phase 4 facts shape", () => {
  const facts: RenderFacts = {
    exactQuote: null,
    moved: false,
    destinationActorId: null,
    pose: null,
    effectivePose: "stand",
    x: 4,
    y: 4,
    engineManipulation: null,
  };

  it("catches invented movement (narrated walk the engine did not perform)", () => {
    const errors = validateRenderProse(
      world(),
      action,
      {
        narrative: "N walks across the hall toward U with a confident stride.",
        thoughts: "Feeling bold.",
        reasoning: "scripted invented walk",
      },
      facts,
    );
    expect(errors.map((e) => e.code)).toContain("movement.narrated_without_move");
  });

  it("catches invented speech (missing engine-dictated quote)", () => {
    const errors = validateRenderProse(
      world(),
      action,
      {
        narrative: "N raises a hand in greeting.",
        thoughts: "Feeling bold.",
        reasoning: "scripted dropped quote",
      },
      { ...facts, exactQuote: "Hey U, over here!" },
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.code.startsWith("speech."))).toBe(true);
  });

  it("accepts prose grounded in the executed facts", () => {
    const errors = validateRenderProse(
      world(),
      { actorId: "n", text: 'N says "hey" to U.' },
      {
        narrative: 'N stays by the door and says "hey" to U.',
        thoughts: "Keeping it casual.",
        reasoning: "scripted clean",
      },
      { ...facts, exactQuote: "hey" },
    );
    expect(errors).toHaveLength(0);
  });
});
