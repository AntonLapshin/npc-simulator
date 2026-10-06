// data/staticScene.js — backwards-compatible re-export (DO NOT EXTEND).
//
// The hardcoded office layout moved to data/scenes/officeFloor3.js and is
// selected by id through data/scenes/index.js. This module keeps the old
// `STATIC_SCENE` / `FLOOR_BOUNDS` names so main.js, tests and the bundle
// keep working. New code should use the scene registry instead.

import { OFFICE_FLOOR3_SCENE, OFFICE_FLOOR3_BOUNDS } from "./scenes/officeFloor3.js";

export const STATIC_SCENE = OFFICE_FLOOR3_SCENE;
export const FLOOR_BOUNDS = OFFICE_FLOOR3_BOUNDS;
