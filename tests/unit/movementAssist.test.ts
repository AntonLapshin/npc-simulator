import { describe, expect, it } from "vitest";
import { suggestMoveTarget, isMovementOnlyFailure } from "../../src/engine/movementAssist.js";
import { resolveWithValidation } from "../../src/engine/turnOrchestrator.js";
import { Logger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld } from "../helpers.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("movementAssist", () => {
  it("suggests a closer reachable cell toward the destination", () => {
    const world = makeTinyWorld(); // u at (1,1), n at (4,4)
    const s = suggestMoveTarget(world, "u", "n");
    expect(s).not.toBeNull();
    const oldDist = Math.hypot(1 - 4, 1 - 4);
    const newDist = Math.hypot(s!.x - 4, s!.y - 4);
    expect(newDist).toBeLessThan(oldDist);
    expect(s!.x).not.toBe(1);
  });

  it("returns null for unknown actor", () => {
    expect(suggestMoveTarget(makeTinyWorld(), "ghost", "n")).toBeNull();
  });

  it("detects movement-only failures", () => {
    // F2: classification switches on stable codes, not message prose.
    expect(
      isMovementOnlyFailure([{ code: "movement.no_position_change", message: "action implies movement" }]),
    ).toBe(true);
    expect(
      isMovementOnlyFailure([{ code: "actor.no_path", message: "actor u: no valid path from current" }]),
    ).toBe(false);
    expect(isMovementOnlyFailure([])).toBe(false);
  });

  it("repairs weak-LLM movement omission instead of falling back (office-anton regression)", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = JSON.parse(readFileSync(join(here, "../../scenarios/office-anton.json"), "utf-8"));
    const logger = new Logger({ sessionId: "move-repair", writeToFile: false });
    const world = loadScenario(raw, logger);
    const stub = {
      async resolve() {
        return {
          narrative: "Anton approaches Tanya's desk and greets her.",
          actorPatches: [
            { actorId: "anton", thoughts: "Trying to make a good first impression." },
            { actorId: "tanya", thoughts: "Anton seems friendly." },
          ],
          objectPatches: [],
          reasoning: "Anton moves closer",
          effects: { moved: true, destinationActorId: "tanya", spoke: false },
        };
      },
    };
    const deps = makeTestDeps(logger, { consequenceEngine: stub as any });
    const result = await resolveWithValidation(world, { actorId: "anton", text: "Come close to Tanya" }, deps);
    const patch = result.actorPatches.find((p) => p.actorId === "anton");
    expect(patch?.x).toBeDefined();
    expect(patch?.y).toBeDefined();
    // Must be strictly closer to Tanya than Anton's start.
    const anton = world.actors.find((a) => a.id === "anton")!;
    const tanya = world.actors.find((a) => a.id === "tanya")!;
    const oldDist = Math.hypot(anton.x - tanya.x, anton.y - tanya.y);
    const newDist = Math.hypot(patch!.x! - tanya.x, patch!.y! - tanya.y);
    expect(newDist).toBeLessThan(oldDist);
    expect(result.narrative).not.toBe("Nothing changes.");
    expect(logger.store.byEvent("movement_repaired")).toHaveLength(1);
    expect(logger.store.byEvent("fallback_used")).toHaveLength(0);
  });
});
