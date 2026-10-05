import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { World } from "../src/types.js";
import { loadScenario } from "../src/engine/scenarioLoader.js";
import { Logger } from "../src/logging/logger.js";
import { MockProposalEngine } from "../src/mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../src/mocks/mockSelectionEngine.js";
import { MockConsequenceEngine } from "../src/mocks/mockConsequenceEngine.js";
import type { EngineDependencies } from "../src/engine/turnOrchestrator.js";
import { defaultConfig } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));

export function loadOfficeScenario(): World {
  const raw = JSON.parse(
    readFileSync(join(here, "../scenarios/office.json"), "utf-8"),
  );
  return loadScenario(raw);
}

export function makeTestDeps(
  logger: Logger,
  overrides: Partial<EngineDependencies> = {},
): EngineDependencies {
  return {
    proposalEngine: new MockProposalEngine(logger),
    selectionEngine: new MockSelectionEngine(logger),
    consequenceEngine: new MockConsequenceEngine(logger),
    logger,
    config: { ...defaultConfig, autosaveEnabled: false },
    getUserAction: async (_actorId, suggestions) => suggestions[0] ?? "Do nothing.",
    ...overrides,
  };
}

export function makeTinyWorld(): World {
  return loadScenario({
    version: 1,
    id: "tiny",
    title: "Tiny",
    narrative: "A small room.",
    userActorId: "u",
    order: ["u", "n"],
    scene: { width: 6, height: 6, objects: [] },
    actors: [
      {
        id: "u",
        name: "U",
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
        id: "n",
        name: "N",
        persona: "NPC persona.",
        x: 4,
        y: 4,
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
