// tests/dom.mjs — integration test: boots preview.html (the bundle) inside
// jsdom and drives a real user turn through the composer.
//
// Canvas is not implemented in plain jsdom; the renderer degrades to no-ops
// by design (SceneRenderer.ready === false), so this test verifies the whole
// DOM/data path: boot → panels → submit → progress → turns → back to user.
//
// Usage: node tests/dom.mjs   (requires: npm i --no-save jsdom && npm run bundle)

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const html = await readFile(join(ROOT, "preview.html"), "utf-8");
const errors = [];
const virtualConsole = new VirtualConsole()
  .on("jsdomError", (e) => errors.push(String(e.message || e)))
  .on("error", (...a) => errors.push(a.join(" ")))
  .on("warn", () => {});
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true, // provides requestAnimationFrame
  url: "http://localhost/",
  virtualConsole,
});
const { window } = dom;
const { document } = window;

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

console.log("dom integration tests (jsdom + preview.html bundle)");

await sleep(400); // let boot settle

await test("boot: no uncaught errors", () => {
  const fatal = errors.filter((e) => !/Could not parse CSS|getContext/i.test(e));
  assert.deepEqual(fatal, [], `jsdom errors: ${fatal.join(" | ")}`);
});

await test("boot: topbar + HUD initialised from the scenario", () => {
  assert.match(document.getElementById("pillTitle").textContent, /First Day/);
  assert.equal(document.getElementById("pillCast").textContent, "5");
  assert.match(document.getElementById("pillEngine").textContent, /mock/i);
  assert.match(document.getElementById("hudState").textContent, /LIVE/i);
  assert.match(document.getElementById("hudState").textContent, /Noah/i, "HUD names the user actor");
});

await test("boot: cast panel lists all actors, user badged", () => {
  const rows = document.querySelectorAll("#castList .castrow");
  assert.equal(rows.length, 5);
  assert.equal(document.querySelectorAll("#castList .castrow.you").length, 1);
  assert.ok(document.querySelector("#castList .you-badge"));
});

await test("boot: log shows the opening narrative", () => {
  assert.match(document.getElementById("logList").textContent, /Northlight/);
});

await test("boot: composer enabled with send disabled while empty", () => {
  const ta = document.getElementById("composerInput");
  const send = document.getElementById("composerSend");
  assert.equal(ta.disabled, false);
  assert.equal(send.disabled, true, "empty input must not send");
  ta.value = "hello";
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(send.disabled, false);
  ta.value = "";
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
});

await test("submit via Enter: busy state, progress, NPC turns, back to user", async () => {
  const ta = document.getElementById("composerInput");
  const send = document.getElementById("composerSend");
  const status = document.getElementById("composerStatus");

  ta.value = 'walk over to Maya and say "Hi Maya, excited to start!"';
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  await sleep(50);
  assert.equal(ta.value, "", "input cleared on submit");
  assert.equal(ta.disabled, true, "input locked while turns resolve");
  assert.equal(send.disabled, true);
  assert.ok(status.classList.contains("busy"), "status shows busy");

  // wait for the whole round (mock stages ≈ 0.4s each, ≤5 turns)
  for (let i = 0; i < 120 && ta.disabled; i++) await sleep(100);
  assert.equal(ta.disabled, false, "input re-enabled when it's the user's turn again");
  assert.match(document.getElementById("hudState").textContent, /LIVE/i);

  const log = document.getElementById("logList").textContent;
  assert.match(log, /walk over to Maya/, "user action logged");
  assert.match(log, /Hi Maya, excited to start!/, "speech preserved in history");
  const entries = document.querySelectorAll("#logList .ev");
  assert.ok(entries.length >= 3, `expected user + NPC entries, got ${entries.length}`);
  assert.ok(document.querySelector("#logList .ev.is-user"), "user entry highlighted");
  assert.match(document.getElementById("captionText").textContent, /.+/, "caption updated");
  assert.notEqual(document.getElementById("pillTick").textContent, "0", "tick advanced");
});

await test("cast panel reflects new emotions/lines after the round", () => {
  const text = document.getElementById("castList").textContent;
  assert.match(text, /💬|💭/, "some actor has a speech line");
});

await test("JSON pane renders the live world", () => {
  document.querySelector('.tabs button[data-pane="data"]').click();
  const out = document.getElementById("jsonOut").textContent;
  assert.match(out, /"userActorId"/);
  assert.match(out, /"noah"/);
  document.querySelector('.tabs button[data-pane="cast"]').click();
});

await test("toggle buttons flip their state", () => {
  const tg = document.getElementById("tgNames");
  assert.ok(tg.classList.contains("on"));
  tg.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.ok(!tg.classList.contains("on"));
  tg.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.ok(tg.classList.contains("on"));
});

await test("no transport controls remain in the DOM", () => {
  for (const id of ["btnPlay", "btnPrev", "btnNext", "btnRestart", "track", "speeds"]) {
    assert.equal(document.getElementById(id), null, `${id} must be gone`);
  }
});

console.log(`\n${passed} dom test group(s) passed`);
if (process.exitCode) console.error("DOM TESTS FAILED");
window.close();
