// data/scenarioScene.js — build the *view* scene from the loaded World.
//
// The renderer used to always paint STATIC_SCENE (Northlight Studio: sofa,
// 4 desk pods, lounge, kitchen…). That is only correct for the bundled
// office scenario. Any other scenario (e.g. scenarios/office-anton.json, a
// 20×20 grid with walls/door/desks) must drive the visuals instead:
//
//   world.scene.objects → floor / walls / door / furniture assets
//
// Convention note: engine worlds use top-left x/y + w/h rects in scene
// units (see src/engine/geometry.ts). The canvas renderer paints in
// 1040×730 view units with x/y as the footprint CENTER, so this module maps
// one to the other with the same stretch mapper liveState.js uses for
// actors (makeMapper), keeping furniture and characters aligned.
//
// Selection rule (see sim/presentation.js for the actor-side equivalent):
//   • presentation?.scene?.staticScene === "office_floor3" (or the world id
//     is "office_first_day") → return STATIC_SCENE verbatim (pretty office).
//   • otherwise → derive a scene from world.scene.objects. Recognised
//     furniture gets a pretty asset renderer (desk, coffee machine, …);
//     anything unrecognised falls through to the renderer's generic labelled
//     box (sceneRenderer skips only ids it knows as assets).

import { STATIC_SCENE } from "./staticScene.js";
import { makeMapper } from "../sim/presentation.js";

export const VIEW_W = 1040;
export const VIEW_H = 730;

/** True when the world is the bundled pretty office (keep STATIC_SCENE). */
export function isStaticOfficeScene(world, presentation) {
  if (!world) return false;
  if (presentation?.scene?.staticScene === "office_floor3") return true;
  return world.id === "office_first_day";
}

/**
 * Build a STATIC_SCENE-shaped view scene for any world.
 * @param {object} world engine World ({ id, title, scene: { width, height, objects } })
 * @param {object|null} presentation scenario presentation block (or null)
 * @returns {object} view scene (STATIC_SCENE for the bundled office)
 */
export function buildViewScene(world, presentation) {
  if (isStaticOfficeScene(world, presentation)) return STATIC_SCENE;

  const sceneW = Math.max(1, world?.scene?.width || 20);
  const sceneH = Math.max(1, world?.scene?.height || 20);
  const mapper = makeMapper(sceneW, sceneH, VIEW_W, VIEW_H);
  const toVX = (x) => x * mapper.kx;
  const toVY = (y) => y * mapper.ky;

  const objects = Array.isArray(world?.scene?.objects) ? world.scene.objects : [];

  // Floor covers nearly the whole view so stretched small-grid scenes always
  // land on planks (actors map with the same mapper in liveState.js).
  const floor = { x: 40, y: 90, w: 960, h: 570, plank: 56, base: "#efe3cf", tone: "#e6d8bf" };
  // No corridor strip for generic rooms; kept zero-sized because
  // paintBackground expects the key to exist.
  const corridor = { x: 0, y: VIEW_H, w: 0, h: 0, color: "#1b2438" };

  const walls = [];
  const windows = [];
  const wallDecor = [];
  const floorDecals = [];
  const lightPatches = [];
  let door = null;
  const assets = [];

  for (const o of objects) {
    const kind = classifyObject(o);
    const vx = toVX(o.x || 0);
    const vy = toVY(o.y || 0);
    const vw = Math.max(8, (o.w || 1) * mapper.kx);
    const vh = Math.max(8, (o.h || 1) * mapper.ky);
    const cx = toVX((o.x || 0) + (o.w || 0) / 2);
    const cy = toVY((o.y || 0) + (o.h || 0) / 2);

    if (kind === "wall") {
      const front = vy + vh >= 640;
      walls.push({
        id: o.id,
        x: vx,
        y: vy,
        w: vw,
        h: vh,
        height: front ? 16 : 70,
        face: front ? "#c4cde0" : "#dfe5f2",
        top: front ? "#e6ebf6" : "#f4f7fd",
        layer: front ? "front" : "back",
      });
    } else if (kind === "window") {
      // North-wall windows paint on the wall face (like STATIC_SCENE:
      // wall top ≈ y40, floor starts at y90) so they read as top-view
      // glazing; the scenario x/width drives the horizontal placement.
      const win = {
        id: o.id,
        wall: "wall_north",
        x: vx + 2,
        y: 48,
        w: Math.max(60, vw - 4),
        h: 42,
        view: "city",
      };
      windows.push(win);
      lightPatches.push({ x: win.x, w: win.w });
    } else if (kind === "door") {
      door = {
        id: o.id,
        x: vx,
        y: vy,
        w: Math.max(40, vw),
        h: Math.max(14, vh),
        frame: "#8f6b45",
        label: String(o.name || "DOOR").toUpperCase().slice(0, 18),
      };
    } else {
      const asset = assetForObject(o, cx, cy, vw, vh);
      if (asset) assets.push(asset);
      // Unrecognised objects get no asset entry: sceneRenderer draws them
      // as labelled generic boxes from liveState's mapped `objects` list.
    }
  }

  // Lounge rug under the first sofa so the corner reads as a zone.
  const sofaAsset = assets.find((a) => a.asset === "sofa");
  if (sofaAsset) {
    floorDecals.push({
      id: "rugLounge", asset: "rug",
      x: sofaAsset.x + 40, y: sofaAsset.y,
      w: 290, h: 215, color: "#4f7cff", trim: "#9b6cf5",
    });
  }

  return {
    meta: {
      name: world?.title || "Scenario room",
      style: "gem-flat 2.5D",
      projection: "plan + vertical extrusion",
      world: { w: VIEW_W, h: VIEW_H },
    },
    floor,
    corridor,
    walls,
    windows,
    door,
    wallDecor,
    floorDecals,
    lightPatches,
    assets,
  };
}

