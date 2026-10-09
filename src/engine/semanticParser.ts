// PLAN_V2 Phase 2: Laya as parser.
//
// One batched local decide() over the action sentence → ActionSemantics
// for the executors. Laya is a parser here, never a decider: it only ever
// sees the single action sentence, never scene-level classification
// (this kills the Stage-3 miscalibration failure by construction —
// there is no scene-level classification left to get wrong).
//
// Fail-open: the Laya wiring is optional, and any parse failure returns
// undefined — the caller then runs the executors' deterministic text
// parsers as before. The turn NEVER blocks on the parser.

import type { Action, ActionSemantics, World } from "../types.js";
import { createLayaSemanticJudge } from "../decision/wiring.js";
import type { LayaTurnWiring } from "./layaTurn.js";
import type { Logger } from "../logging/logger.js";
import { errorMessage } from "../util/errors.js";

/**
 * Classify the action sentence with the Laya semantic judge (one batched
 * local decide). Returns undefined when the Laya wiring is absent (Laya
 * off / disabled) or the parse throws (Laya down, protocol error) — the
 * caller falls back to deterministic text parsing.
 *
 * Logs `parser_completed` on success and `parser_fallback` on failure
 * (module "laya"), so log analysis can attribute which turns parsed and
 * which fell back.
 */
export async function parseActionSemantics(
  world: World,
  action: Action,
  wiring: LayaTurnWiring | undefined,
  logger: Logger,
): Promise<ActionSemantics | undefined> {
  if (wiring === undefined) return undefined;
  const judge = createLayaSemanticJudge({ client: wiring.client }, wiring.config);
  try {
    const semantics = await judge.classify(world, action);
    logger.log({
      module: "laya",
      event: "parser_completed",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { actionText: action.text },
      output: semantics,
    });
    return semantics;
  } catch (err) {
    logger.log({
      module: "laya",
      event: "parser_fallback",
      tick: world.tick,
      turnIndex: world.turnIndex,
      actorId: action.actorId,
      input: { actionText: action.text },
      error: `Laya parse failed — falling back to deterministic text parsers: ${errorMessage(err)}`,
    });
    return undefined;
  }
}
