import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSavePath, loadWorld, saveWorld } from "../../src/engine/persistence.js";
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

  it("atomic save leaves no tmp files behind and writes a complete save", async () => {
    const logger = new Logger({ sessionId: "persist4", writeToFile: false });
    const dir = mkdtempSync(join(tmpdir(), "npc-save-"));
    const path = defaultSavePath(dir, "tiny", 7);
    const world = { ...makeTinyWorld(), tick: 7 };
    await saveWorld(path, world, logger);
    const names = readdirSync(dir);
    expect(names.filter((n) => n.includes(".tmp."))).toHaveLength(0);
    expect(names).toContain("tiny_tick7.json");
    const loaded = await loadWorld(path, logger);
    expect(loaded.tick).toBe(7);
    expect(loaded).toEqual(world);
  });

  it("rotation keeps only the newest 100 ticked saves per scenario id", async () => {
    const logger = new Logger({ sessionId: "persist5", writeToFile: false });
    const dir = mkdtempSync(join(tmpdir(), "npc-save-"));
    const base = makeTinyWorld();
    // Pre-seed 99 saves for scenario "tiny" plus an unrelated file and a
    // differently-named scenario's saves (neither may be pruned).
    for (let tick = 1; tick <= 99; tick++) {
      writeFileSync(defaultSavePath(dir, "tiny", tick), JSON.stringify({ world: { ...base, tick } }));
    }
    writeFileSync(defaultSavePath(dir, "other", 1), JSON.stringify({ world: { ...base, id: "other", tick: 1 } }));
    writeFileSync(join(dir, "notes.txt"), "do not touch");
    await saveWorld(defaultSavePath(dir, "tiny", 100), { ...base, tick: 100 }, logger);
    await saveWorld(defaultSavePath(dir, "tiny", 101), { ...base, tick: 101 }, logger);
    const names = readdirSync(dir).sort();
    const tiny = names.filter((n) => n.startsWith("tiny_tick"));
    expect(tiny).toHaveLength(100);
    expect(tiny).not.toContain("tiny_tick1.json");
    expect(tiny).toContain("tiny_tick2.json");
    expect(tiny).toContain("tiny_tick101.json");
    expect(names).toContain("other_tick1.json");
    expect(names).toContain("notes.txt");
  });

  it("rotation ignores paths that do not follow the ticked naming pattern", async () => {
    const logger = new Logger({ sessionId: "persist6", writeToFile: false });
    const dir = mkdtempSync(join(tmpdir(), "npc-save-"));
    const path = join(dir, "world.json");
    await saveWorld(path, makeTinyWorld(), logger);
    await saveWorld(path, makeTinyWorld(), logger);
    expect(readdirSync(dir)).toEqual(["world.json"]);
  });

  it("loadWorld rejects saves with an unknown version", async () => {
    const logger = new Logger({ sessionId: "persist7", writeToFile: false });
    const dir = mkdtempSync(join(tmpdir(), "npc-save-"));
    const path = join(dir, "future.json");
    writeFileSync(path, JSON.stringify({ world: { ...makeTinyWorld(), version: 999 } }));
    await expect(loadWorld(path, logger)).rejects.toThrow(/unsupported save version 999/);
    await expect(loadWorld(path, logger)).rejects.toThrow(/known versions: 1/);
    expect(logger.store.byEvent("error_occurred").length).toBeGreaterThanOrEqual(1);
  });

  it("loadWorld accepts a known version", async () => {
    const logger = new Logger({ sessionId: "persist8", writeToFile: false });
    const dir = mkdtempSync(join(tmpdir(), "npc-save-"));
    const path = defaultSavePath(dir, "tiny", 3);
    await saveWorld(path, { ...makeTinyWorld(), tick: 3 }, logger);
    const loaded = await loadWorld(path, logger);
    expect(loaded.version).toBe(1);
    expect(loaded.tick).toBe(3);
  });
});
