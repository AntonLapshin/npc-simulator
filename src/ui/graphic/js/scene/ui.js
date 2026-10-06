// scene/ui.js — thin bridge to npc-simulator-ui (the sibling visual project).
//
// The whole scene layer — SceneRenderer, object/character painters, scene
// data, canvas utils — lives in npc-simulator-ui, linked here as `ui-lib/`
// (src/ui/graphic/ui-lib → ../../../../npc-simulator-ui). This module only
// re-exports the pieces the console needs so the rest of the UI imports from
// exactly one place (the js/scene/ui.js bridge): SceneRenderer, drawAvatar,
// canvas utils, STATIC_SCENE/FLOOR_BOUNDS, getScene/sceneIds.
//
// NOTE: this file uses plain `import` + `const` + `export { … }` on purpose —
// tools/bundle.mjs concatenates modules into one scope and only understands
// those forms (no `export … from` re-exports).
//
// Visuals work (new objects, variants, looks) happens in npc-simulator-ui
// (showcase.html / scene.html there) — never in this folder. If the
// `ui-lib` link dangles, the sibling checkout is missing: see README.md and
// run `npm run diagnose` (it checks graphic-UI availability).

import { SceneRenderer } from "../../ui-lib/js/render/sceneRenderer.js";
import { drawAvatar } from "../../ui-lib/js/render/avatar.js";
import { clamp, easeInOut, hashStr, mulberry } from "../../ui-lib/js/core/utils.js";
import {
  OFFICE_FLOOR3_SCENE,
  OFFICE_FLOOR3_BOUNDS,
} from "../../ui-lib/js/data/scenes/officeFloor3.js";
import { getScene, sceneIds } from "../../ui-lib/js/data/scenes/index.js";

/** Backwards-compatible scene names used across the console + tests. */
const STATIC_SCENE = OFFICE_FLOOR3_SCENE;
const FLOOR_BOUNDS = OFFICE_FLOOR3_BOUNDS;

export {
  SceneRenderer,
  drawAvatar,
  clamp,
  easeInOut,
  hashStr,
  mulberry,
  STATIC_SCENE,
  FLOOR_BOUNDS,
  getScene,
  sceneIds,
};
