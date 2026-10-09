// Regression tests for experiment-1.md action items 1-12
// (office-anton.json, text UI, local model run, ticks 0-20).
import { describe, expect, it } from "vitest";
import { validateRenderProse, type RenderFacts } from "../../src/engine/validate/render.js";
import {
  buildConsequenceContext,
  buildIdentityAnchor,
  buildProposalContext,
  buildSelectionContext,
  getOpenQuestions,
  getRecentOwnActions,
} from "../../src/engine/contextBuilder.js";
import { renderTurnStory } from "../../src/logging/storyTrace.js";
import { mockClassifyAction } from "../../src/mocks/mockSemanticJudge.js";
import { computeMovementOutcome } from "../../src/core/movement.js";
import { LLMProposalEngine } from "../../src/llm/llmProposalEngine.js";
import { renderSuffix } from "../../src/llm/prompts.js";
import { createTestLogger } from "../../src/logging/logger.js";
import type { LLMProvider } from "../../src/llm/index.js";
import { makeTinyWorld, hist, errorText } from "../helpers.js";
import type { ActionSemantics, ConsequenceResult } from "../../src/types.js";

function baseResult(narrative = "Something happens."): ConsequenceResult {
  return { narrative, reasoning: "r" };
}

function baseFacts(over: Partial<RenderFacts> = {}): RenderFacts {
  return {
    exactQuote: null, moved: false, destinationActorId: null, pose: null, effectivePose: "stand",
    x: 1, y: 1, engineManipulation: null, ...over,
  };
}

function entry(module: string, event: string, extra: Record<string, unknown> = {}) {
  return {
    id: "e", sessionId: "s", timestamp: "t", tick: 3, turnIndex: 0,
    module, event, actorId: "u", ...extra,
  } as unknown as Parameters<typeof renderTurnStory>[0][number];
}

class StubProvider implements LLMProvider {
  readonly name = "stub";
  calls: string[] = [];
  constructor(private readonly script: string[]) {}
  async complete(_s: string, user: string): Promise<string> {
    this.calls.push(user);
    const next = this.script.shift();
    if (next === undefined) throw new Error("exhausted");
    return next;
  }
}

describe("exp1-1 story trace renders the accepted consequence", () => {
  it("shows the LAST consequence_completed when a tick retried", () => {
    const first = { narrative: "U walks to (5,8) inside the desk.", reasoning: "first" };
    const second = { narrative: "U walks toward N but stays put.", reasoning: "accepted" };
    const entries = [
      entry("turn", "turn_started", { actorId: "u" }),
      entry("consequence", "consequence_completed", { output: first, parsedResponse: first, reasoning: "first" }),
      entry("consequence", "consequence_completed", { output: second, parsedResponse: second, reasoning: "accepted" }),
      entry("validator", "validation_failed", { validationErrors: ["inside non-passable"] }),
      entry("validator", "validation_passed", {}),
    ];
    const story = renderTurnStory(entries, 3, [{ id: "u", name: "U" }]);
    expect(story).toContain("stays put");
    expect(story).not.toContain("(5, 8)");
    expect(story).toMatch(/attempt 2 of 2|rejected/);
  });

  it("shows the repair marker on a repaired turn", () => {
    const raw = { narrative: "U approaches N.", reasoning: "r" };
    const repaired = { narrative: "U approaches N.", reasoning: "r" };
    const entries = [
      entry("turn", "turn_started", { actorId: "u" }),
      entry("consequence", "consequence_completed", { output: raw, parsedResponse: raw, reasoning: "r" }),
      entry("turn", "movement_repaired", { output: { suggestion: { x: 2, y: 2 }, repaired } }),
      entry("validator", "validation_passed", {}),
    ];
    const story = renderTurnStory(entries, 3, [{ id: "u", name: "U" }]);
    // Phase 4: no coordinate patches left — the story shows the repair
    // marker, not the coordinates.
    expect(story).toMatch(/movement repaired/);
  });
});


