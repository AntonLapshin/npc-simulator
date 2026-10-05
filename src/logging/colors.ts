// Minimal ANSI color helpers (no dependencies).
//
// Debug story traces are colored per acting actor so consecutive turns are
// visually distinct; errors/fallbacks are always red. All functions are
// pure and return plain text when `enabled` is false (unit tests) — the
// text UI passes `color: true` for interactive `--debug` output.

const RESET = "\u001b[0m";

// Red is reserved for errors/fallbacks — never assigned to an actor.
const RED = "\u001b[31m";
// Per-actor palette (SGR params, no red family). Standard bright/normal
// colors first, then 256-color extensions for larger casts. Every entry
// must stay visually distinct from red (31/91) so errors stand out.
const ACTOR_PALETTE: string[] = [
  "36", // cyan
  "35", // magenta
  "32", // green
  "33", // yellow
  "34", // blue
  "96", // bright cyan
  "95", // bright magenta
  "92", // bright green
  "93", // bright yellow
  "94", // bright blue
  "38;5;208", // orange
  "38;5;81", // light sky blue
  "38;5;118", // light lime
  "38;5;226", // bright yellow (256)
  "38;5;75", // medium blue
  "38;5;147", // light purple
  "38;5;159", // pale cyan
  "38;5;221", // light gold
  "38;5;120", // mint green
  "38;5;219", // lavender
  "38;5;86", // turquoise
  "38;5;180", // tan
];

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * SGR params assigned deterministically to an actor id.
 * When `rosterIds` (all actor ids in the world) is provided and contains
 * `actorId`, the color is assigned by sorted roster position, which
 * guarantees distinct colors for every character up to the palette size.
 * Otherwise it falls back to the legacy hash (for single-entry log lines
 * without roster context).
 */
export function actorColorCode(actorId: string, rosterIds?: readonly string[]): number | string {
  if (rosterIds && rosterIds.includes(actorId)) {
    const sorted = [...new Set(rosterIds)].sort();
    const idx = sorted.indexOf(actorId);
    return ACTOR_PALETTE[idx % ACTOR_PALETTE.length]!;
  }
  return ACTOR_PALETTE[hashId(actorId) % ACTOR_PALETTE.length]!;
}

/** Wrap text in an ANSI color code. */
export function paint(text: string, code: number | string): string {
  return `\u001b[${code}m${text}${RESET}`;
}

/** Paint an actor id/name with that actor's color. */
export function paintActor(text: string, actorId: string, rosterIds?: readonly string[]): string {
  return paint(text, actorColorCode(actorId, rosterIds));
}

/** Paint error/fallback text red. */
export function paintError(text: string): string {
  return paint(text, 31);
}

export { RED, RESET, ACTOR_PALETTE };
