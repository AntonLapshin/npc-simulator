import type { Action, Actor, ConsequenceResult, EngineConfig, World } from "../types.js";
import { defaultConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { applyConsequence } from "./patchApplier.js";
import type { ApplyConsequenceOptions } from "./patchApplier.js";

export function cloneWorld(world: World): World {
  return structuredClone(world);
}

export function getCurrentActor(world: World): Actor {
  const id = world.order[world.turnIndex % world.order.length];
  const actor = world.actors.find((a) => a.id === id);
  if (!actor) throw new Error(`current turn actor does not exist: ${id}`);
  return actor;
}

export function advanceTurn(world: World): World {
  const next = cloneWorld(world);
  next.turnIndex = (next.turnIndex + 1) % next.order.length;
  return next;
}

export function incrementTick(world: World): World {
  const next = cloneWorld(world);
  next.tick += 1;
  return next;
}

/**
 * Stateful holder for the current world: immutable snapshots,
 * validated-patch application, history/memory trimming (via the
 * patch applier), tick/turn advancement. Every mutation is logged.
 */
export class WorldStore {
  private world: World;
  private readonly logger?: Logger;
  private readonly config: EngineConfig;

  constructor(initial: World, options: { logger?: Logger; config?: EngineConfig } = {}) {
    this.world = cloneWorld(initial);
    this.logger = options.logger;
    this.config = options.config ?? defaultConfig;
  }

  getWorld(): World {
    return cloneWorld(this.world);
  }

  snapshot(): World {
    return cloneWorld(this.world);
  }

  /**
   * F26: accepts and forwards ApplyConsequenceOptions (fallback marking,
   * honest-history notes) — the store is usable for the real turn loop,
   * not just unmarked applies.
   */
  applyConsequence(
    result: ConsequenceResult,
    action: Action,
    opts: ApplyConsequenceOptions = {},
  ): World {
    const before = this.world;
    this.world = applyConsequence(before, result, action, this.config, opts);
    this.logger?.log({
      module: "world",
      event: "patch_applied",
      tick: this.world.tick,
      turnIndex: this.world.turnIndex,
      actorId: action.actorId,
      input: { consequence: result, action },
      output: { historyTail: this.world.history.slice(-1) },
    });
    return this.getWorld();
  }

  advanceTurn(): World {
    this.world = advanceTurn(this.world);
    return this.getWorld();
  }

  incrementTick(): World {
    this.world = incrementTick(this.world);
    return this.getWorld();
  }
}
