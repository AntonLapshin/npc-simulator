// Minimal ANSI color helpers (no dependencies).
//
// Debug story traces are colored per acting actor so consecutive turns are
// visually distinct; errors/fallbacks are always red. All functions are
// pure and return plain text when `enabled` is false (unit tests) — the
// text UI passes `color: true` for interactive `--debug` output.

const RESET = "\u001b[0m";

// Red is reserved for errors/fallbacks — never assigned to an actor.
const RED = "\u001b[31m";
// Per-actor palette (bright + normal variants, no red).
const ACTOR_CODES = [36, 35, 32, 33, 34, 96, 95, 92, 93, 94];

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** ANSI code assigned deterministically to an actor id. */
export function actorColorCode(actorId: string): number {
  return ACTOR_CODES[hashId(actorId) % ACTOR_CODES.length]!;
}

/** Wrap text in an ANSI color code. */
export function paint(text: string, code: number | string): string {
  return `\u001b[${code}m${text}${RESET}`;
}

/** Paint an actor id/name with that actor's color. */
export function paintActor(text: string, actorId: string): string {
  return paint(text, actorColorCode(actorId));
}

/** Paint error/fallback text red. */
export function paintError(text: string): string {
  return paint(text, 31);
}

export { RED, RESET };
