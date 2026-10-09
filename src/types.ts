// Core domain types. All semantic content is free-form text by design.
// Only physically necessary data is structured (coordinates, bounds,
// rectangles, passability, vision/sound blocking, turn order, tick).

import type { Intent } from "./decision/decisionTypes.js";

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
  /**
   * Stage-1 A3: the scene object backing the held prop (engine-owned,
   * like `prop`). Set on pick-up, cleared on put-down, transferred on
   * hand-over; the movement applier carries this object with its holder
   * so it never orphans at the pick-up site and hand-overs keep object
   * identity instead of re-linking by proximity. Optional for backward
   * compatibility — absent means "no linked scene object".
   */
  heldObjectId?: string | null;
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
 * Stage-1 A4: `actionText` is the ground-truth action behind the entry.
 * The repetition screen derives cores from it — never from the narrative,
 * which a mis-render can poison (exp stage-1, turn 1: "walks toward Dana"
 * for an engine move toward Tanya let a verbatim repeat slip through).
 */
export type HistoryEntry = {
  text: string;
  perceivers: string[];
  actionText?: string;
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
    ...(raw.actionText !== undefined ? { actionText: raw.actionText } : {}),
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
  /**
   * Phase 5: the decision cascade's fully-typed intent (kind + resolved
   * targetId), set by the Laya proposal engine. The orchestrator threads
   * it to selection and the executors — typed intents map directly onto
   * engine executors with no translation layer. Undefined on the
   * LLM/chat proposal path.
   */
  intent?: Intent;
};

export type SelectionResult = {
  action: string;
  reasoning: string;
};

/**
 * Phase 4 legacy: the pre-render patch shapes. No longer part of the
 * model contract (the render engine returns prose only); kept for the
 * log-analysis tooling in src/logging/storyTrace.ts, which summarizes
 * historical runs whose logged payloads still carry patches.
 */
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

/** Phase 4 legacy: the pre-render object-patch shape (see ActorPatch). */
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

/**
 * Phase 4: the render-only consequence contract. The consequence (render)
 * engine returns PROSE ONLY — the acting actor's narrative, private
 * thoughts, and emotion. Movement, speech quotes, and manipulation are
 * engine-executed (Phases 1–3) and applied to the world deterministically;
 * the model never emits patches. Unknown keys in a render response (old-
 * schema actorPatches/objectPatches/effects) are stripped by the schema
 * and ignored — never validated.
 */
export type ConsequenceResult = {
  narrative: string;
  /** The acting actor's private inner reaction (never narrated). */
  thoughts?: string;
  /** The acting actor's emotion after the turn (one word). */
  emotion?: string;
  reasoning?: string;
  /**
   * F23: true when this result is the canonical "Nothing changes."
   * fallback (set on the engine-produced fallback clone).
   * `isFallbackConsequence` checks this flag first; narrative equality
   * remains only as a backward-compat fallback for results built before
   * the flag existed.
   */
  fallback?: boolean;
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
   * Exp-6 item 3: wall-clock budget for one turn's render phase
   * (both attempts). When exceeded, the turn stops burning LLM calls and
   * falls through to liveness → fallback. Default 10 minutes.
   */
  turnTimeoutMs: number;
  /**
   * Phase 6: provider-call budget per turn. The orchestrator counts
   * provider-backed engine invocations (proposal / selection / render)
   * and logs a loud `budget_exceeded` warning when the count crosses this
   * — never a hard abort (a turn that needs 5 calls to avoid a fallback
   * is better than a fallback). Default 4: post-Phase-5 shape is ~1 on
   * the Laya cascade path, 3–4 on the LLM-fallback path.
   */
  turnCallBudget: number;
  /**
   * PLAN_V2 Phase 1: wall-time budget per turn, in ms. The orchestrator
   * logs a loud `turn_time_exceeded` warning when a turn crosses this —
   * never a hard abort (a slow turn that avoids a fallback beats a fast
   * fallback). Default 30000 (30s — the v2 turn's binding constraint).
   */
  turnTimeBudgetMs: number;
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
