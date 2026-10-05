import type {
  Action,
  ConsequenceResult,
  ProposalResult,
  SelectionResult,
  World,
} from "../types.js";

export interface ProposalEngine {
  propose(world: World, actorId: string): Promise<ProposalResult>;
}

export interface SelectionEngine {
  select(world: World, actorId: string, suggestions: string[]): Promise<SelectionResult>;
}

export interface ConsequenceEngine {
  resolve(world: World, action: Action, feedback?: string): Promise<ConsequenceResult>;
}
