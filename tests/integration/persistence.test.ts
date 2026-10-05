import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorld, saveWorld } from "../../src/engine/persistence.js";
import { Logger } from "../../src/logging/logger.js";
import { makeTinyWorld } from "../helpers.js";

describe("persistence", () => {
  it("save/load roundtrip produces identical world state", async () => {
    const logger = new Logger({ sessionId: "persist1", writeToFile: false });
    const dir = mkdtempSync(join(tmpdir(), "npc-save-"));
    const path = join(dir, "world.json");
    const world = makeTinyWorld();
    await saveWorld(path, world, logger);
    const loaded = await loadWorld(path, logger);
    expect(loaded).toEqual(world);
  });

  it("save/load logs success events", async () => {
    const logger = new Logger({ sessionId: "persist2", writeToFile: false });
    const dir = mkdtempSync(join(tmpdir(), "npc-save-"));
    const path = join(dir, "world.json");
    await saveWorld(path, makeTinyWorld(), logger);
    await loadWorld(path, logger);
    expect(logger.store.byEvent("world_saved")).toHaveLength(1);
    expect(logger.store.byEvent("world_loaded")).toHaveLength(1);
  });

  it("corrupt save logs failure and throws", async () => {
    const logger = new Logger({ sessionId: "persist3", writeToFile: false });
    await expect(loadWorld("/nonexistent/path/world.json", logger)).rejects.toThrow();
    expect(logger.store.byEvent("error_occurred").length).toBeGreaterThanOrEqual(1);
  });
});
