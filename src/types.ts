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

export type Actor = {
  id: string;
  name: string;
  persona: string;
  x: number;
  y: number;
  state: string;
  emotion: string;
  goal: string;
  memories: string[];
  beliefs: string[];
  relationships: string[];
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
  memoriesAppend?: string[];
  beliefsAppend?: string[];
  relationshipsAppend?: string[];
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
};

export type EngineConfig = {
  maxMemoriesPerActor: number;
  maxHistoryEntries: number;
  defaultPerceptionRadius: number;
  maxRetries: number;
  logDir: string;
  saveDir: string;
  autosaveEnabled: boolean;
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
