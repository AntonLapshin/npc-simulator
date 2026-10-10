// PLAN_V2 Phase 3: attempted-vs-executed on the v2 turn path, with
// scripted providers. No network — MockIntentEngine + MockConsequenceEngine.
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

const HANDSHAKE_NARRATIVE =
  "Tanya strides toward Anton with an outstretched hand, but Anton is still across the hall — the handshake never lands.";

function makeV2Deps(
  sessionId: string,
  npcAction: string,
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
        "tanya shakes anton's hand.": {
          narrative: HANDSHAKE_NARRATIVE,
          thoughts: "Too far — next time walk over first.",
          emotion: "sheepish",
          reasoning: "scripted impossible handshake",
        },
        "tanya waves at anton.": {
          narrative: "Tanya waves at Anton across the hall.",
          thoughts: "Friendly.",
          emotion: "calm",
          reasoning: "scripted normal turn",
        },
      },
      { providerBacked: true },
    ),
    config: { ...defaultConfig, autosaveEnabled: false },
    getUserAction: async () => "Anton looks around.",
  });
  return { deps, logger };
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

function narratePromptFor(
  logger: ReturnType<typeof createTestLogger>,
  actorId: string,
): string {
  const started = logger.store
    .byEvent("consequence_started")
    .filter((e) => e.actorId === actorId);
  expect(started).toHaveLength(1);
  return started[0]!.prompt as string;
}

describe("Phase 3 — attempted-vs-executed on the v2 path", () => {
  it("a handshake from 10 cells away records the honest gap in the narrate input", async () => {
    const { deps, logger } = makeV2Deps("v2clamp1", "Tanya shakes Anton's hand.");
    let world = makeHandshakeWorld();
    world = await runTurn(world, deps); // user turn (anton)
    world = await runTurn(world, deps); // NPC turn (tanya) — the impossible handshake

    // The clamp policy fired deterministically.
    const clamped = logger.store.byEvent("clamp_applied").filter((e) => e.actorId === "tanya");
    expect(clamped).toHaveLength(1);
    const clampOut = clamped[0]!.output as {
      contact: { attempted: string };
      movement: { attempted: string };
    };
    expect(clampOut.contact.attempted).toBe("Tanya tried to shake hands with Anton.");
    expect(clampOut.movement.attempted).toBe("Tanya tried to walk to Anton.");

    // The narrate input carries ATTEMPTED vs EXECUTED.
    const prompt = narratePromptFor(logger, "tanya");
    expect(prompt).toContain("ATTEMPTED vs EXECUTED");
    expect(prompt).toContain("ATTEMPTED: Tanya tried to shake hands with Anton.");
    expect(prompt).toContain("beyond contact reach");
    expect(prompt).toContain("No contact happened");
    // …alongside the regular executed facts.
    expect(prompt).toContain("EXECUTED MOVEMENT");

    // The turn is coherent and honest: no teleport, no sentinel, no fallback.
    const tanya = world.actors.find((a) => a.id === "tanya")!;
    // The engine walked the full 6-cell cap toward Anton (11→5) — closest
    // reachable, never a teleport — and stopped 4 cells short of contact.
    expect(tanya.x).toBe(5);
    expect(tanya.y).toBe(1);
    const historyText = world.history.map((e) => e.text).join("\n");
    expect(historyText).toContain("the handshake never lands");
    expect(historyText).not.toContain("(not done)");
    expect(world.tick).toBe(2);
  });

  it("the impossible turn burns no extra LLM calls vs a normal turn", async () => {
    // Impossible turn: handshake from 10 cells.
    const hard = makeV2Deps("v2clamp2a", "Tanya shakes Anton's hand.");
    let hardWorld = makeHandshakeWorld();
    hardWorld = await runTurn(hardWorld, hard.deps);
    hardWorld = await runTurn(hardWorld, hard.deps);
    const hardCalls = providerCallsFor(hard.logger, "tanya");

    // Normal turn: a wave (no contact verb, no clamp gap).
    const easy = makeV2Deps("v2clamp2b", "Tanya waves at Anton.");
    let easyWorld = makeHandshakeWorld();
    easyWorld = await runTurn(easyWorld, easy.deps);
    easyWorld = await runTurn(easyWorld, easy.deps);
    const easyCalls = providerCallsFor(easy.logger, "tanya");

    // The clamp policy is one deterministic pass — intent + render, nothing more.
    expect(hardCalls).toBe(2);
    expect(easyCalls).toBe(2);
    expect(hardCalls).toBe(easyCalls);
    // No render retry was burned on the impossible turn.
    expect(
      hard.logger.store.byEvent("consequence_retry").filter((e) => e.actorId === "tanya"),
    ).toHaveLength(0);
  });

  it("a fully-executed turn carries no clamp block in the narrate input", async () => {
    const { deps, logger } = makeV2Deps("v2clamp3", "Tanya waves at Anton.");
    let world = makeHandshakeWorld();
    world = await runTurn(world, deps);
    world = await runTurn(world, deps);
    // No gap → no clamp record, no prompt block.
    expect(logger.store.byEvent("clamp_applied").filter((e) => e.actorId === "tanya")).toHaveLength(0);
    expect(narratePromptFor(logger, "tanya")).not.toContain("ATTEMPTED vs EXECUTED");
  });
});
