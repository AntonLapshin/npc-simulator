import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { World } from "../types.js";
import { saveFileSchema, worldSchema } from "../schemas.js";
import type { Logger } from "../logging/logger.js";

export async function saveWorld(
  path: string,
  world: World,
  logger?: Logger,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ world }, null, 2), "utf-8");
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
    logger?.log({
      module: "persistence",
      event: "world_loaded",
      tick: parsed.data.tick,
      turnIndex: parsed.data.turnIndex,
      input: { path },
      output: { ok: true },
    });
    return parsed.data;
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