describe("exp1-2 contact approach (Phase 4: engine-owned)", () => {
  it("the engine closes to adjacency on a handshake turn (contact verb + named actor)", async () => {
    const { planMovementSemantics, executeMovement } = await import(
      "../../src/engine/movementExecutor.js"
    );
    const world = makeTinyWorld(); // u(1,1) n(4,4): ~4.2 apart
    // Single-letter names never resolve as mentions — use the full name.
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const action = { actorId: "u", text: "Shake hands with Nadia." };
    const planned = planMovementSemantics(world, action);
    expect(planned.moves).toBe(true);
    expect(planned.contactActorId).toBe("n");
    const o = executeMovement(world, action, planned);
    expect(o).not.toBeNull();
    // Adjacent to Nadia after the engine step (the structural contact guarantee).
    expect(Math.hypot(o!.x - 4, o!.y - 4)).toBeLessThanOrEqual(Math.SQRT2 + 1e-9);
  });

  it("a grounded handshake narrative passes render validation", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Shake hands with N." };
    const errors = validateRenderProse(
      world,
      action,
      { narrative: "U shakes hands with N.", reasoning: "r" },
      baseFacts({ moved: true, x: 3, y: 3 }),
    );
    expect(errors).toEqual([]);
  });
});

describe("exp1-3 destination fidelity for landmarks", () => {
  function coffeeWorld() {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "coffee_machine", name: "Coffee machine", description: "Coffee.",
      x: 5, y: 5, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false,
    });
    return world;
  }
  it("rejects narrated walks the engine did not perform, accepts grounded ones", () => {
    const world = coffeeWorld();
    const action = { actorId: "u", text: "Walk to the coffee machine." };
    // Phase 4: the engine computes the step, so "moving away" is
    // impossible by construction — the prose gate rejects narrated
    // locomotion with no engine move instead.
    const noMove = validateRenderProse(
      world,
      action,
      baseResult("U walks to the coffee machine."),
      baseFacts(),
    );
    expect(noMove.some((e) => e.code === "movement.narrated_without_move")).toBe(true);

    const grounded = validateRenderProse(
      world,
      action,
      baseResult("U walks to the coffee machine."),
      baseFacts({ moved: true, x: 2, y: 2 }),
    );
    expect(grounded).toEqual([]);
  });

  it("computeMovementOutcome resolves object destinations to closer cells", () => {
    const world = coffeeWorld();
    const o = computeMovementOutcome(world, "u", { destinationObjectId: "coffee_machine" });
    expect(o).not.toBeNull();
    const dOld = Math.hypot(1 - 5.5, 1 - 5.5);
    const dNew = Math.hypot(o!.x - 5.5, o!.y - 5.5);
    expect(dNew).toBeLessThan(dOld);
  });
});

describe("exp1-4 speech preservation applies to user turns too", () => {
  it("rejects truncation of a long user utterance to a fragment", () => {
    const world = makeTinyWorld();
    const quote = "Hi, I'm Anton, where is my desk?";
    const action = { actorId: "u", text: `"${quote}"` };
    const truncated = validateRenderProse(
      world,
      action,
      { ...baseResult(`U says "Hi, I'm Anton."`), thoughts: "Nervous." },
      baseFacts({ exactQuote: quote }),
    );
    expect(truncated.some((e) => e.code === "speech.exact_quote_missing")).toBe(true);

    const full = validateRenderProse(
      world,
      action,
      { ...baseResult(`U says "${quote}"`), thoughts: "Nervous." },
      baseFacts({ exactQuote: quote }),
    );
    expect(full).toEqual([]);
  });
});


describe("exp1-6/7 questions cue + repetition guard", () => {
  it("surfaces pending questions to proposal and selection", () => {
    const world = makeTinyWorld();
    world.history.push(hist(world, "U: N, where is my desk?"));
    expect(getOpenQuestions(world, "n")).toHaveLength(1);
    expect(buildProposalContext(world, "n")).toContain("where is my desk?");
    const sel = buildSelectionContext(world, "n", ["Greet U warmly."]);
    expect(sel).toContain("where is my desk?");
    expect(sel).toMatch(/ANSWER/i);
  });

  it("lists recent own actions with a do-not-repeat guard", () => {
    const world = makeTinyWorld();
    world.history.push(hist(world, "N: Walk over to greet U warmly."));
    world.history.push(hist(world, "N: Walk over to greet U warmly again."));
    expect(getRecentOwnActions(world, "n")).toHaveLength(2);
    const sel = buildSelectionContext(world, "n", ["Walk over to greet U warmly."]);
    expect(sel).toMatch(/do NOT repeat|Do not pick/i);
    expect(sel).toContain("Walk over to greet U warmly.");
  });
});

