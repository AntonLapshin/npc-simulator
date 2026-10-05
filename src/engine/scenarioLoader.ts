import type { Scenario, World } from "../types.js";
import { scenarioSchema } from "../schemas.js";
import { isInsideScene, isPointBlocked } from "./geometry.js";
import type { Logger } from "../logging/logger.js";

export class ScenarioLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioLoadError";
  }
}

function fail(message: string): never {
  throw new ScenarioLoadError(message);
}

/**
 * Parse scenario JSON, validate schema, create initial World
 * (tick = 0, turnIndex = 0, empty history).
 */
export function loadScenario(raw: unknown, logger?: Logger): World {
  try {
    return loadScenarioInner(raw, logger);
  } catch (err) {
    logger?.log({
      module: "scenario",
      event: "scenarioloadfailed",
      tick: 0,
      turnIndex: 0,
      input: { raw },
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function loadScenarioInner(raw: unknown, logger?: Logger): World {
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    fail(`invalid scenario schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const scenario: Scenario = parsed.data;

  // Unique ids.
  const actorIds = new Set<string>();
  for (const a of scenario.actors) {
    if (actorIds.has(a.id)) fail(`duplicate actor id: ${a.id}`);
    actorIds.add(a.id);
  }
  const objectIds = new Set<string>();
  for (const o of scenario.scene.objects) {
    if (objectIds.has(o.id)) fail(`duplicate object id: ${o.id}`);
    objectIds.add(o.id);
  }

  if (!actorIds.has(scenario.userActorId)) fail(`userActorId does not exist: ${scenario.userActorId}`);

  for (const id of scenario.order) {
    if (!actorIds.has(id)) fail(`turn order references unknown actor: ${id}`);
  }
  const orderSet = new Set(scenario.order);
  for (const id of actorIds) {
    if (!orderSet.has(id)) fail(`turn order missing actor: ${id}`);
  }

  if (!(scenario.scene.width > 0 && scenario.scene.height > 0)) {
    fail("scene width and height must be positive");
  }

  for (const o of scenario.scene.objects) {
    if (!(o.w > 0 && o.h > 0)) fail(`object has non-positive size: ${o.id}`);
    if (o.x < 0 || o.y < 0 || o.x + o.w > scenario.scene.width || o.y + o.h > scenario.scene.height) {
      fail(`object rectangle outside scene bounds: ${o.id}`);
    }
  }

  for (const a of scenario.actors) {
    if (!isInsideScene(scenario.scene, { x: a.x, y: a.y })) {
      fail(`actor outside scene bounds: ${a.id}`);
    }
    if (isPointBlocked(scenario.scene, { x: a.x, y: a.y })) {
      fail(`actor starts inside non-passable object: ${a.id}`);
    }
  }

  const world: World = {
    ...structuredClone(scenario),
    tick: 0,
    turnIndex: 0,
    history: [],
  };
  logger?.log({
    module: "scenario",
    event: "scenario_loaded",
    tick: 0,
    turnIndex: 0,
    input: { raw: scenario },
    output: { world },
  });
  return world;
}
