// tests/render.mjs — visual check: boots the bundle in jsdom *with* the
// node-canvas backend, runs a user turn, and saves canvas frames to PNG so
// the 2.5D scene can be inspected without a browser.
//
// Usage: npm i --no-save jsdom canvas && npm run bundle && node tests/render.mjs
// Output: tests/out/frame-boot.png, tests/out/frame-turn.png

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/", virtualConsole });
const { window } = dom;
const { document } = window;

async function saveFrame(name) {
  const canvas = document.getElementById("scene");
  const dataUrl = canvas.toDataURL("image/png");
  const b64 = dataUrl.split(",")[1];
  const out = join(ROOT, "tests/out", name);
  await writeFile(out, Buffer.from(b64, "base64"));
  console.log(`saved ${out} (${canvas.width}×${canvas.height})`);
}

await sleep(700); // boot + fonts + first frames
await saveFrame("frame-boot.png");

// drive one user turn and capture mid-animation (NPC walking / bubbles)
const ta = document.getElementById("composerInput");
ta.value = 'walk over to Maya and say "Hi Maya! What should I work on first?"';
ta.dispatchEvent(new window.Event("input", { bubbles: true }));
ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(2600); // mid-round: tweens + bubbles visible
await saveFrame("frame-turn.png");

for (let i = 0; i < 150 && ta.disabled; i++) await sleep(100);
await sleep(400);
await saveFrame("frame-after.png");

const fatal = errors.filter((e) => !/Could not parse CSS/i.test(e));
if (fatal.length) {
  console.error("jsdom errors:", fatal.join("\n"));
  process.exitCode = 1;
} else {
  console.log("render test OK — no runtime errors");
}
window.close();
