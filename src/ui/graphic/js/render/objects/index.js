// render/objects/index.js — object registry (showcase pattern).
//
// Mirrors https://github.com/AntonLapshin/showcase: every object file exports
// one uniquely-named showcase object (single-export pattern — the bundler in
// tools/bundle.mjs concatenates modules into one scope, so generic `draw` /
// `name` exports would collide). This index registers them as showcase files
// so the gallery, the scene renderer and the scenario builder all share one
// source of truth. No hardcoded scene lives here.

import { Desk } from "./desk.js";
import { RoundTable } from "./roundTable.js";
import { Chair } from "./chair.js";
import { Stool } from "./stool.js";
import { Laptop } from "./laptop.js";
import { Cup } from "./cup.js";
import { CupRow } from "./cupRow.js";
import { Papers } from "./papers.js";
import { Lamp } from "./lamp.js";
import { DeskSign } from "./deskSign.js";
import { Counter } from "./counter.js";
import { CoffeeMachine } from "./coffeeMachine.js";
import { Kettle } from "./kettle.js";
import { WaterCooler } from "./waterCooler.js";
import { Cabinet } from "./cabinet.js";
import { Printer } from "./printer.js";
import { Crates } from "./crates.js";
import { Sofa } from "./sofa.js";
import { Plant } from "./plant.js";
import { Wall } from "./wall.js";
import { Win } from "./window.js";
import { Door } from "./door.js";
import { Whiteboard } from "./whiteboard.js";
import { Clock } from "./clock.js";
import { Poster } from "./poster.js";
import { Rug } from "./rug.js";
import { Zone } from "./zone.js";
import { Character } from "./character.js";

/** All object modules in sidebar order (furniture → scenery → character). */
export const OBJECT_MODULES = [
  Desk, RoundTable, Chair, Stool, Laptop, Cup, CupRow, Papers, Lamp,
  DeskSign, Counter, CoffeeMachine, Kettle, WaterCooler, Cabinet,
  Printer, Crates, Sofa, Plant,
  Wall, Win, Door, Whiteboard, Clock, Poster, Rug, Zone,
  Character,
];

/** name → module (e.g. OBJECTS.chair.draw). */
export const OBJECTS = {};
for (const m of OBJECT_MODULES) OBJECTS[m.name] = m;

/** ShowcaseFile entries in the AntonLapshin/showcase shape. */
export const showcaseFiles = OBJECT_MODULES.map((m) => ({
  name: m.title || m.name,
  key: m.name,
  module: m,
  showcases: Object.fromEntries(
    (m.variants || ["Default"]).map((v) => [v, variantProps(m, v)]),
  ),
}));

/** Props override for a named variant (direction or decor view). */
export function variantProps(module, variant) {
  const base = { ...module.defaultProps };
  if (module.supportsDirection && variant !== "Default") {
    base.dir = variant;
  }
  if (module.name === "window") {
    base.view = variant === "Hills" ? "hills" : "city";
  }
  return base;
}

/** asset type → draw fn, backwards-compatible with render/assets.js. */
export const ASSET_DRAW = {};
for (const m of OBJECT_MODULES) ASSET_DRAW[m.name] = m.draw;

/** Draw one asset descriptor { asset, … } via its object module. */
export function drawAsset(c, a) {
  const fn = ASSET_DRAW[a.asset];
  if (fn) fn(c, a);
}

/** Painters-order key, delegating to each object's sortY when present. */
export function assetSortY(a) {
  if (typeof a.sort === "number") return a.sort;
  const m = OBJECTS[a.asset];
  if (m && typeof m.sortY === "function") {
    try {
      return m.sortY(a);
    } catch {
      return a.y + (a.d || 0) / 2;
    }
  }
  if (a.asset === "roundTable") return a.y + (a.r || 60) * 0.5 * 0.9;
  if (a.asset === "plant") return a.y + 8;
  return a.y + (a.d || 0) / 2;
}
