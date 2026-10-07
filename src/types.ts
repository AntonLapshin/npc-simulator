// Core domain types. All semantic content is free-form text by design.
// Only physically necessary data is structured (coordinates, bounds,
// rectangles, passability, vision/sound blocking, turn order, tick).

export type SceneObject = {
  id: string;
  name: string;
  description: string;
  x: number;
  y: number;
  w: number;
  h: number;
  passable: boolean;
  blocksVision: boolean;
  blocksSound: boolean;
};

export type Scene = {
  width: number;
  height: number;
  objects: SceneObject[];
};

export type ActorLook = {
  skin?: string;
  skin2?: string;
  hair?: string;
  hairStyle?: string;
  shirt?: string;
  shirt2?: string;
  pants?: string;
  shoes?: string;
};

export type ActorPose = "stand" | "sit" | "kneel" | "doggy" | "prone";

export type ActorProp = "cup" | "laptop" | null;

export type Actor = {
  id: string;
  name: string;
  persona: string;
  x: number;
  y: number;
  state: string;
  emotion: string;
  goal: string;
  /** One-time inner reaction to the most recent event. Rewritten after
   *  every turn for actors who perceived it; guides the next action and
   *  is included in proposal/selection prompts. */
  thoughts: string;
  memories: string[];
  beliefs: string[];
  relationships: string[];
  /** Visual appearance (data-driven, see npc-simulator-ui README raw input
   *  contract: chars [{ id, name, color, look, prop, x, y, pose, emotion }]).
   *  `color` is the accent/name-plate color, `look` holds the painter
   *  colors + hair style, `prop` is the held item, `pose` the body pose.
   *  All optional for backward compatibility — the UI derives deterministic
   *  fallbacks from the actor id when absent. */
  color?: string;
  pose?: ActorPose;
  prop?: ActorProp;
  look?: ActorLook;
};

export type Scenario = {
  version: number;
  id: string;
  title: string;
  narrative: string;
  userActorId: string;
  order: string[];
  scene: Scene;
  actors: Actor[];
};

export type World = {
  version: number;
  id: string;
  title: string;
  narrative: string;
  userActorId: string;
  order: string[];
  tick: number;
  turnIndex: number;
  history: string[];
  scene: Scene;
  actors: Actor[];
};

export type Action = {
  actorId: string;
  text: string;
};

export type ProposalResult = {
  suggestions: string[];
  reasoning: string;
};

export type SelectionResult = {
  action: string;
  reasoning: string;
};

export type ActorPatch = {
  actorId: string;
  x?: number;
  y?: number;
  state?: string;
  emotion?: string;
  goal?: string;
  /** Replacement for the actor's one-time thoughts field. */
  thoughts?: string;
  memoriesAppend?: string[];
  beliefsAppend?: string[];
  relationshipsAppend?: string[];
  /** Body pose change (e.g. sitting down / standing up). */
  pose?: ActorPose;
  /** Held-prop change (e.g. picking up a cup). */
  prop?: ActorProp;
};

export type ObjectPatch = {
  objectId: string;
  description?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  passable?: boolean;
  blocksVision?: boolean;
  blocksSound?: boolean;
};

export type ConsequenceResult = {
  narrative: string;
  actorPatches: ActorPatch[];
  objectPatches: ObjectPatch[];
  reasoning: string;
  /**
   * Machine-readable self-declaration by the consequence LLM about what the
   * action did (see refactor plan §B). The validator checks patches against
   * this declaration deterministically; the independent SemanticJudge is
   * only consulted when `effects` is absent (or for dispute spot-checks).
   * Optional for backward compatibility — missing effects falls back to
   * the SemanticJudge, then to fail-open physics-only validation.
   */
  effects?: ConsequenceEffects;
};

/** Machine-readable declaration of what an action did (emitted with the narrative). */
export type ConsequenceEffects = {
  /** Whole-body locomotion by the acting actor occurred. */
  moved: boolean;
  /** The acting actor uttered words / performed explicit speech. */
  spoke: boolean;
  /** Canonical uttered segments (ground truth for speech preservation). */
  quotedSpeech?: string[];
  /** Resolved movement-target actor id, when the action names one. */
  destinationActorId?: string;
  /** Resolved movement-target object id, when the action names a landmark. */
  destinationObjectId?: string;
  /** Resolved speech addressee actor id, when the action speaks to someone. */
  addresseeActorId?: string;
  /** Resolved physical-contact target actor id (handshake, handing coffee...). */
  contactActorId?: string;
};

/**
 * Meaning of a free-form action sentence, as judged by Decision AI
 * (refactor plan §A). Produced by the SemanticJudge — never by regex on
 * the production validation path.
 */
export type ActionSemantics = {
  /** Whole-body locomotion by the acting actor? */
  moves: boolean;
  /** Named movement target, resolved to an actor id (via id comparison). */
  destinationActorId?: string;
  /** Named movement landmark, resolved to an object id. */
  destinationObjectId?: string;
  /** Uttered words / explicit speech intent? */
  speaks: boolean;
  /** Canonical uttered segments (ground truth for speech preservation). */
  quotedSpeech: string[];
  /** Actor spoken to, resolved to an actor id (direct addressee). */
  addresseeActorId?: string;
  /** Physical-contact target (handshake, handing coffee...), resolved to id. */
  contactActorId?: string;
};

export type EngineConfig = {
  maxMemoriesPerActor: number;
  maxHistoryEntries: number;
  defaultPerceptionRadius: number;
  maxRetries: number;
  logDir: string;
  saveDir: string;
  autosaveEnabled: boolean;
  /** Recent-history entries included in proposal/selection prompts. */
  proposalHistoryLimit: number;
  /** Max suggestions requested from the Proposal Engine per turn. */
  maxProposalSuggestions: number;
  /** Stored-world cap for beliefs per actor (Phase 5 memory budget). */
  maxBeliefsPerActor: number;
  /** Stored-world cap for relationships per actor (Phase 5 memory budget). */
  maxRelationshipsPerActor: number;
  /** Newest list entries rendered verbatim in prompts; older ones fold into a digest (Phase 5). */
  memorySummaryKeepNewest: number;
  /** Char budget per memories/beliefs/relationships prompt section (Phase 5). */
  promptListBudgetChars: number;
  /** Char budget for the recent-history block in prompts (Phase 5). */
  promptHistoryBudgetChars: number;
  /** History entries scanned for unanswered questions (Phase 5). */
  openQuestionScanWindow: number;
  /** Radius for the slim consequence snapshot (Phase 5 context budget). */
  consequenceSnapshotRadius: number;
  /** Consecutive own-turn fallbacks before the NPC liveness floor fires (Exp-5 item 6). */
  livenessFallbackThreshold: number;
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export type Point = {
  x: number;
  y: number;
};

export type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};
