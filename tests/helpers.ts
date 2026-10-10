import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoryEntry, ValidationError, World } from "../src/types.js";
import { NOT_DONE_SENTINEL } from "../src/types.js";
import { loadScenario } from "../src/engine/scenarioLoader.js";
import { Logger } from "../src/logging/logger.js";
import { MockIntentEngine } from "../src/mocks/mockIntentEngine.js";
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
    intentEngine: new MockIntentEngine(logger),
    consequenceEngine: new MockConsequenceEngine(logger),
    logger,
    config: { ...defaultConfig, autosaveEnabled: false },
    getUserAction: async (_actorId, _suggestions) => "Do nothing.",
    ...overrides,
  };
}

export function makeTinyWorld(): World {  return loadScenario({
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

/**
 * Build a HistoryEntry perceived by every actor (F6: legacy-global
 * semantics for hand-built test worlds).
 */
export function hist(world: World, text: string, perceivers?: string[]): HistoryEntry {
  return { text, perceivers: perceivers ?? world.actors.map((a) => a.id) };
}

/**
 * Build a fallback-marked history entry: `text` should already carry the
 * "Name tried: <action>" prefix; the human-readable "(not done)" marker
 * and the F22 machine-readable sentinel are appended.
 */
export function triedHist(world: World, text: string): HistoryEntry {
  return hist(world, `${text} (not done)${NOT_DONE_SENTINEL}`);
}

/** Render coded validation errors as one searchable string (F2). */
export function errorText(errors: ValidationError[]): string {
  return errors.map((e) => `[${e.code}] ${e.message}`).join(" ");
}
