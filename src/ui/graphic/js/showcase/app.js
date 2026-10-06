// showcase/app.js — thin gallery view-model (showcase pattern).
//
// Binds the pure core (core.js: registry / select / URL codec) to the DOM:
// sidebar list, canvas stage, N/E/S/W segmented control and props readout.
// Router-agnostic: syncs `?file=..&showcase=..` via window.history + popstate,
// mirroring AntonLapshin/showcase `useShowcase.ts`.

import {
  createShowcaseRegistry,
  createShowcaseState,
  select,
  encodeUrlPath,
  decodeUrlPath,
} from "./core.js";
import { showcaseFiles } from "./files.js";
import { variantProps } from "../render/objects/index.js";

const STAGE = { w: 560, h: 400 };

/** Wall-mounted pieces hang in the upper half; floor pieces stand lower. */
const WALL_MOUNTED = new Set(["wall", "window", "door", "whiteboard", "clock", "poster"]);

function placement(module, props) {
  const p = { ...props };
  if (WALL_MOUNTED.has(module.name)) {
    const w = p.w || 180;
    p.x = STAGE.w / 2 - w / 2;
    // Wall segments paint downward from y; decor hangs near the top.
    p.y = module.name === "wall" ? 150 : 130;
    if (module.name === "clock") {
      p.x = STAGE.w / 2;
      p.y = 150;
    }
    if (module.name === "door") {
      p.x = STAGE.w / 2 - p.w / 2;
      p.y = 170;
    }
    return p;
  }
  if (module.name === "rug" || module.name === "zone") {
    p.x = STAGE.w / 2;
    p.y = STAGE.h / 2;
    return p;
  }
  p.x = STAGE.w / 2;
  p.y = Math.round(STAGE.h * 0.62);
  return p;
}

function paintStage(ctx, module, props) {
  const { w: W, h: H } = STAGE;
  ctx.clearRect(0, 0, W, H);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0d1526");
  bg.addColorStop(1, "#080d18");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // faint studio grid
  ctx.strokeStyle = "rgba(255,255,255,.045)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 28) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 28) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
    ctx.stroke();
  }
  // floor line for standing objects
  if (!WALL_MOUNTED.has(module.name) && module.name !== "rug" && module.name !== "zone") {
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(40, props.y + 14.5);
    ctx.lineTo(W - 40, props.y + 14.5);
    ctx.stroke();
  }
  try {
    module.draw(ctx, props);
  } catch (err) {
    console.error(`[showcase:${module.name}]`, err);
    ctx.fillStyle = "#ff5d7a";
    ctx.font = "600 13px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`render error: ${err.message}`, W / 2, H / 2);
    ctx.textAlign = "left";
  }
}

function fitCanvas(canvas) {
  try {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = STAGE.w * dpr;
    canvas.height = STAGE.h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null; // headless DOM (plain jsdom): sidebar/seg still work
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  } catch {
    return null;
  }
}

function main() {
  const registry = createShowcaseRegistry(showcaseFiles);
  const canvas = document.getElementById("scCanvas");
  const ctx = fitCanvas(canvas);
  const listEl = document.getElementById("scList");
  const titleEl = document.getElementById("scTitle");
  const subEl = document.getElementById("scSub");
  const segEl = document.getElementById("scSeg");
  const segNote = document.getElementById("scSegNote");
  const propsEl = document.getElementById("scProps");
  const countEl = document.getElementById("scCount");

  countEl.textContent = `${registry.files.length} objects`;

  // sidebar rows
  const rows = new Map();
  for (const f of registry.files) {
    const b = document.createElement("button");
    b.className = "sc-item";
    b.dataset.file = f.name;
    const dot = document.createElement("i");
    b.append(dot, document.createTextNode(f.name));
    b.addEventListener("click", () => apply(select(state, registry, f.name, firstVariant(f)), true));
    listEl.append(b);
    rows.set(f.name, b);
  }

  function firstVariant(f) {
    return Object.keys(f.showcases)[0];
  }

  let state = createShowcaseState();
  // initial selection from the URL (deep-linking), else the first file
  const initial = decodeUrlPath(location.search);
  state = select(state, registry, initial.file, initial.showcase);

  function render() {
    const file = registry.byName.get(state.file);
    const module = file.module;
    const props = placement(module, variantProps(module, state.showcase));
    // sidebar active
    rows.forEach((b, name) => b.classList.toggle("on", name === file.name));
    // header
    titleEl.textContent = file.name;
    subEl.textContent = `${module.name} · ${module.supportsDirection ? "rotatable" : "fixed view"}${module.name === "window" ? " · City/Hills views" : ""}`;
    // segmented control: one button per variant; hidden for single Default
    segEl.innerHTML = "";
    const variants = Object.keys(file.showcases);
    if (variants.length === 1 && variants[0] === "Default") {
      segEl.style.display = "none";
      segNote.style.display = "";
      segNote.textContent = "fixed view — no rotation";
    } else {
      segEl.style.display = "";
      segNote.style.display = "none";
      for (const v of variants) {
        const b = document.createElement("button");
        b.textContent = v;
        b.className = v === state.showcase ? "on" : "";
        b.setAttribute("role", "tab");
        b.addEventListener("click", () => apply(select(state, registry, file.name, v), true));
        segEl.append(b);
      }
    }
    // stage + props (stage skipped headless — props + sidebar still render)
    if (ctx) {
      try {
        paintStage(ctx, module, props);
      } catch (err) {
        console.error(`[showcase:${module.name}]`, err);
      }
    }
    propsEl.textContent = JSON.stringify(props, null, 2);
  }

  function apply(next, push) {
    state = next;
    if (push) history.pushState(state, "", encodeUrlPath(state) || location.pathname);
    render();
  }

  window.addEventListener("popstate", (ev) => {
    if (ev.state && ev.state.file) {
      state = select(createShowcaseState(), registry, ev.state.file, ev.state.showcase);
    } else {
      const q = decodeUrlPath(location.search);
      state = select(createShowcaseState(), registry, q.file, q.showcase);
    }
    render();
  });

  // repaint once webfonts land so canvas text metrics are final
  (document.fonts?.ready ?? Promise.resolve()).then(() => render()).catch(() => {});
  render();
}

main();
