// tests/smoke.mjs — headless smoke test for the simulation core.
// Runs without a DOM: mock adapter turn flow, live state tweening and
// speech parsing. Usage: node tests/smoke.mjs

import assert from "node:assert/strict";
import { MockAdapter, scenarioToWorld } from "../js/sim/mockAdapter.js";
import { OFFICE_SCENARIO } from "../js/data/officeScenario.js";
import { LiveState, deriveDir } from "../js/sim/liveState.js";
import { extractQuoted, parseSpeechFromAction } from "../js/sim/textParse.js";
import { resolvePresentation, deriveLook, makeMapper } from "../js/sim/presentation.js";
import { FLOOR_BOUNDS, STATIC_SCENE } from "../js/data/staticScene.js";
import { buildViewScene, isStaticOfficeScene } from "../js/data/scenarioScene.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("npc-simulator-ui smoke tests");

await test("scenarioToWorld produces a fresh World", () => {
  const w = scenarioToWorld(OFFICE_SCENARIO);
  assert.equal(w.tick, 0);
  assert.equal(w.turnIndex, 0);
  assert.deepEqual(w.history, []);
  assert.equal(w.userActorId, "noah");
  assert.equal(w.presentation, undefined, "presentation must not leak into World");
  assert.equal(w.actors.length, 5);
  // source scenario untouched
  assert.equal(OFFICE_SCENARIO.actors[0].id, "noah");
});

await test("mock adapter: load → user turn → NPC turns → back to user", async () => {
  const adapter = new MockAdapter(OFFICE_SCENARIO, { stageDelayMs: 0, seed: 42 });
  const { world, presentation } = await adapter.load();
  assert.equal(world.userActorId, "noah");
  assert.ok(presentation?.actors?.maya?.look, "presentation returned for visuals");

  const turns = [];
  const progress = [];
  adapter.on("turn", (ev) => turns.push(ev));
  adapter.on("progress", (ev) => progress.push(ev));

  const after = await adapter.sendUserAction('walk over to Maya and say "Hi Maya, I\'m Noah!"');
  assert.ok(turns.length >= 2, `expected user + ≥1 NPC turn events, got ${turns.length}`);
  assert.equal(turns[0].isUser, true, "first turn is the user's");
  assert.equal(turns[0].actorId, "noah");
  assert.ok(turns[0].speech?.text?.includes("Hi Maya"), "quoted speech extracted for the bubble");
  assert.ok(turns.slice(1).some((t) => !t.isUser), "at least one NPC responded");
  assert.ok(progress.length > 0, "progress events emitted for the HUD");

  // world invariants
  assert.equal(after.history.length, turns.length);
  assert.equal(after.tick, turns.length, "tick advances once per individual turn");
  assert.equal(after.order[after.turnIndex % after.order.length], "noah", "control returns to the user");
  for (const a of after.actors) {
    assert.ok(a.x >= FLOOR_BOUNDS.minX - 1 && a.x <= FLOOR_BOUNDS.maxX + 1, `${a.id} x in bounds`);
    assert.ok(a.y >= FLOOR_BOUNDS.minY - 1 && a.y <= FLOOR_BOUNDS.maxY + 1, `${a.id} y in bounds`);
    assert.equal(typeof a.emotion, "string");
    assert.ok(a.thoughts.length > 0, `${a.id} has thoughts`);
  }
  // turn snapshots are independent clones
  assert.notEqual(turns[0].world, turns.at(-1).world);
  assert.ok(after.history[0].startsWith("Noah: "), "history follows 'Name: text' convention");
});

await test("mock adapter: 'go to the kitchen' moves the user actor", async () => {
  const adapter = new MockAdapter(OFFICE_SCENARIO, { stageDelayMs: 0, seed: 7 });
  const { world } = await adapter.load();
  const startY = world.actors.find((a) => a.id === "noah").y;
  const after = await adapter.sendUserAction("go to the kitchen and pour a coffee");
  const noah = after.actors.find((a) => a.id === "noah");
  assert.ok(Math.abs(noah.y - startY) > 50, `noah moved toward the kitchen (${startY} → ${noah.y})`);
});

await test("mock adapter: rejects empty actions and concurrent submits", async () => {
  const adapter = new MockAdapter(OFFICE_SCENARIO, { stageDelayMs: 0, seed: 1 });
  await adapter.load();
  await assert.rejects(() => adapter.sendUserAction("   "), /Empty action/);
  const p = adapter.sendUserAction("hello everyone");
  await assert.rejects(() => adapter.sendUserAction("again"), /already running/);
  await p;
});

