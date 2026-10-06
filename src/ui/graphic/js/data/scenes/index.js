// data/scenes/index.js — scene registry (data-driven, no hardcoded imports).
//
// The renderer and the app never import a concrete scene file: they ask for
// a scene by id (scenario presentation `scene.staticScene`). Only the bundled
// office ships a pretty scene; every other world is built from its own
// objects by data/scenarioScene.js.

import { OFFICE_FLOOR3_ID, OFFICE_FLOOR3_SCENE } from "./officeFloor3.js";

export { OFFICE_FLOOR3_ID, OFFICE_FLOOR3_SCENE };

const SCENES = {
  [OFFICE_FLOOR3_ID]: OFFICE_FLOOR3_SCENE,
};

/** Look up a registered pretty scene by id (or null when unknown). */
export function getScene(id) {
  return SCENES[id] || null;
}

/** All registered scene ids (for debugging / gallery use). */
export function sceneIds() {
  return Object.keys(SCENES);
}