/** wall / window / door / furniture — matched on id + name + description. */
function classifyObject(o) {
  const hay = `${o.id || ""} ${o.name || ""}`.toLowerCase();
  if (/window|glazing/.test(hay)) return "window";
  if (/(^|[^a-z])walls?([^a-z]|$)|(^|[^a-z])wall([^a-z]|$)/.test(hay)) return "wall";
  if (/door|entrance|gate|exit/.test(hay)) return "door";
  return "furniture";
}

/**
 * Pretty asset descriptor for a furniture object (view units, CENTER x/y),
 * or null when no asset renderer fits (generic fallback box takes over).
 */
function assetForObject(o, cx, cy, vw, vh) {
  // Match on id + name only: descriptions mention contents ("a desk with a
  // laptop", "a mug on the lounge table") and would misclassify furniture.
  const hay = `${o.id || ""} ${o.name || ""}`.toLowerCase();
  const base = { id: o.id };
  const palette = ["#4f7cff", "#2ec4a6", "#9b6cf5", "#ffb648", "#ff5d7a"];
  const pick = palette[hashId(o.id) % palette.length];
  if (/round table|lounge table|coffee table/.test(hay)) {
    const r = Math.max(40, Math.min(vw, vh) / 2);
    return { ...base, asset: "roundTable", x: cx, y: cy, r, h: 42, t: 9, color: "#f7f0e4", edge: "#c9b694" };
  }
  if (/laptop|notebook|macbook/.test(hay)) {
    return { ...base, asset: "laptop", x: cx, y: cy, z: 44, sort: cy + 10 };
  }
  if (/\bmugs?\b|\bcups?\b|glass|bottle/.test(hay)) {
    return { ...base, asset: "cup", x: cx, y: cy, z: 44, color: pick, sort: cy + 11 };
  }
  if (/papers?|documents?|notes?|books?|files?|folder/.test(hay)) {
    return { ...base, asset: "papers", x: cx, y: cy, z: 44, sort: cy + 12 };
  }
  if (/lamp/.test(hay)) {
    return { ...base, asset: "lamp", x: cx, y: cy, z: 44, sort: cy + 13 };
  }
  if (/chair|stool|seat|bench/.test(hay)) {
    return { ...base, asset: "chair", x: cx, y: cy, dir: "down", color: pick };
  }
  if (/desk|table|workstation|cubicle/.test(hay)) {
    return {
      ...base, asset: "desk", x: cx, y: cy,
      w: Math.max(70, vw), d: Math.max(34, vh), h: 44, t: 10,
      color: "#f4ece0", edge: "#c9b694",
    };
  }
  if (/sofa|couch|lounge|settee/.test(hay)) {
    return {
      ...base, asset: "sofa", x: cx, y: cy,
      w: Math.max(50, vw), d: Math.max(60, vh), dir: "right", color: "#9b6cf5",
    };
  }
  if (/coffee|espresso/.test(hay)) {
    return { ...base, asset: "coffeeMachine", x: cx, y: cy };
  }
  if (/counter|kitchen|kettle|sink/.test(hay) || /cupboard/.test(hay)) {
    return {
      ...base, asset: "counter", x: cx, y: cy,
      w: Math.max(80, vw), d: Math.max(30, vh), h: 58, color: "#eaeef7", top: "#2b3550",
    };
  }
  if (/cooler|water/.test(hay)) {
    return {
      ...base, asset: "waterCooler", x: cx, y: cy,
      w: Math.max(36, vw), d: Math.max(30, vh), h: 48,
    };
  }
  if (/cabinet|shelf|storage|wardrobe|locker|drawer/.test(hay)) {
    return {
      ...base, asset: "cabinet", x: cx, y: cy,
      w: Math.max(70, vw), d: Math.max(30, vh), h: 68, color: "#5b6b8c",
    };
  }
  if (/printer|copier|scanner/.test(hay)) {
    return {
      ...base, asset: "printer", x: cx, y: cy,
      w: Math.max(50, vw), d: Math.max(30, vh), h: 46, color: "#dfe5f0",
    };
  }
  if (/crate|box|parcel/.test(hay)) {
    return { ...base, asset: "crates", x: cx, y: cy };
  }
  if (/plant|fern|flower|pot/.test(hay)) {
    return { ...base, asset: "plant", x: cx, y: cy, s: 1.0, pot: "#2ec4a6" };
  }
  if (/whiteboard|board|flipchart/.test(hay)) {
    // Wall-mounted: no floor asset fits; generic box labels it instead.
    return null;
  }
  // Anything unknown → generic box.
  return null;
}

function hashId(id) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
