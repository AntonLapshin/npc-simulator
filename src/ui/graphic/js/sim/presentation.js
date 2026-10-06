// sim/presentation.js — visual metadata resolution and coordinate mapping.
//
// The engine's Actor type carries no looks/colors (semantic content is
// free-form). Scenarios may ship a UI-only `presentation` block; anything
// missing gets a deterministic fallback derived from the actor id, so the UI
// renders sensibly for *any* world the engine hands it.

import { hashStr, mulberry } from "../core/utils.js";

const SKINS = [
  ["#f2cba6", "#e0b189"],
  ["#c98a5e", "#b0744a"],
  ["#e2a97c", "#c98f63"],
  ["#ffe0cb", "#eec7ae"],
  ["#8d5a3b", "#78492e"],
  ["#f6d7c4", "#e4bfa8"],
];
const HAIRS = [
  ["#3d2a20", "short"],
  ["#22191a", "bun"],
  ["#2b1f22", "long"],
  ["#b5502f", "ponytail"],
  ["#191315", "curly"],
  ["#5a4632", "short"],
];
const SHIRTS = [
  ["#7fb6ff", "#5b95e8"],
  ["#2ec4a6", "#1f9e85"],
  ["#9b6cf5", "#7d51d3"],
  ["#ffb648", "#e2952c"],
  ["#ff5d7a", "#dd3f5e"],
  ["#69d2c8", "#48b0a6"],
];
const PANTS = [
  ["#39435c", "#1e2434"],
  ["#2b3550", "#1a2032"],
  ["#3a3357", "#221d33"],
  ["#4a6fa5", "#26313f"],
  ["#2c3444", "#171d29"],
];
const ACCENTS = ["#4f7cff", "#2ec4a6", "#9b6cf5", "#ffb648", "#ff5d7a", "#57d8be"];

/** Deterministic look/color for an actor id (used when presentation lacks one). */
export function deriveLook(actorId) {
  const rnd = mulberry(hashStr(String(actorId)));
  const skin = SKINS[Math.floor(rnd() * SKINS.length)];
  const hair = HAIRS[Math.floor(rnd() * HAIRS.length)];
  const shirt = SHIRTS[Math.floor(rnd() * SHIRTS.length)];
  const pants = PANTS[Math.floor(rnd() * PANTS.length)];
  return {
    color: ACCENTS[Math.floor(rnd() * ACCENTS.length)],
    role: "",
    prop: null,
    look: {
      skin: skin[0],
      skin2: skin[1],
      hair: hair[0],
      hairStyle: hair[1],
      shirt: shirt[0],
      shirt2: shirt[1],
      pants: pants[0],
      shoes: pants[1],
    },
  };
}

/**
 * Resolve presentation metadata for every actor of a world.
 * @param {object|null} presentation scenario.presentation ({actors:{id:{…}}})
 * @param {Array} actors world.actors
 * @returns {Map<string,{color:string,role:string,prop:string|null,look:object}>}
 */
export function resolvePresentation(presentation, actors) {
  const byId = (presentation && presentation.actors) || {};
  const map = new Map();
  for (const a of actors) {
    const p = byId[a.id] || {};
    const derived = deriveLook(a.id);
    map.set(a.id, {
      color: p.color || derived.color,
      role: p.role || "",
      prop: p.prop ?? derived.prop,
      look: Object.assign({}, derived.look, p.look || {}),
    });
  }
  return map;
}

/**
 * World coords → canvas view coords. The office scenario uses a 1040×730
 * scene (identity); other worlds are stretched to fill the same view.
 */
export function makeMapper(sceneW, sceneH, viewW, viewH) {
  const kx = viewW / Math.max(1, sceneW);
  const ky = viewH / Math.max(1, sceneH);
  return {
    kx,
    ky,
    toViewX: (x) => x * kx,
    toViewY: (y) => y * ky,
    toWorldX: (vx) => vx / kx,
    toWorldY: (vy) => vy / ky,
  };
}
