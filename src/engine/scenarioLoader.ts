import type { Scenario, ScenarioVocabulary, World } from "../types.js";
import { KNOWN_WORLD_VERSIONS } from "../types.js";
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

/**
 * F8: parse the optional scenario vocabulary. Returns undefined when
 * absent; throws ScenarioLoadError on a malformed value.
 */
function parseScenarioVocabulary(raw: unknown): ScenarioVocabulary | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("invalid scenario vocabulary: expected an object with optional objectNouns");
  }
  const rec = raw as Record<string, unknown>;
  const vocabulary: ScenarioVocabulary = {};
  if (rec["objectNouns"] !== undefined) {
    const nouns = rec["objectNouns"];
    if (
      !Array.isArray(nouns) ||
      nouns.length === 0 ||
      !nouns.every((n) => typeof n === "string" && n.trim().length > 0)
    ) {
      fail("invalid scenario vocabulary.objectNouns: expected a non-empty array of non-empty strings");
    }
    vocabulary.objectNouns = (nouns as string[]).map((n) => n.trim());
  }
  return vocabulary;
}

function loadScenarioInner(raw: unknown, logger?: Logger): World {
  // F8: the scenario schema (owned by src/schemas.ts) is strict and does
  // not know `vocabulary` yet — extract and validate it from the raw
  // input first, strip it before schema parsing, and reattach afterwards.
  // (Once the schema declares it, the strip is a harmless no-op.)
  const rawRecord =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const vocabulary = parseScenarioVocabulary(rawRecord["vocabulary"]);
  const { vocabulary: _stripped, ...schemaInput } = rawRecord;
  void _stripped;
  const parsed = scenarioSchema.safeParse(schemaInput);
  if (!parsed.success) {
    fail(`invalid scenario schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const scenario: Scenario = parsed.data;

  // F27: reject unknown world versions with a descriptive error instead of
  // loading them as if the format matched.
  if (!KNOWN_WORLD_VERSIONS.includes(scenario.version)) {
    fail(
      `unsupported scenario version ${scenario.version}: this build understands version(s) ${KNOWN_WORLD_VERSIONS.join(", ")}`,
    );
  }

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

  // PLAN_V2 Phase 5: the director's incident list must be unambiguous —
  // a duplicated event id would make "consumed" tracking meaningless.
  // (Shape — non-empty id/text — is enforced by the zod schema above.)
  if (scenario.directorEvents !== undefined) {
    const eventIds = new Set<string>();
    for (const e of scenario.directorEvents) {
      if (eventIds.has(e.id)) fail(`duplicate director event id: ${e.id}`);
      eventIds.add(e.id);
    }
  }

  if (!actorIds.has(scenario.userActorId)) fail(`userActorId does not exist: ${scenario.userActorId}`);

  for (const id of scenario.order) {
    if (!actorIds.has(id)) fail(`turn order references unknown actor: ${id}`);
  }
  // F20: a duplicated order id would give an actor two turns per cycle.
  const seenOrder = new Set<string>();
  for (const id of scenario.order) {
    if (seenOrder.has(id)) fail(`duplicate actor id in turn order: ${id}`);
    seenOrder.add(id);
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
  // F8: reattach the vocabulary stripped before schema parsing.
  if (vocabulary !== undefined) world.vocabulary = vocabulary;
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
