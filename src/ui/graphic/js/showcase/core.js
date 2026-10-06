// showcase/core.js — pure showcase state engine (no DOM, no canvas).
//
// Adapted from https://github.com/AntonLapshin/showcase `src/core/showcase.ts`:
// a registry of showcase files (each: { name, showcases: { variant: props } })
// plus selection state with URL deep-linking (`?file=..&showcase=..`).
// The gallery view (showcase/app.js) binds these to DOM + history.

/**
 * Build a validated registry from showcase files.
 * @param {Array<{name:string, showcases:object}>} files
 * @returns {{ files:Array, byName:Map<string,object> }}
 * @throws on duplicate names, empty files, or files without showcases.
 */
export function createShowcaseRegistry(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("[showcase] registry needs at least one file");
  }
  const byName = new Map();
  for (const f of files) {
    if (!f || typeof f.name !== "string" || !f.name) {
      throw new Error("[showcase] every file needs a string `name`");
    }
    if (byName.has(f.name)) {
      throw new Error(`[showcase] duplicate file name: '${f.name}'`);
    }
    const keys = f.showcases ? Object.keys(f.showcases) : [];
    if (keys.length === 0) {
      throw new Error(`[showcase] file '${f.name}' has no showcases`);
    }
    byName.set(f.name, f);
  }
  return { files: [...files], byName };
}

/** Initial (empty) selection state. */
export function createShowcaseState() {
  return { file: null, showcase: null };
}

/**
 * Select a file + variant. Unknown names fall back to the first file /
 * first variant (never throws on user-supplied URLs).
 * @returns {{ file:string, showcase:string }} new state (immutable).
 */
export function select(state, registry, fileName, showcaseName) {
  const files = registry.files;
  const file = registry.byName.get(fileName) || files[0];
  const variants = Object.keys(file.showcases);
  const showcase = variants.includes(showcaseName) ? showcaseName : variants[0];
  return { ...state, file: file.name, showcase };
}

/** Serialize a selection to a URL query string (`?file=..&showcase=..`). */
export function encodeUrlPath(selection) {
  const q = new URLSearchParams();
  if (selection.file) q.set("file", selection.file);
  if (selection.showcase) q.set("showcase", selection.showcase);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Parse a query string back into a { file, showcase } pair (or nulls). */
export function decodeUrlPath(search) {
  const q = new URLSearchParams(String(search || "").replace(/^[?#]/, ""));
  return { file: q.get("file"), showcase: q.get("showcase") };
}