describe("exp1-8/9/10 anchors and nudges", () => {
  it("consequence context carries identity, pronoun, pose, and engine-ownership rules", () => {
    const world = makeTinyWorld();
    const ctx = buildConsequenceContext(world, { actorId: "u", text: "Sit at my desk." });
    expect(ctx).toContain("IDENTITY RULE");
    expect(ctx).toContain("PRONOUN RULE");
    // Phase 3: the POSE/PROP/OBJECT RULE is split — pose stays
    // model-emitted, object/prop manipulation is engine-owned.
    expect(ctx).toContain("POSE RULE");
    expect(ctx).toContain("OBJECT MANIPULATION IS ENGINE-EXECUTED");
    expect(ctx).not.toContain("POSE/PROP/OBJECT RULE");
    expect(ctx).toContain("You are NOT");
    expect(renderSuffix()).toContain("pose");
    expect(renderSuffix()).toMatch(/pronouns/i);
  });

  it("identity anchor states role and excludes others", () => {
    const world = makeTinyWorld();
    const anchor = buildIdentityAnchor(world, "n");
    // Exp-7 item A6: the anchor names the actor's pronouns up front.
    expect(anchor).toContain("N (n, they/them)");
    expect(anchor).toContain("You are NOT");
    expect(anchor).toContain("U (u)");
  });

  it("selection context carries identity + repetition + question cues", () => {
    const world = makeTinyWorld();
    world.history.push(hist(world, "U: N, what is my first task?"));
    world.history.push(hist(world, "N: Welcome to the team!"));
    const sel = buildSelectionContext(world, "n", ["Welcome to the team!"]);
    expect(sel).toContain("IDENTITY");
    expect(sel).toMatch(/do NOT repeat/i);
    expect(sel).toMatch(/ANSWER/i);
  });
});

describe("exp1-12 proposal robustness", () => {
  it("retries a single-suggestion set then returns a full cleaned set", async () => {
    const logger = createTestLogger();
    const provider = new StubProvider([
      JSON.stringify({ suggestions: ["Only one idea."], reasoning: "thin" }),
      JSON.stringify({
        suggestions: ["1. Walk over and greet.", "Walk over and greet.", "  ", "Sit down and work."],
        reasoning: "full",
      }),
    ]);
    const engine = new LLMProposalEngine(logger, provider, { maxRetries: 3 });
    const result = await engine.propose(makeTinyWorld(), "u");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]).toMatch(/at least 2|full option set/);
    expect(result.suggestions.length).toBeGreaterThanOrEqual(2);
    expect(result.suggestions.every((s) => !/^\d+[.)]/.test(s))).toBe(true);
  });
});

describe("mock judge resolves new semantic fields", () => {
  it("finds object, addressee, and contact targets by name", () => {
    const world = makeTinyWorld();
    world.scene.objects.push({
      id: "coffee_machine", name: "Coffee machine", description: "Coffee.",
      x: 5, y: 5, w: 1, h: 1, passable: false, blocksVision: false, blocksSound: false,
    });
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const s = mockClassifyAction(world, { actorId: "u", text: "Walk to the coffee machine" });
    expect(s.moves).toBe(true);
    expect(s.destinationObjectId).toBe("coffee_machine");

    const q = mockClassifyAction(world, { actorId: "u", text: "Ask Nadia where is my desk?" });
    expect(q.speaks).toBe(true);
    expect(q.addresseeActorId).toBe("n");

    const h = mockClassifyAction(world, { actorId: "u", text: "Shake hands with Nadia warmly." });
    expect(h.contactActorId).toBe("n");
  });
});
