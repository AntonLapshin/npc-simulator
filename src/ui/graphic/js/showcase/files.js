// showcase/files.js — showcase file registry (showcase pattern).
//
// Mirrors AntonLapshin/showcase `src/ui/showcases/index.ts`: import every
// object module (each exports `name` + variants) and register a ShowcaseFile
// entry { name, showcases }. The gallery picks these up automatically — to
// add an object, add its file under js/render/objects/ and list it here.

import { showcaseFiles } from "../render/objects/index.js";

export { showcaseFiles };

/** All registered showcase file names (sidebar order). */
export const showcaseNames = showcaseFiles.map((f) => f.name);