await test("liveState: tweens position changes and expires bubbles", () => {
  const world = scenarioToWorld(OFFICE_SCENARIO);
  const live = new LiveState();
  live.init(world, OFFICE_SCENARIO.presentation);

  const maya0 = live.visualActor("maya");
  const maya0x = maya0.x; // snapshot by value — the visual actor mutates in place
  assert.equal(maya0.isUser, false);
  assert.equal(live.visualActor("noah").isUser, true);

  // move maya in a cloned world and apply
  const w2 = JSON.parse(JSON.stringify(world));
  const maya = w2.actors.find((a) => a.id === "maya");
  maya.x += 200;
  maya.emotion = "surprised";
  w2.history.push('Maya: walks across the floor and says "Oh!"');
  live.applyTurn({ world: w2, actorId: "maya", isUser: false, actionText: w2.history.at(-1), speech: { text: "Oh!", kind: "say" } });

  const v = live.visualActor("maya");
  assert.equal(v.emotion, "surprised");
  assert.ok(v.tween, "movement started a tween");
  assert.ok(Math.abs(v.x - (maya0x + 200)) > 10, "still mid-tween");

  // bubble shows immediately while the tween runs
  assert.equal(live.snapshot().bubbles.length, 1);

  // run the tween to completion
  for (let i = 0; i < 200; i++) live.frame(1 / 60);
  assert.equal(v.tween, null);
  assert.ok(Math.abs(v.x - (maya0x + 200)) < 0.01, "tween landed on target");

  // …and the bubble expires after its (shorter) lifetime
  assert.equal(live.snapshot().bubbles.length, 0, "bubble expired");
  assert.ok(live.caption.includes("Maya"), "caption shows the latest action");
});

await test("deriveDir picks the dominant axis", () => {
  assert.equal(deriveDir(10, 3), "right");
  assert.equal(deriveDir(-10, 3), "left");
  assert.equal(deriveDir(2, 9), "down");
  assert.equal(deriveDir(2, -9), "up");
  assert.equal(deriveDir(0, 0), null);
});

await test("textParse recovers quoted speech", () => {
  assert.equal(extractQuoted('says "hello there"'), "hello there");
  assert.equal(extractQuoted("says “curly quotes”"), "curly quotes");
  assert.equal(extractQuoted("waves silently"), null);
  assert.deepEqual(parseSpeechFromAction('Maya: thinks "maybe later"'), { text: "maybe later", kind: "thought" });
  assert.deepEqual(parseSpeechFromAction('Noah: says "hi"'), { text: "hi", kind: "say" });
  assert.equal(parseSpeechFromAction("Noah: waves"), null);
});

await test("presentation: explicit metadata wins, fallbacks are deterministic", () => {
  const world = scenarioToWorld(OFFICE_SCENARIO);
  const pres = resolvePresentation(OFFICE_SCENARIO.presentation, world.actors);
  assert.equal(pres.get("maya").color, "#2ec4a6");
  assert.equal(pres.get("maya").look.hairStyle, "bun");
  // no presentation → derived, stable across calls
  const bare = resolvePresentation(null, [{ id: "stranger-42", name: "X" }]);
  assert.deepEqual(bare.get("stranger-42"), deriveLook("stranger-42"));
});

await test("mapper scales arbitrary scene sizes onto the 1040×730 view", () => {
  const m = makeMapper(520, 365, 1040, 730);
  assert.equal(m.toViewX(260), 520);
  assert.equal(m.toViewY(365), 730);
  assert.equal(m.toWorldX(1040), 520);
});

await test("scenarioScene: bundled office keeps STATIC_SCENE", () => {
  const view = buildViewScene(
    { id: OFFICE_SCENARIO.id, title: OFFICE_SCENARIO.title, scene: OFFICE_SCENARIO.scene },
    OFFICE_SCENARIO.presentation,
  );
  assert.equal(view, STATIC_SCENE, "office must keep its pretty static scenery");
  assert.equal(isStaticOfficeScene({ id: "office_first_day" }, OFFICE_SCENARIO.presentation), true);
});

await test("scenarioScene: foreign scenario is driven by its own objects", async () => {
  const { readFile } = await import("node:fs/promises");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const anton = JSON.parse(await readFile(join(root, "scenarios/office-anton.json"), "utf-8"));
  assert.equal(isStaticOfficeScene(anton, null), false);
  const view = buildViewScene(anton, null);
  // no trace of the static office: walls/door come from the scenario
  assert.deepEqual(
    view.walls.map((w) => w.id).sort(),
    ["wall_east", "wall_north", "wall_south", "wall_west_lower", "wall_west_upper"],
  );
  assert.equal(view.door?.id, "door");
  const byId = new Map(view.assets.map((a) => [a.id, a.asset]));
  assert.equal(byId.get("tanya_desk"), "desk");
  assert.equal(byId.get("dana_desk"), "desk");
  assert.equal(byId.get("anton_desk"), "desk");
  assert.equal(byId.get("coffee_machine"), "coffeeMachine");
  assert.equal(byId.get("tanya_chair"), "chair");
  assert.equal(byId.get("sofa"), "sofa");
  assert.equal(byId.get("tanya_laptop"), "laptop");
  assert.equal(byId.get("tanya_mug"), "cup");
  assert.equal(byId.get("tanya_papers"), "papers");
  assert.deepEqual(
    view.windows.map((w) => w.id).sort(),
    ["window_north_1", "window_north_2", "window_north_3"],
  );
  // every scenario object is painted (no silent drops)
  const painted = new Set([
    ...view.walls.map((w) => w.id),
    ...(view.door ? [view.door.id] : []),
    ...view.windows.map((w) => w.id),
    ...view.assets.map((a) => a.id),
  ]);
  for (const o of anton.scene.objects) assert.ok(painted.has(o.id), `${o.id} must be painted`);
});

console.log(`\n${passed} test group(s) passed`);
if (process.exitCode) console.error("SMOKE TESTS FAILED");
