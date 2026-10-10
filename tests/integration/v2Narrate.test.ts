// PLAN_V2 Phase 4: narrate-from-executed-facts on the v2 turn path,
// with scripted providers. No network — MockIntentEngine +
// MockConsequenceEngine.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runTurn } from "../../src/engine/turnOrchestrator.js";
import type { EngineDependencies } from "../../src/engine/turnOrchestrator.js";
import { MockIntentEngine } from "../../src/mocks/mockIntentEngine.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { defaultConfig } from "../../src/config.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import type { World } from "../../src/types.js";
import { makeTestDeps } from "../helpers.js";

/** 12x6 hall, Anton at (1,1), Tanya at (11,1) — exactly 10 cells apart. */
function makeHandshakeWorld(): World {
  return loadScenario({
    version: 1,
    id: "handshake",
    title: "Handshake",
    narrative: "A long hall.",
    userActorId: "anton",
    order: ["anton", "tanya"],
    scene: { width: 12, height: 6, objects: [] },
    actors: [
      {
        id: "anton",
        name: "Anton",
        persona: "User persona.",
        x: 1,
        y: 1,
        state: "standing",
        emotion: "calm",
        goal: "Explore.",
        memories: [],
        beliefs: [],
        relationships: [],
      },
      {
        id: "tanya",
        name: "Tanya",
        persona: "NPC persona.",
        x: 11,
        y: 1,
        state: "standing",
        emotion: "calm",
        goal: "Idle.",
        memories: [],
        beliefs: [],
        relationships: [],
      },
    ],
  });
}

// A narrative that deterministically fails prose validation: Tanya never
// moves (the wave executes no movement) and Anton is 10 cells away, so
// the narrated walk trips movement.narrated_without_move and the
// narrated handshake trips the contact-adjacency gate.
const INVENTED_WALK_NARRATIVE =
  "Tanya walks across the hall toward Anton and shakes his hand warmly.";

function makeV2Deps(
  sessionId: string,
  npcAction: string,
  npcNarrative: string,
): { deps: EngineDependencies; logger: ReturnType<typeof createTestLogger> } {
  const logger = createTestLogger(sessionId);
  const deps = makeTestDeps(logger, {
    intentEngine: new MockIntentEngine(
      logger,
      { tanya: { action: npcAction, quote: "" } },
      { providerBacked: true },
    ),
    consequenceEngine: new MockConsequenceEngine(
      logger,
      {
        [npcAction.trim().toLowerCase()]: {
          narrative: npcNarrative,
          thoughts: "Bold move.",
          emotion: "bold",
          reasoning: "scripted phase-4 turn",
        },
      },
      { providerBacked: true },
    ),
    config: { ...defaultConfig, autosaveEnabled: false },
    getUserAction: async () => "Anton looks around.",
  });
  return { deps, logger };
}

function narratePromptsFor(
  logger: ReturnType<typeof createTestLogger>,
  actorId: string,
): string[] {
  return logger.store
    .byEvent("consequence_started")
    .filter((e) => e.actorId === actorId)
    .map((e) => e.prompt as string);
}

/** Provider calls burned by actorId's turn (from turn_telemetry). */
function providerCallsFor(
  logger: ReturnType<typeof createTestLogger>,
  actorId: string,
): number {
  const events = logger.store.byEvent("turn_telemetry").filter((e) => e.actorId === actorId);
  expect(events).toHaveLength(1);
  return (events[0]!.output as { providerCalls: number }).providerCalls;
}

describe("Phase 4 — narrate executed facts on the v2 path", () => {
  it("the v2 narrate prompt is built from the executed facts, not the intended action", async () => {
    const { deps, logger } = makeV2Deps(
      "v2narrate1",
      "Tanya waves at Anton.",
      "Tanya waves at Anton across the hall.",
    );
    let world = makeHandshakeWorld();
    world = await runTurn(world, deps); // user turn (anton)
    world = await runTurn(world, deps); // NPC turn (tanya)

    const prompts = narratePromptsFor(logger, "tanya");
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    // The executed-facts block is the source of truth…
    expect(prompt).toContain("NARRATE THE EXECUTED FACTS");
    expect(prompt).toContain("These facts are FINAL");
    expect(prompt).toContain("EXECUTED MOVEMENT");
    expect(prompt).toContain("EXACT QUOTE");
    expect(prompt).toContain("EXECUTED MANIPULATION");
    expect(prompt).toContain("EXECUTED POSE");
    // …not the intended action.
    expect(prompt).not.toContain("Action text:");
    expect(prompt).not.toContain("Current Action");
    expect(prompt).not.toContain("Interpret the action naturally");
    // The turn completes cleanly on attempt 1.
    expect(world.tick).toBe(2);
    expect(logger.store.byEvent("narrate_accepted_despite_violations")).toHaveLength(0);
  });

  it("the clamp block rides along in the v2 narrate prompt when a clamp fired", async () => {
    const { deps, logger } = makeV2Deps(
      "v2narrate2",
      "Tanya shakes Anton's hand.",
      "Tanya strides toward Anton with an outstretched hand, but Anton is still across the hall — the handshake never lands.",
    );
    let world = makeHandshakeWorld();
    world = await runTurn(world, deps);
    world = await runTurn(world, deps);

    expect(logger.store.byEvent("clamp_applied").filter((e) => e.actorId === "tanya")).toHaveLength(1);
    const prompt = narratePromptsFor(logger, "tanya")[0]!;
    expect(prompt).toContain("NARRATE THE EXECUTED FACTS");
    expect(prompt).toContain("ATTEMPTED vs EXECUTED");
    expect(prompt).toContain("ATTEMPTED: Tanya tried to shake hands with Anton.");
    expect(world.tick).toBe(2);
  });

  it("one retry max, then accept-and-mark honest (no fallback, no sentinel)", async () => {
    const { deps, logger } = makeV2Deps(
      "v2narrate3",
      "Tanya waves at Anton.",
      INVENTED_WALK_NARRATIVE,
    );
    let world = makeHandshakeWorld();
    world = await runTurn(world, deps); // user turn (anton)
    world = await runTurn(world, deps); // NPC turn (tanya) — both attempts fail validation

    // Exactly 2 LLM calls (1 retry max), then the second result is accepted.
    expect(narratePromptsFor(logger, "tanya")).toHaveLength(2);
    expect(logger.store.byEvent("render_failed").filter((e) => e.actorId === "tanya")).toHaveLength(2);
    expect(providerCallsFor(logger, "tanya")).toBe(3); // intent + 2 renders

    // Accepted and marked honest — never rewritten, never fallen back.
    const accepted = logger.store.byEvent("narrate_accepted_despite_violations");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.actorId).toBe("tanya");
    const marked = (accepted[0]!.input as { render: { narrateAcceptedDespiteViolations?: boolean } }).render;
    expect(marked.narrateAcceptedDespiteViolations).toBe(true);
    const violations = accepted[0]!.validationErrors as string[];
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("movement.narrated_without_move"))).toBe(true);

    // The flawed paragraph lands in history — a flawed paragraph beats a
    // dead turn, and the (not done) family stays dead.
    const historyText = world.history.map((e) => e.text).join("\n");
    expect(historyText).toContain("shakes his hand warmly");
    expect(historyText).not.toContain("Nothing changes.");
    expect(historyText).not.toContain("(not done)");
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
    expect(world.tick).toBe(2);
  });
});
