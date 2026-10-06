// render/objects/direction.js — shared compass normalizer for rotatable objects.
//
// Showcase convention: rotatable objects accept `dir` as one of N/E/S/W
// (the segmented control in showcase.html). Legacy plan-view aliases
// ("up","down","left","right") and long names ("north",…) are accepted too
// so world data and STATIC_SCENE keep working unchanged.

/** Normalize any facing to N/S/E/W. Defaults to `fallback`. */
export function normDir(dir, fallback) {
  const s = String(dir || fallback || "S").toLowerCase();
  if (s === "n" || s === "north" || s === "up") return "N";
  if (s === "s" || s === "south" || s === "down") return "S";
  if (s === "e" || s === "east" || s === "right") return "E";
  if (s === "w" || s === "west" || s === "left") return "W";
  return fallback || "S";
}

/** Showcase variant names for a directional object. */
export const COMPASS_VARIANTS = ["N", "E", "S", "W"];
