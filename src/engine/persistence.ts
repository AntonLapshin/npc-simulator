import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { World } from "../types.js";
import { KNOWN_WORLD_VERSIONS, normalizeHistoryEntry } from "../types.js";
import { saveFileSchema, worldSchema } from "../schemas.js";
import type { Logger } from "../logging/logger.js";

/** How many save files per scenario id are kept; older ticks are pruned. */
export const MAX_SAVES_PER_SCENARIO = 100;

/** Filenames produced by defaultSavePath: `<id>_tick<N>.json`. */
const SAVE_FILE_RE = /^(.*)_tick(\d+)\.json$/;

export async function saveWorld(
  path: string,
  world: World,
  logger?: Logger,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    // Atomic write (F17): write to a tmp file in the same directory, then
    // rename over the target. A crash mid-write can leave a stray tmp file
    // but never a half-written save.
    const tmp = join(dirname(path), `.${basename(path)}.tmp.${randomUUID()}`);
    try {
      await writeFile(tmp, JSON.stringify({ world }, null, 2), "utf-8");
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    await rotateSaveFiles(path, logger);
    logger?.log({
      module: "persistence",
      event: "world_saved",
      tick: world.tick,
      turnIndex: world.turnIndex,
      input: { path },
      output: { ok: true },
    });
  } catch (err) {
    logger?.log({
      module: "persistence",
      event: "error_occurred",
      tick: world.tick,
      turnIndex: world.turnIndex,
      input: { path },
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Rotation (F17): after each save, keep only the newest MAX_SAVES_PER_SCENARIO
 * files matching `<id>_tick<N>.json` for this scenario id in the save
 * directory. Paths that don't follow the ticked naming pattern are left
 * alone. Best-effort: rotation failures are logged, never thrown.
 */
async function rotateSaveFiles(savedPath: string, logger?: Logger): Promise<void> {
  const match = SAVE_FILE_RE.exec(basename(savedPath));
  if (!match) return;
  const scenarioId = match[1]!;
  const dir = dirname(savedPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const escaped = scenarioId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}_tick(\\d+)\\.json$`);
  const hits: { name: string; tick: number }[] = [];
  for (const name of names) {
    const m = re.exec(name);
    if (m) hits.push({ name, tick: Number(m[1]) });
  }
  if (hits.length <= MAX_SAVES_PER_SCENARIO) return;
  hits.sort((a, b) => b.tick - a.tick);
  const pruned = hits.slice(MAX_SAVES_PER_SCENARIO);
  for (const { name } of pruned) {
    try {
      await rm(join(dir, name));
    } catch (err) {
      logger?.log({
        module: "persistence",
        event: "error_occurred",
        tick: 0,
        turnIndex: 0,
        input: { path: join(dir, name) },
        error: `save rotation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

export async function loadWorld(path: string, logger?: Logger): Promise<World> {
  try {
    const raw = await readFile(path, "utf-8");
    const data: unknown = JSON.parse(raw);
    // Accept both { world } save payloads and bare world JSON.
    const asSave = saveFileSchema.safeParse(data);
    const worldRaw = asSave.success ? asSave.data.world : data;
    const parsed = worldSchema.safeParse(worldRaw);
    if (!parsed.success) {
      throw new Error(
        `invalid save file: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    // F27: the save version is no longer decorative — refuse saves we don't
    // know how to read instead of silently misinterpreting them.
    if (!KNOWN_WORLD_VERSIONS.includes(parsed.data.version)) {
      throw new Error(
        `unsupported save version ${parsed.data.version} in '${path}' ` +
          `(known versions: ${KNOWN_WORLD_VERSIONS.join(", ")}); refusing to load`,
      );
    }
    // Legacy saves store history as plain strings; normalize to HistoryEntry
    // (legacy entries are treated as globally perceived).
    const actorIds = parsed.data.actors.map((a) => a.id);
    const world: World = {
      ...parsed.data,
      history: parsed.data.history.map((e) => normalizeHistoryEntry(e, actorIds)),
    };
    logger?.log({
      module: "persistence",
      event: "world_loaded",
      tick: world.tick,
      turnIndex: world.turnIndex,
      input: { path },
      output: { ok: true },
    });
    return world;
  } catch (err) {
    logger?.log({
      module: "persistence",
      event: "error_occurred",
      tick: 0,
      turnIndex: 0,
      input: { path },
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function defaultSavePath(saveDir: string, worldId: string, tick: number): string {
  return join(saveDir, `${worldId}_tick${tick}.json`);
}
