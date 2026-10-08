// Laya-backed SemanticJudge: ONE batched judge-set decide() per action.
// Verbatim quotes stay deterministic (Laya cannot pull exact spans); the
// classified fields merge with the quote ground truth into ActionSemantics.

import type { SemanticJudge } from "../intelligence/types.js";
import type { Action, ActionSemantics, World } from "../types.js";
import { parseActionQuotes } from "../engine/deterministicSemantics.js";
import type { LayaAnswer } from "./decisionTypes.js";
import { buildJudgeState } from "./decisionState.js";
import { buildJudgeQuestions } from "./diagrams.js";
import { LayaClient } from "./layaClient.js";

export type LayaSemanticJudgeDeps = {
  client: LayaClient;
  buildState?: (actionText: string, rosterNames: string[], landmarkNames: string[]) => string;
};

/** Normalize for name matching: lowercase, strip punctuation/whitespace. */
export function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findActorIdByName(world: World, winner: string): string | undefined {
  const norm = normName(winner);
  return world.actors.find((a) => normName(a.name) === norm)?.id;
}

function findObjectIdByName(world: World, winner: string): string | undefined {
  const norm = normName(winner);
  return world.scene.objects.find((o) => normName(o.name) === norm)?.id;
}

function noulTrue(answer: LayaAnswer | undefined): boolean {
  return !!answer && answer.type === "noul" && answer.pTrue >= 0.5;
}

function choiceWinner(answer: LayaAnswer | undefined): string | undefined {
  return answer?.type === "choice" ? answer.winner : undefined;
}

export class LayaSemanticJudge implements SemanticJudge {
  private readonly client: LayaClient;
  private readonly buildState: (
    actionText: string,
    rosterNames: string[],
    landmarkNames: string[],
  ) => string;

  constructor(deps: LayaSemanticJudgeDeps) {
    this.client = deps.client;
    this.buildState = deps.buildState ?? buildJudgeState;
  }

  async classify(world: World, action: Action): Promise<ActionSemantics> {
    const rosterNames = world.actors.map((a) => a.name);
    const landmarkNames = world.scene.objects.map((o) => o.name);
    const state = this.buildState(action.text, rosterNames, landmarkNames);
    const questions = buildJudgeQuestions(rosterNames, landmarkNames);
    const answers = await this.client.decide(state, questions);

    const semantics: ActionSemantics = {
      moves: noulTrue(answers["q_moves"]),
      speaks: noulTrue(answers["q_speaks"]),
      quotedSpeech: parseActionQuotes(action.text),
    };

    const addressee = choiceWinner(answers["q_addressee"]);
    if (addressee && addressee !== "nobody in particular") {
      const id = findActorIdByName(world, addressee);
      if (id) semantics.addresseeActorId = id;
    }

    const destination = choiceWinner(answers["q_destination"]);
    if (destination && destination !== "stays put / nowhere") {
      const actorId = findActorIdByName(world, destination);
      if (actorId) semantics.destinationActorId = actorId;
      else {
        const objectId = findObjectIdByName(world, destination);
        if (objectId) semantics.destinationObjectId = objectId;
      }
    }

    const contact = choiceWinner(answers["q_contact"]);
    if (contact && contact !== "no physical contact") {
      const id = findActorIdByName(world, contact);
      if (id) semantics.contactActorId = id;
    }

    return semantics;
  }
}
