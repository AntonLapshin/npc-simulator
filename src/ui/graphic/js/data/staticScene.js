// data/staticScene.js — the static office *visual* layout (prototype §2).
//
// This is presentation-only scenery: walls, windows, floor, decals and the
// furniture asset list the canvas renderer paints. Simulation truth lives in
// the World-format scenario (data/officeScenario.js); where a scenario scene
// object shares an `id` with an asset below, the renderer knows it is already
// painted here and skips the generic object box.

export const STATIC_SCENE = {
  meta: {
    name: "Northlight Studio · Floor 3",
    style: "gem-flat 2.5D",
    projection: "plan + vertical extrusion",
    world: { w: 1040, h: 730 },
  },
  floor: { x: 60, y: 110, w: 920, h: 550, plank: 56, base: "#efe3cf", tone: "#e6d8bf" },
  corridor: { x: 435, y: 680, w: 130, h: 50, color: "#1b2438" },
  walls: [
    { id: "wN", x: 40, y: 90, w: 960, h: 20, height: 70, face: "#dfe5f2", top: "#f4f7fd", layer: "back" },
    { id: "wW", x: 40, y: 90, w: 20, h: 590, height: 70, face: "#d3dae9", top: "#eef2fa", layer: "back" },
    { id: "wE", x: 980, y: 90, w: 20, h: 590, height: 70, face: "#cbd3e4", top: "#e8edf8", layer: "back" },
    { id: "wSa", x: 40, y: 660, w: 395, h: 20, height: 16, face: "#c4cde0", top: "#e6ebf6", layer: "front" },
    { id: "wSb", x: 565, y: 660, w: 435, h: 20, height: 16, face: "#c4cde0", top: "#e6ebf6", layer: "front" },
  ],
  windows: [
    { id: "win1", wall: "wN", x: 110, y: 50, w: 180, h: 46, view: "city" },
    { id: "win2", wall: "wN", x: 400, y: 50, w: 170, h: 46, view: "city" },
    { id: "win3", wall: "wN", x: 650, y: 50, w: 180, h: 46, view: "hills" },
  ],
  door: { id: "door1", x: 435, y: 660, w: 130, h: 20, frame: "#8f6b45", label: "ENTRANCE" },
  wallDecor: [
    { id: "board1", asset: "whiteboard", x: 852, y: 48, w: 132, h: 50, ink: "#4f7cff" },
    { id: "clock1", asset: "clock", x: 333, y: 64, r: 15 },
    { id: "poster1", asset: "poster", x: 588, y: 50, w: 36, h: 46, color: "#ff5d7a" },
  ],
  floorDecals: [
    { id: "rugLounge", asset: "rug", x: 205, y: 285, w: 290, h: 215, color: "#4f7cff", trim: "#9b6cf5" },
    { id: "rugEntrance", asset: "rug", x: 500, y: 616, w: 212, h: 76, color: "#2ec4a6", trim: "#ffb648" },
    { id: "zoneDesk", asset: "zone", x: 770, y: 390, w: 400, h: 330, color: "#ffb648", label: "DESK POD · A/B" },
    { id: "zoneLounge", asset: "zone", x: 205, y: 285, w: 300, h: 230, color: "#4f7cff", label: "LOUNGE" },
    { id: "zoneKitchen", asset: "zone", x: 520, y: 170, w: 260, h: 110, color: "#2ec4a6", label: "KITCHEN" },
  ],
  lightPatches: [{ x: 110, w: 180 }, { x: 400, w: 170 }, { x: 650, w: 180 }],

  assets: [
    /* ── lounge ─────────────────────────────────────────────── */
    { id: "tbl_lounge", asset: "roundTable", x: 205, y: 272, r: 74, h: 42, t: 9, color: "#f7f0e4", edge: "#c9b694" },
    { id: "ch_l1", asset: "chair", x: 205, y: 202, dir: "down", color: "#4f7cff" },
    { id: "ch_l2", asset: "chair", x: 112, y: 272, dir: "right", color: "#9b6cf5" },
    { id: "ch_l3", asset: "chair", x: 298, y: 272, dir: "left", color: "#2ec4a6" },
    { id: "ch_l4", asset: "chair", x: 205, y: 344, dir: "up", color: "#ffb648" },
    { id: "cup_l1", asset: "cup", x: 178, y: 262, z: 42, color: "#ff5d7a", sort: 305.6 },
    { id: "cup_l2", asset: "cup", x: 238, y: 286, z: 42, color: "#4f7cff", sort: 305.7 },
    { id: "notes", asset: "papers", x: 206, y: 274, z: 42, sort: 305.8 },

    /* ── kitchen ────────────────────────────────────────────── */
    { id: "counter", asset: "counter", x: 520, y: 158, w: 242, d: 58, h: 58, color: "#eaeef7", top: "#2b3550" },
    { id: "coffee", asset: "coffeeMachine", x: 452, y: 152, z: 58, sort: 187.2 },
    { id: "kettle", asset: "kettle", x: 536, y: 150, z: 58, color: "#ff5d7a", sort: 187.3 },
    { id: "cups", asset: "cupRow", x: 602, y: 154, z: 58, sort: 187.4 },
    { id: "cooler", asset: "waterCooler", x: 372, y: 170, w: 44, d: 42, h: 48 },
    { id: "stool1", asset: "stool", x: 474, y: 240, color: "#ffb648" },

    /* ── west wall / storage ────────────────────────────────── */
    { id: "sofa", asset: "sofa", x: 112, y: 402, w: 66, d: 172, dir: "right", color: "#9b6cf5" },
    { id: "cabinet", asset: "cabinet", x: 160, y: 546, w: 190, d: 60, h: 68, color: "#5b6b8c" },
    { id: "crates", asset: "crates", x: 296, y: 524, color: "#c98a5e" },
    { id: "printer", asset: "printer", x: 330, y: 600, w: 92, d: 64, h: 46, color: "#dfe5f0" },
    { id: "plant5", asset: "plant", x: 386, y: 520, s: 0.85, pot: "#2ec4a6" },

    /* ── desk pod ───────────────────────────────────────────── */
    { id: "deskA1", asset: "desk", x: 660, y: 280, w: 170, d: 76, h: 44, t: 10, color: "#f4ece0", edge: "#c9b694" },
    { id: "deskA2", asset: "desk", x: 860, y: 280, w: 170, d: 76, h: 44, t: 10, color: "#f4ece0", edge: "#c9b694" },
    { id: "deskB1", asset: "desk", x: 660, y: 500, w: 170, d: 76, h: 44, t: 10, color: "#f4ece0", edge: "#c9b694" },
    { id: "deskB2", asset: "desk", x: 860, y: 500, w: 170, d: 76, h: 44, t: 10, color: "#f4ece0", edge: "#c9b694" },

    { id: "chA1", asset: "chair", x: 660, y: 216, dir: "down", color: "#2ec4a6" },
    { id: "chA2", asset: "chair", x: 862, y: 216, dir: "down", color: "#4f7cff" },
    { id: "chB1", asset: "chair", x: 664, y: 436, dir: "down", color: "#9b6cf5" },
    { id: "chB2", asset: "chair", x: 860, y: 436, dir: "down", color: "#ff5d7a" },

    { id: "lapA1", asset: "laptop", x: 630, y: 258, z: 44, sort: 318.2 },
    { id: "lapA2", asset: "laptop", x: 830, y: 258, z: 44, sort: 318.3 },
    { id: "lapB1", asset: "laptop", x: 628, y: 478, z: 44, sort: 538.2 },
    { id: "lapB2", asset: "laptop", x: 830, y: 478, z: 44, sort: 538.3 },

    { id: "mugA1", asset: "cup", x: 698, y: 276, z: 44, color: "#2ec4a6", sort: 318.4 },
    { id: "mugA2", asset: "cup", x: 892, y: 278, z: 44, color: "#ffb648", sort: 318.5 },
    { id: "mugB1", asset: "cup", x: 698, y: 496, z: 44, color: "#9b6cf5", sort: 538.4 },
    { id: "bookB2", asset: "papers", x: 900, y: 494, z: 44, sort: 538.5 },
    { id: "lampA1", asset: "lamp", x: 730, y: 256, z: 44, sort: 318.6 },
    { id: "signNew", asset: "deskSign", x: 918, y: 298, z: 44, text: "NOAH", sort: 318.7 },

    /* ── plants ─────────────────────────────────────────────── */
    { id: "plant1", asset: "plant", x: 96, y: 152, s: 1.15, pot: "#ff5d7a" },
    { id: "plant2", asset: "plant", x: 956, y: 150, s: 1.0, pot: "#4f7cff" },
    { id: "plant3", asset: "plant", x: 98, y: 626, s: 0.95, pot: "#2ec4a6" },
    { id: "plant4", asset: "plant", x: 952, y: 626, s: 1.1, pot: "#ffb648" },
  ],
};

/** Walkable floor bounds used by the mock engine to keep actors on the floor.
 *  maxY extends through the entrance strip by the door (see the prototype's
 *  opening beats, where Noah walks in from y≈718). */
export const FLOOR_BOUNDS = {
  minX: 80,
  maxX: 960,
  minY: 130,
  maxY: 700,
};
