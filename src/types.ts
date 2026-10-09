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

/**
 * Phase 3: the held prop is engine-owned (see `src/core/objects.ts`).
 * The value is the canonical prop name from the affordance table
 * ("cup", "laptop", "papers", "report", "phone", "book", "bottle",
 * "bag", …) — an open string, not a closed enum, so scenarios are not
 * stuck with office props (F8). The graphic UI renders visuals for
 * "cup"/"laptop" and ignores the rest gracefully.
 */
export type ActorProp = string | null;

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
  /**
   * Exp-7 item A6: third-person pronouns for narrative prose
   * ("he/him", "she/her", "they/them"). Optional for backward
   * compatibility; when present, prompts name them and the validator
   * rejects prose that flips them.
   */
  pronouns?: string;
};

export type ScenarioVocabulary = {
  /**
   * F8: object nouns this scenario uses. Object/verb validators use these
   * instead of the hardcoded office noun list when present; scenarios
   * without a vocabulary keep the office defaults.
   */
  objectNouns?: string[];
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
  /** F8: optional scenario-specific object/prop vocabulary. */
  vocabulary?: ScenarioVocabulary;
};

export type World = {
  version: number;
  id: string;
  title: string;
  narrative: string;
  userActorId: string;
  order: string[];
  /**
   * Q4: world-global turn counter. Increments once per completed turn for
   * the whole world — not per actor, not wall-clock. Consumers must not
   * read per-actor progress or elapsed time into it.
   */
  tick: number;
  turnIndex: number;
  history: HistoryEntry[];
  scene: Scene;
  actors: Actor[];
  /** F8: carried over from the scenario (see Scenario.vocabulary). */
  vocabulary?: ScenarioVocabulary;
};

/**
 * F6: a world-history entry. `text` is the human-readable record;
 * `perceivers` is the list of actor ids who perceived the event (F6:
 * knowledge is perception-gated, not global).
 */
export type HistoryEntry = {
  text: string;
  perceivers: string[];
};

/**
 * F6: normalize a history entry. Plain-string legacy entries (old saves,
 * hand-built test worlds) become global entries perceived by every actor.
 */
export function normalizeHistoryEntry(
  raw: string | HistoryEntry,
  allActorIds: string[],
): HistoryEntry {
  if (typeof raw === "string") {
    return { text: raw, perceivers: [...allActorIds] };
  }
  return {
    text: raw.text,
    perceivers: Array.isArray(raw.perceivers) ? [...raw.perceivers] : [...allActorIds],
  };
}

/**
 * F22: machine-readable fallback marker. Appended to "tried … (not done)"
 * history entries INSTEAD of relying on the "(not done)" substring for
 * streak counting and open-question filtering — a user-written action
 * containing "(not done)" must never corrupt those. The human-readable
 * "(not done)" text is kept alongside the sentinel; only the sentinel is
 * parsed. U+10FFFF is a Unicode noncharacter: invisible, and vanishingly
 * unlikely to appear in user text.
 */
export const NOT_DONE_SENTINEL = "\u{10FFFF}";

/**
 * F27: world/save format versions this engine build understands.
 * scenarioLoader rejects anything else with a descriptive error.
 * (persistence.ts imports this exact name.)
 */
export const KNOWN_WORLD_VERSIONS: number[] = [1];

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
   * F23: true when this result is the canonical "Nothing changes."
   * fallback (set on the engine-produced fallback clone).
   * `isFallbackConsequence` checks this flag first; narrative equality
   * remains only as a backward-compat fallback for results built before
   * the flag existed.
   */
  fallback?: boolean;
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
  /**
   * Exp-3 item 7 (S5): tri-state destination explicitness. true = the
   * destination came from an explicit name/id mention in a movement clause
   * or a model declaration (strong evidence); false = it came from the
   * fuzzy keyword/possessive fallback (a guess); undefined = legacy or
   * manually-built semantics. validateDestinationObject skips its
   * arrival/wrong-landmark sub-checks only when false — strictly-closer
   * applies regardless.
   */
  destinationObjectExplicit?: boolean;
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
  /**
   * Exp-7: cap on outer consequence attempts per turn (validation-driven
   * retries in resolveWithValidation). Default 2, down from the
   * maxRetries+1=4 the loop previously used. Data-grounded: exp-3 showed
   * attempt 1 is the best attempt in 72% of turns and RULE-C aborts
   * non-improving tails; exp-7 showed retry feedback does not steer
   * qwen3:14b (B2 echo persisted through 3 identical retries) while each
   * retry costs 60-120 s. Deterministic in-loop repairs (movement repair,
   * stationary downgrade, prop stub) already run on attempt 1; salvage
   * handles the rest. Set higher only with evidence retries help.
   */
  consequenceMaxAttempts?: number;
  /**
   * Exp-7 item A12: filename stem for saves. Defaults to world.id — UIs
   * that load scenarios from files set this to the scenario file's stem
   * (e.g. "office-anton") so `office.json` and `office-anton.json` runs
   * don't collide as `office_tickN.json`.
   */
  saveNamePrefix?: string;
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
  /**
   * Exp-3 item 6 (S2): consecutive own-turn fallbacks of the SAME intent
   * (verb|noun key) before that intent is banned from selection — the
   * deterministic backstop for the handshake/papers/chair attractors the
   * consequence tier cannot render. Default 2.
   */
  intentFailureBanThreshold: number;
  /**
   * Exp-6 item 3: wall-clock budget for one turn's consequence phase
   * (all attempts). When exceeded, the turn stops burning LLM calls and
   * falls through to salvage → liveness → fallback. Default 10 minutes.
   */
  turnTimeoutMs: number;
};

/**
 * F2: a validation failure as a stable machine-readable code plus the
 * human-readable message. Salvage tiers, retry hints, and repair
 * eligibility switch on `code` — never on message substrings — so
 * rewording a message cannot silently change turn behavior.
 */
export type ValidationError = {
  /** Stable snake_case code, e.g. "movement.no_progress". */
  code: string;
  /** Human-readable detail (still surfaced in retry feedback and logs). */
  message: string;
};

export type ValidationResult = {
  valid: boolean;
  errors: ValidationError[];
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
