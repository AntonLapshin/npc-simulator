import type { Action, Actor, EngineConfig, HistoryEntry, SceneObject, World } from "../types.js";
import { NOT_DONE_SENTINEL, normalizeHistoryEntry } from "../types.js";
import { defaultConfig } from "../config.js";
import { sanitizeDisplayText } from "../util/sanitize.js";
import { distance } from "./geometry.js";
import {
  mentionsObjectVariant,
  objectMentionVariants,
  resolveDestinationActorId,
  resolveDestinationObjectId,
  resolveMentionedActorId,
} from "./deterministicSemantics.js";
import {
  getVisibleActors,
  getAudibleActors,
  getVisibleObjects,
  getActorById,
} from "./perceptionHelpers.js";
import { LIVENESS_HISTORY_MARKER } from "./patchApplier.js";
import { executedMovementFacts, type MovementOutcome } from "./movementExecutor.js";
import { exactQuoteFacts } from "./speechExecutor.js";
import { executedManipulationFacts, type ManipulationOutcome } from "./manipulationExecutor.js";
import { describeClamp, type TurnClamp } from "../core/clamp.js";
import type { PlannedPose } from "../core/text.js";

function formatList(items: string[]): string {
  return items.length > 0 ? items.map((m) => `- ${m}`).join("\n") : "(none)";
}

/** Rough token estimate (chars / 4) — same convention as the log fields. */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Phase 5 memory-growth metric: bytes of compounding state (memories,
 * beliefs, relationships, history) across all actors. Log per session to
 * publish the memory-growth curve (plan Phase 6); prompt rendering must
 * keep per-turn tokens flat while this grows.
 */
export function worldMemoryBytes(world: World): number {
  let bytes = 0;
  for (const a of world.actors) {
    for (const list of [a.memories, a.beliefs, a.relationships]) {
      for (const entry of list) bytes += entry.length;
    }
  }
  for (const entry of world.history) bytes += entry.text.length;
  return bytes;
}

/** Entry counts backing the memory-growth curve (plan Phase 6). */
export function memoryGrowthStats(world: World): {
  memoryEntries: number;
  beliefEntries: number;
  relationshipEntries: number;
  historyEntries: number;
  memoryBytes: number;
} {
  let memoryEntries = 0;
  let beliefEntries = 0;
  let relationshipEntries = 0;
  for (const a of world.actors) {
    memoryEntries += a.memories.length;
    beliefEntries += a.beliefs.length;
    relationshipEntries += a.relationships.length;
  }
  return {
    memoryEntries,
    beliefEntries,
    relationshipEntries,
    historyEntries: world.history.length,
    memoryBytes: worldMemoryBytes(world),
  };
}

/**
 * Phase 5 rolling summarization: render a memories/beliefs/relationships
 * list within a fixed char budget. Exact-duplicate entries collapse, the
 * newest `keepNewest` entries render verbatim (they drive the arc), and
 * everything older folds into one "Earlier (N entries, summarized)" digest
 * line of first-clauses — summarized, never silently trimmed, so per-turn
 * prompt tokens stay flat as stored memory compounds.
 */
export function summarizeListForPrompt(
  entries: string[],
  keepNewest?: number,
  budgetChars?: number,
  cfg: EngineConfig = defaultConfig,
): string {
  const keep = keepNewest ?? cfg.memorySummaryKeepNewest;
  const budget = budgetChars ?? cfg.promptListBudgetChars;
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const key = e.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }
  if (deduped.length === 0) return "(none)";
  const newest = deduped.slice(-Math.max(1, keep));
  const older = deduped.slice(0, Math.max(0, deduped.length - newest.length));
  const lines = newest.map((m) => `- ${m}`);
  if (older.length > 0) {
    // Digest: first clause of each older entry (the fact, not the wording).
    const clauses = older.map((e) => e.split(/[.!\n]/)[0]?.trim() || e.slice(0, 80));
    let digest = `Earlier (${older.length} entries, summarized): ${clauses.join("; ")}`;
    const digestBudget = Math.max(200, Math.floor(budget / 2));
    if (digest.length > digestBudget) digest = digest.slice(0, digestBudget - 3) + "...";
    lines.unshift(`- ${digest}`);
  }
  let out = lines.join("\n");
  if (out.length > budget) {
    // Hard cap: keep the newest lines (they carry the live arc), note the cut.
    const kept: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (used + line.length + 1 > budget && kept.length > 0) break;
      kept.unshift(line);
      used += line.length + 1;
    }
    out = kept.join("\n") + "\n- (older entries omitted for budget; see digest above)";
  }
  return out;
}

/**
 * Phase 5 history budget: newest entries joined within a char budget,
 * head-truncated with an explicit note (never silently dropped from view).
 *
 * F6/F7: accepts raw or normalized entries; the caller filters to
 * perception-visible entries first (see historyVisibleTo). The char budget
 * defaults to the injected config's promptHistoryBudgetChars.
 */
export function formatHistoryForPrompt(
  history: Array<HistoryEntry | string>,
  maxEntries: number,
  budgetChars?: number,
  cfg: EngineConfig = defaultConfig,
): string {
  const budget = budgetChars ?? cfg.promptHistoryBudgetChars;
  const allIds: string[] = [];
  // Exp-7 item A10: strip the NOT_DONE_SENTINEL and control codes before
  // history reaches a prompt — machine markers must never be model input.
  const texts = history.map((e) => sanitizeDisplayText(normalizeHistoryEntry(e, allIds).text));
  const tail = texts.slice(-Math.max(1, maxEntries));
  if (tail.length === 0) return "(no history yet)";
  const kept: string[] = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i]!;
    if (used + line.length + 1 > budget && kept.length > 0) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  const omitted = tail.length - kept.length;
  const body = kept.join("\n");
  return omitted > 0 ? `(${omitted} older entries omitted for budget)\n${body}` : body;
}

/**
 * F6: history entries visible to `actorId` — entries the actor perceived
 * (in the entry's perceivers list) or authored ("Name:" / "id:" /
 * "Name tried:" prefixes). Proposal/selection prompts and the
 * open-question scan use this instead of the global history, so an NPC in
 * another room no longer "knows" events they could not perceive.
 */
export function historyVisibleTo(world: World, actorId: string): HistoryEntry[] {
  const actor = world.actors.find((a) => a.id === actorId);
  const allIds = world.actors.map((a) => a.id);
  const prefixes = actor
    ? [`${actor.name}:`, `${actor.id}:`, `${actor.name} tried:`, `${actor.id} tried:`]
    : [`${actorId}:`, `${actorId} tried:`];
  const authored = (text: string): boolean =>
    prefixes.some((p) => text.toLowerCase().startsWith(p.toLowerCase()));
  return world.history
    .map((e) => normalizeHistoryEntry(e, allIds))
    .filter((e) => e.perceivers.includes(actorId) || authored(e.text));
}

export type SubjectiveContextOptions = {
  /** Recent-history entries to include. Defaults to proposalHistoryLimit (20). */
  historyLimit?: number;
  /** Max suggestions requested. Defaults to maxProposalSuggestions (10). */
  maxSuggestions?: number;
  /** F7: injected engine config (defaults to defaultConfig). */
  cfg?: EngineConfig;
};

function resolveHistoryLimit(opts: SubjectiveContextOptions | undefined, cfg: EngineConfig): number {
  return opts?.historyLimit ?? cfg.proposalHistoryLimit;
}

function resolveMaxSuggestions(opts: SubjectiveContextOptions | undefined, cfg: EngineConfig): number {
  return opts?.maxSuggestions ?? cfg.maxProposalSuggestions;
}

function resolveCfg(opts?: SubjectiveContextOptions): EngineConfig {
  return opts?.cfg ?? defaultConfig;
}

function formatVisibleActors(visible: Actor[]): string {
  if (visible.length === 0) return "(none)";
  return visible
    .map((a) => {
      const cues = [`emotion=${a.emotion || "unknown"}`];
      if (a.pose) cues.push(`pose=${a.pose}`);
      if (a.prop) cues.push(`prop=${a.prop}`);
      return `${a.name} (${a.id}) at (${a.x}, ${a.y}): ${a.state}; ${cues.join(", ")}`;
    })
    .join(" | ");
}

function formatVisibleObjects(objects: SceneObject[]): string {
  if (objects.length === 0) return "(none)";
  return objects
    .map((o) => `${o.name} (${o.id}) at (${o.x}, ${o.y}) [${o.passable ? "passable" : "blocked"}]: ${o.description}`)
    .join(" | ");
}

const THOUGHTS_GUIDANCE =
  "Thoughts (your immediate inner reaction to the last event — HIGH PRIORITY, this guides what you do next; private, never spoken aloud, never narrated; be blunt, candid, profane/explicit when in-character)";

/** Max open-question entries surfaced to proposal/selection. */
export const MAX_OPEN_QUESTIONS = 3;
/** Max recent own actions surfaced to the selection prompt. */
export const MAX_RECENT_OWN_ACTIONS = 5;

/**
 * Salient pending questions addressed to `actorId` (action item 6).
 * Scans recent history for entries containing "?" that mention the actor
 * by name/id — or a bare "you" question from someone else — newest last.
 * Pure helper (no LLM): the model still decides how to answer.
 *
 * Phase 5 (longevity): questions PERSIST until answered. A question stays
 * open across any number of intervening turns (scan window covers
 * `openQuestionScanWindow` entries, not just the prompt history slice) and
 * closes only once the addressee speaks afterwards — a later entry authored
 * by `actorId` counts as their chance to answer. This stops "where is my
 * desk?"/"first task?" from silently expiring into re-asks (Exp-3 ticks
 * 14/17/20).
 */
export function getOpenQuestions(
  world: World,
  actorId: string,
  limit = MAX_OPEN_QUESTIONS,
  cfg: EngineConfig = defaultConfig,
): string[] {
  const actor = getActorById(world, actorId);
  if (!actor) return [];
  const nameLower = actor.name.toLowerCase();
  const idLower = actor.id.toLowerCase();
  const scanWindow = Math.max(
    cfg.openQuestionScanWindow,
    cfg.proposalHistoryLimit,
  );
  // F6: only entries this actor perceived or authored can open questions
  // for them — unperceived events are not their knowledge.
  const entries = historyVisibleTo(world, actorId)
    .slice(-scanWindow)
    .map((e) => e.text);
  const authorPrefixes = [`${actor.name}:`, `${actor.id}:`];
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    // Exp-4 item 6 / F22: fallback attempts never happened — their
    // questions were never asked and must not become open questions.
    // Detected via the sentinel, never the "(not done)" substring.
    if (entry.includes(NOT_DONE_SENTINEL)) continue;
    if (!entry.includes("?")) continue;
    const lower = entry.toLowerCase();
    const mentionsMe = lower.includes(nameLower) || lower.includes(idLower) || /\byou\b/.test(lower);
    const mine = lower.startsWith(`${nameLower}:`) || lower.startsWith(`${idLower}:`);
    if (!mentionsMe || mine) continue;
    // Answered once the addressee authored any later entry (their response
    // turn) — until then the question stays open no matter how many other
    // turns intervene. Q1: clean turns now record the narrative, so a
    // question answered in narrative prose still closes the question.
    const answered = entries
      .slice(i + 1)
      .some((later) => authorPrefixes.some((p) => later.startsWith(p)));
    if (!answered) out.push(entry);
  }
  return out.slice(-limit);
}

/**
 * Exp-4 item 9: machine-detectable identity leak. Flags proposal/selection
 * text written from the wrong actor's POV (tick 8 Dana-as-Anton, tick 19
 * Tanya-as-Anton): a leading clause with another roster actor as the
 * grammatical subject ("Anton walks…" on Dana's turn) or psychology
 * attributed to them ("Anton wants…", "Tanya is eager to…"). Vocatives
 * ("Tanya, could you…") and possessives ("Tanya's desk") are NOT leaks —
 * only Name + verb. Returns a human-readable reason or undefined.
 */
export function detectIdentityLeak(
  world: World,
  actorId: string,
  text: string,
): string | undefined {
  const others = world.actors.filter((a) => a.id !== actorId);
  if (others.length === 0 || text.trim().length === 0) return undefined;
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const subjectVerbs =
    "is|are|was|were|has|have|had|wants?|needs?|eager|thinks?|feels?|knows?|" +
    "walks?|goes|comes?|moves?|stands?|sits?|turns?|approaches?|enters?|leaves?|returns?|joins?|follows?|" +
    "says?|said|speaks?|talks?|tells?|asks?|replies?|answers?|shouts?|whispers?|thanks?|greets?|welcomes?|waves?|" +
    "looks?|watches?|sees?|nods?|smiles?|laughs?|shakes?|hugs?|hands?|gives?|takes?|picks?|opens?|pours?|types?|sips?";
  for (const o of others) {
    const first = o.name.split(/[^a-z0-9]+/i)[0] ?? "";
    const variants = new Set<string>();
    if (o.id.length >= 2) variants.add(o.id.toLowerCase());
    if (o.name.length >= 2) variants.add(o.name.toLowerCase());
    if (first.length >= 3) variants.add(first.toLowerCase());
    for (const v of variants) {
      // Leading subject: "Anton walks…" / "Anton is eager…" — but never
      // "Anton," (vocative) or "Anton's" (possessive/landmark).
      const leadRe = new RegExp(`^${esc(v)}\\s+(${subjectVerbs})\\b`, "i");
      const firstClause = text.split(/[.!?;]+|\s+and\s+|\s+then\s+/i)[0]?.trim() ?? "";
      if (firstClause.length > 0 && leadRe.test(firstClause)) {
        return `identity leak: text casts "${o.id}" as the acting subject ("${firstClause.slice(0, 60)}…") on ${actorId}'s turn — act as ${actorId} only`;
      }
      // Psychology attribution anywhere: "Anton wants to familiarize…"
      // (tick 8), "Tanya knows the best way for Anton…" is fine (about
      // others is OK) — only flag "<Other> wants/needs/is eager" goals.
      // Exp-5 item 7: broadened beyond wants/needs — a selection reasoning
      // that plans, decides, hopes, or worries FOR another roster actor is
      // the same POV swap ("Jeff responds, 'Okay, Anton…'"-class).
      const psychRe = new RegExp(
        `\\b${esc(o.name)}\\s+(wants?|needs?|is\\s+eager|eager\\s+to|plans?|intends?|intending|decides?|decided|tries?\\s+to|hopes?|hoping|worries|worried|keen\\s+to)\\b`,
        "i",
      );
      if (psychRe.test(text)) {
        return `identity leak: text attributes "${o.id}"'s goals ("${text.match(psychRe)?.[0]}") on ${actorId}'s turn — pursue YOUR goal, not theirs`;
      }
    }
  }
  return undefined;
}

/** Core verbs for the handshake/greeting attractor dedup (Exp-4 item 10). */
const CORE_VERBS: Array<[RegExp, string]> = [
  [/\b(handshake|shakes?\s+hands?|shake|shakes?|shook|shaking|shaken)\b/i, "shake"],
  [/\b(hugs?|hugged|hugging|embrace|embraces|embraced)\b/i, "hug"],
  [/\b(high[\s-]?five|fist[\s-]?bump|pats?|patted|slaps?|slapped)\b/i, "contact"],
  [/\b(greets?|greeted|greeting|welcomes?|welcomed|welcoming)\b/i, "greet"],
  [/\b(waves?|waved|waving)\b/i, "wave"],
  [/\b(thanks?|thanked|thanking)\b/i, "thank"],
  [/\b(asks?|asked|asking)\b/i, "ask"],
  [/\b(tells?|told|telling|explains?|explained|explaining|discuss|discusses|discussed)\b/i, "tell"],
  [/\b(walks?|walked|walking|goes?|went|going|heads?|headed|heading|moves?|moved|moving|approach|approaches|approached|comes?|came|coming)\b/i, "move"],
  [/\b(sits?|sitting|sat)\b/i, "sit"],
  [/\b(stands?|standing|stood)\b/i, "stand"],
  [/\b(pours?|poured|pouring|brews?|brewed|fills?|filled)\b/i, "pour"],
  [/\b(pick\s+up|picks\s+up|grabs?|grabbed|holds?|held|holding|carry|carries|carried|opens?|opened|opening)\b/i, "take"],
  [/\b(sips?|sipped|sipping|drinks?|drank|drinking|types?|typed|typing)\b/i, "use"],
  [/\b(introduces?|introduced|introducing)\b/i, "introduce"],
  // Exp-5 item 9 (S8): the offer verb — "I offer to help Anton set up
  // his laptop" keyed to "other|anton" and the exact-key ban lost its
  // precision (exp-5 ticks 13/19/22).
  [/\b(offers?|offered|offering)\b/i, "offer"],
  [/\b(looks?|looked|looking|glances?|glanced|watch|watches|nods?|nodded|smiles?|smiled)\b/i, "gesture"],
  // Exp-3 item 6 (S2): push/pull verbs — chair-push keyed to "other|" and
  // escaped the per-intent failure memory entirely.
  [/\b(push|pushes|pushed|pushing|pull|pulls|pulled|pulling|slides?|slid|sliding|shoves?|shoved)\b/i, "push"],
  // Exp-6 item 9 (S7): verb-form normalization for micro-fiddling —
  // "shift/shifts/shifted", "rearrange", "adjust", "nudge", "tidy" all
  // stem to "adjust" so paraphrase variants core identically
  // (exp-6: "move dana_papers to the side" vs "shifts the dana_papers
  // to the left" evaded the string-match ban).
  [/\b(shifts?|shifted|shifting|rearranges?|rearranged|adjusts?|adjusted|adjusting|nudges?|nudged|straightens?|straightened|tidi(?:es|ed|ying))\b/i, "adjust"],
  // Stage-1 A1: put-down/transfer verbs — "places the laptop on the desk"
  // must core to "putdown|…" rather than "other|desk", or it collides with
  // "stays at her desk and keeps working" and the repetition screen
  // rejects a semantically unrelated action as a repeat.
  [/\b(places?|placed|placing|puts?|putting|sets?|setting|lays?|laid|laying)\b/i, "putdown"],
];

/** Object-kind nouns for the attractor core (desk/coffee/task/…).
 * Boundaries are snake_case-aware: "dana_papers" names papers ("_" and "-"
 * are separators for object compounds). Actor mentions in `mentioned()`
 * stay strict-\b — "dana_papers" must NOT count as naming Dana, or
 * "move dana_papers" keys to "move|dana" and the paraphrase ban misses
 * (exp-6 item 9, tick-24). */
const looseWord = (body: string): RegExp =>
  new RegExp(`(?:^|[^a-z0-9])(?:${body})(?:$|[^a-z0-9])`, "i");
/**
 * Stage-1 A1: noun stems naming holdable object kinds. For manipulation
 * verbs the manipulated object is the stronger dedup signal than the
 * location, so these scan before location nouns in `suggestionCore`.
 */
const HOLDABLE_NOUN_STEMS: ReadonlySet<string> = new Set(["laptop", "mug", "papers"]);

const CORE_NOUNS: Array<[RegExp, string]> = [
  [looseWord("desk"), "desk"],
  [looseWord("coffee"), "coffee"],
  [looseWord("laptop"), "laptop"],
  [looseWord("mug|cup"), "mug"],
  [looseWord("task|code|backend"), "task"],
  [looseWord("question|help|directions?"), "question"],
  [looseWord("email|papers?|notes?"), "papers"],
  [looseWord("break|lunch|tea"), "break"],
  [looseWord("meeting"), "meeting"],
  [looseWord("hand|hands"), "hand"],
  // Exp-3 item 6 (S2): chair/table nouns — "push the chair in" needs a
  // keyable noun for the failure memory.
  [looseWord("chair"), "chair"],
  [looseWord("table"), "table"],
];

/**
 * Exp-4 item 10: verb+noun core of an action from one actor's perspective
 * ("Anton shakes hands with Tanya" on Tanya's turn → "shake|anton"). The
 * repetition guard lists prior actions but the model re-emits them anyway
 * (6 handshakes, 6 greetings) — comparing cores proposal-side beats
 * another prompt line. The deciding actor (`selfId`) is skipped when
 * scanning mentions so both "Shake Anton's hand" and the observer-subject
 * variant "Anton shakes hands with Tanya" core to the other participant;
 * when nobody else is named, the concrete object kind wins over the self
 * mention ("Dana shifts the dana_papers" → "adjust|papers", not
 * "adjust|dana") — the intent is about the object.
 */
export function suggestionCore(world: World, text: string, selfId?: string): string {
  const lower = text.toLowerCase();
  let verb = "other";
  for (const [re, stem] of CORE_VERBS) {
    if (re.test(text)) {
      verb = stem;
      break;
    }
  }
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentioned = (a: { id: string; name: string }): boolean => {
    const first = a.name.split(/[^a-z0-9]+/i)[0]?.toLowerCase() ?? "";
    // Exp-6 item 9: word-boundary matches — "dana_papers" must not count
    // as mentioning actor "dana" (exp-6 tick-24 keyed "move|dana" instead
    // of "adjust|papers" and the paraphrase ban missed).
    return (
      (a.id.length >= 2 &&
        new RegExp(`\\b${escapeRe(a.id.toLowerCase())}\\b`).test(lower)) ||
      (a.name.length >= 2 &&
        new RegExp(`\\b${escapeRe(a.name.toLowerCase())}\\b`).test(lower)) ||
      (first.length >= 3 && new RegExp(`\\b${first}\\b`).test(lower))
    );
  };
  let noun = "";
  let nounIsActor = false;
  for (const a of world.actors) {
    if (selfId !== undefined && a.id === selfId) continue;
    if (mentioned(a)) {
      noun = a.id;
      nounIsActor = true;
      break;
    }
  }
  // Exp-6 item 9: object-kind before the self-mention fallback — "Dana
  // shifts the dana_papers" is about the papers, not about Dana; the self
  // mention ("Dana" at the start) is the weaker signal.
  // Stage-1 A1: manipulation verbs ("take", "putdown") care about the
  // manipulated object, not the location — holdable-kind nouns scan first
  // so "places the laptop on the desk" cores to "putdown|laptop" (not
  // "putdown|desk", which would collide across different manipulated
  // objects the same way "other|desk" did).
  if (noun === "") {
    const scanOrder =
      verb === "take" || verb === "putdown"
        ? [
            ...CORE_NOUNS.filter(([, stem]) => HOLDABLE_NOUN_STEMS.has(stem)),
            ...CORE_NOUNS.filter(([, stem]) => !HOLDABLE_NOUN_STEMS.has(stem)),
          ]
        : CORE_NOUNS;
    for (const [re, stem] of scanOrder) {
      if (re.test(text)) {
        noun = stem;
        break;
      }
    }
  }
  if (noun === "" && selfId !== undefined) {
    const self = world.actors.find((a) => a.id === selfId);
    if (self && mentioned(self)) {
      noun = self.id;
      nounIsActor = true;
    }
  }
  // Exp-6 item 9 (S7): object-strip normalization — "move the papers"
  // and "shift the papers" are the same micro-fiddling intent, so an
  // object-kind noun unifies move/adjust verbs under "adjust".
  // Locomotion keeps "move": its noun is a roster actor, never an
  // object kind ("Walk to Tanya" stays "move|tanya").
  if (!nounIsActor && noun !== "" && (verb === "move" || verb === "adjust")) {
    verb = "adjust";
  }
  return `${verb}|${noun}`;
}

/**
 * Exp-4 item 10: does this text repeat a recent own action's core?
 * Returns the repeated prior action or undefined.
 */
export function findCoreRepeat(
  world: World,
  actorId: string,
  text: string,
): string | undefined {
  const core = suggestionCore(world, text, actorId);
  for (const prior of getRecentOwnActions(world, actorId)) {
    if (suggestionCore(world, prior, actorId) === core) return prior;
  }
  return undefined;
}

/** Recent actions this actor already took (for the repetition guard). */
export function getRecentOwnActions(world: World, actorId: string, limit = MAX_RECENT_OWN_ACTIONS): string[] {
  const actor = getActorById(world, actorId);
  if (!actor) return [];
  const prefixName = `${actor.name}:`;
  const prefixId = `${actor.id}:`;
  // Exp-4 item 6 / F22: fallback attempts ("tried … (not done)" +
  // sentinel) never happened — neither a repeat to avoid nor a question
  // answered. The "tried:" prefix already misses the ":" author match
  // below; the explicit sentinel filter keeps this true even if the
  // format ever changes.
  // Stage-1 A4: cores derive from the ground-truth ACTION text, never
  // from the narrative — a mis-rendered narrative ("walks toward Dana"
  // for an engine move toward Tanya) used to poison the core and let a
  // verbatim repeat slip past this guard. Entries predating the
  // actionText field fall back to the narrative text.
  const mine = world.history
    .filter(
      (h) =>
        !h.text.includes(NOT_DONE_SENTINEL) &&
        (h.text.startsWith(prefixName) || h.text.startsWith(prefixId)),
    )
    .map((h) => h.actionText ?? h.text);
  return mine.slice(-limit);
}

/**
 * Persona anchoring (action item 10): restate who this actor is — and who
 * they are NOT — so a recruiter never adopts the new hire's developer
 * identity. Selection and consequence both embed this line.
 */
export function buildIdentityAnchor(world: World, actorId: string): string {
  const actor = getActorById(world, actorId);
  if (!actor) return `You are ${actorId}.`;
  const others = world.actors
    .filter((a) => a.id !== actorId)
    .map((a) => `${a.name} (${a.id})`);
  const notLine = others.length > 0 ? ` You are NOT ${others.join(", ")} — never act as them, never use their role, goal, or skills.` : "";
  // Exp-7 item A6: name the acting actor's pronouns up front so the writer
  // never has to infer them (exp-7 B5: Dana rendered as "she/her").
  return `IDENTITY: You are ${actor.name} (${actor.id}, ${actorPronouns(actor)}). Role: ${actor.persona} Current goal: ${actor.goal}.${notLine} Your next action must fit YOUR role and goal above.`;
}

/** Pronouns for the roster anchor: explicit tag when present, else inferred. */
export function actorPronouns(a: { pronouns?: string; persona: string }): string {
  return a.pronouns ?? extractPronouns(a.persona);
}

export function extractPronouns(persona: string): string {
  const lower = persona.toLowerCase();
  if (/she\/her/.test(lower)) return "she/her";
  if (/he\/him/.test(lower)) return "he/him";
  if (/they\/them/.test(lower)) return "they/them";
  const she = (lower.match(/\b(she|her|hers|herself)\b/g) ?? []).length;
  const he = (lower.match(/\b(he|him|his|himself)\b/g) ?? []).length;
  if (she > he && she > 0) return "she/her";
  if (he > she && he > 0) return "he/him";
  return "they/them";
}

/**
 * Roster + pronoun anchor (exp-2 item 9, ticks 2/3/5/14/15/20/26 repro):
 * one line naming every actor that exists — with pronouns and positions —
 * plus an explicit closed-world rule. Embedded in proposal, selection, and
 * consequence contexts so a small model never invents Jeff/Samantha/Julie/
 * Lisa/Bob/Mia/Tyrone or an "interviewer". Doubles as the memory-refresh
 * line (exp-2 item 13): colleagues are listed as known hired coworkers with
 * their current goal, never strangers or candidates.
 */
export function buildRosterAnchor(world: World): string {
  // Names, pronouns, and positions only — goals/memories stay private to
  // each actor's own context (subjective contexts must never leak another
  // actor's hidden state).
  const parts = world.actors.map(
    (a) => `${a.name} (${a.id}, ${actorPronouns(a)}) at (${a.x}, ${a.y})`,
  );
  return [
    `ROSTER (the ONLY people who exist here): ${parts.join("; ") || "(none)"}.`,
    "No one else exists — never invent, address, or describe anyone else (no extra names, no interviewer, no newcomers).",
    "Treat everyone listed as a known hired coworker per their role above — never as a stranger, candidate, or applicant.",
    "Preserve every actor's pronouns exactly as listed above in all prose and patches.",
  ].join(" ");
}

/**
 * Exp-3 item 13: relationship refresh that actually fires. The global
 * roster anchor ("known hired coworker") is ignored by small models
 * (Tanya stranger-framed Anton 3×), so each subjective/objective context
 * also carries a per-actor line: name, id, pronouns, and the first clause
 * of the persona (role + key history, e.g. the Sixt referral) — framed as
 * known colleagues, never strangers/candidates.
 */
export function buildRelationshipRefresh(world: World, actorId: string): string {
  const others = world.actors.filter((a) => a.id !== actorId);
  if (others.length === 0) return "Known colleagues: (none).";
  const parts = others.map((a) => {
    const firstClause = a.persona.split(/[.!\n]/)[0]?.trim() || a.persona.slice(0, 80);
    return `${a.name} (${a.id}, ${extractPronouns(a.persona)}) — ${firstClause}`;
  });
  return (
    `KNOWN COLLEAGUES (never strangers, candidates, or applicants): ${parts.join("; ")}. ` +
    `React to them as the established coworkers described above.`
  );
}

/**
 * Phase 5 per-actor newcomer refresh (Exp-3 item 13 / Exp-2 item 13, still
 * open: the global "known hired coworker" line is ignored and Tanya
 * stranger-framed Anton 3×). For each colleague this actor sees, pull the
 * hiring/referral/history sentences from that colleague's PUBLIC persona
 * (role + referral facts, e.g. "hired backend dev, ex-Sixt with Tanya,
 * referred by her") and restate them as established fact — never a
 * stranger/candidate. Only persona text is used (no leaked goals,
 * memories, or thoughts), and the line is emitted in *subjective*
 * (proposal/selection) contexts so the viewer stops re-framing known
 * coworkers. Returns "" when no colleague carries referral/history facts
 * (e.g. tiny test worlds) so the prompt pays nothing.
 */
export function buildCoworkerAnchor(world: World, actorId: string): string {
  const viewer = getActorById(world, actorId);
  if (!viewer) return "";
  const factRe = /referr|sixt|first day|new coworker|new backend|joined (this|the) team|hired/i;
  const lines: string[] = [];
  for (const other of world.actors) {
    if (other.id === actorId) continue;
    const facts = other.persona
      .split(/(?<=[.!])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && factRe.test(s));
    if (facts.length === 0) continue;
    lines.push(
      `${other.name} (${other.id}): ${facts.join(" ")} — established hired coworker, never a stranger/candidate/applicant.`,
    );
  }
  if (lines.length === 0) return "";
  return `KNOWN HISTORY (do not re-frame as strangers): ${lines.join(" ")}`;
}

/**
 * Exp-3 item 9: exact object-ID catalog. The landmarks line lists
 * `name (id)` but small models still emit "coffee mug"/"paper"/
 * "tanya's_desk"-style ids (ticks 10/11). Group the scene's small props by
 * kind with their exact ids so there is nothing to guess.
 */
export function buildObjectIdCatalog(world: World): string {
  const groups: Array<[string, RegExp]> = [
    ["Mugs", /mug|cup/i],
    ["Papers", /paper|document|note/i],
    ["Desks", /desk|table/i],
    ["Coffee", /coffee/i],
    ["Chairs", /chair|sofa|seat/i],
    ["Laptops", /laptop|monitor/i],
    ["Doors", /door|entrance|exit/i],
  ];
  const lines: string[] = [];
  for (const [label, re] of groups) {
    const ids = world.scene.objects
      .filter((o) => re.test(o.name) || re.test(o.id))
      .map((o) => `\`${o.id}\``);
    if (ids.length > 0) lines.push(`${label} are ${ids.join(", ")}`);
  }
  if (lines.length === 0) return "Object ids: (no small props in this scene).";
  return (
    `OBJECT IDS (use these exact ids — never invent variants like 'coffee mug' or 'paper'; ` +
    `using any other id fails validation): ${lines.join("; ")}.`
  );
}

// Phase 3: the object-affordance nudge (Exp-6 item 8 / Q7) is deleted.
// It demanded object/prop patches from the model up front — a dead
// instruction now that manipulation is engine-owned (the engine plans the
// manipulation from the action text and applies it before validation, and
// every model-emitted object/prop patch is stripped). The EXECUTED
// MANIPULATION facts in the consequence context carry what happened.

// Proposal and Selection contexts contain ONLY what the current actor
// perceives, remembers, believes, and knows — never another actor's
// private memories, beliefs, hidden goals, or unperceived events.
/**
 * Fact lines describing the engine-executed pose for the narrate input,
 * mirroring `executedMovementFacts` / `exactQuoteFacts` /
 * `executedManipulationFacts`. Pure.
 */
export function executedPoseFacts(
  world: World,
  actorId: string,
  pose: PlannedPose | null,
): string[] {
  const actor = world.actors.find((a) => a.id === actorId);
  const name = actor?.name ?? actorId;
  if (pose === null) {
    return [
      `EXECUTED POSE: no pose change — ${name} remains ${actor?.pose ?? "standing"}.`,
    ];
  }
  return [
    `EXECUTED POSE (the engine already changed the acting actor's pose — narrate exactly this):`,
    `${name} is now ${pose === "sit" ? "sitting" : "standing"}.`,
    "Do not invent other pose changes.",
  ];
}

/**
 * PLAN_V2 Phase 4: the executed facts assembled for the narrate input —
 * what the engine actually did this turn, plus the attempted-vs-executed
 * gap when a channel clamped. Mirrors `ConsequenceResolveOpts` (undefined
 * = unknown / older callers; null = computed, nothing there).
 */
export type NarrateContextFacts = {
  engineMovement?: MovementOutcome | null;
  exactQuote?: string | null;
  enginePose?: PlannedPose | null;
  engineManipulation?: ManipulationOutcome | null;
  clamp?: TurnClamp | null;
};

/**
 * PLAN_V2 Phase 4: the narrate prompt. The input is the EXECUTED-FACTS
 * block (what the engine actually did + the ATTEMPTED-vs-EXECUTED gap
 * block when a clamp fired) — NOT the intended action. The prompt tells
 * the narrator "these facts are final; narrate what happened."
 *
 * Deliberately leaner than `buildConsequenceContext`: no action text,
 * no patch/emission rules (the render contract is prose-only), no
 * per-turn history (the echo attractor). What remains is the facts, the
 * grounding rules, and the closed-world roster — enough to narrate one
 * honest paragraph, nothing to invent from.
 */
export function buildNarrateContext(
  world: World,
  action: Action,
  feedback: string | undefined,
  facts: NarrateContextFacts,
): string {
  const actor = getActorById(world, action.actorId);
  const actorName = actor?.name ?? action.actorId;
  const lines = [
    "NARRATE THE EXECUTED FACTS",
    "",
    "These facts are FINAL — the engine already executed this turn. Your job is to narrate WHAT HAPPENED,",
    "not what was intended, imagined, or wished for. A failed attempt listed below is a story beat:",
    "narrate the attempt AND its honest outcome (she reaches for his hand, but he's across the room).",
    "Never smooth a failure into success, never drop it silently, and never emit (not done).",
    "",
    actor !== undefined
      ? `Acting actor: ${actor.name} (${actor.id}, ${actorPronouns(actor)}) — final position (${actor.x}, ${actor.y}).`
      : `Acting actor: ${action.actorId} (unknown).`,
    "",
    // The executed facts — the narrator's only source of truth.
    ...(facts.engineMovement !== undefined
      ? executedMovementFacts(world, action.actorId, facts.engineMovement)
      : []),
    ...(facts.exactQuote !== undefined
      ? exactQuoteFacts(world, action.actorId, facts.exactQuote)
      : []),
    ...(facts.engineManipulation !== undefined
      ? executedManipulationFacts(world, action.actorId, facts.engineManipulation)
      : []),
    ...(facts.enginePose !== undefined
      ? executedPoseFacts(world, action.actorId, facts.enginePose)
      : []),
    // PLAN_V2 Phase 3: the honest gap — narrate the attempt that fell short.
    ...(facts.clamp !== undefined && facts.clamp !== null
      ? describeClamp(world, action.actorId, facts.clamp)
      : []),
    "",
    "GROUNDING RULES (keep the prose honest):",
    "- Third person only. Describe ONLY the acting actor's directly observable behavior.",
    "- Never describe another actor perceiving, hearing, speaking, moving, glancing, or reacting — even passively.",
    "  Observers react in their own thoughts, on their own turns; their visible response is never yours to narrate.",
    "- Narrate ONLY the executed facts above — never invent a walk, pose change, pick-up/put-down/hand-over,",
    "  or quoted dialogue the facts don't show.",
    "- Speech: when an EXACT QUOTE is listed above, the narrative MUST contain it character-for-character.",
    "  Copy it verbatim — never paraphrase, alter, truncate, or invent other dialogue.",
    "",
    `All actor positions: ${world.actors.length > 0 ? world.actors.map((a) => `${a.name} (${a.id}) at (${a.x}, ${a.y})`).join(" | ") : "(none)"}`,
    "",
    `IDENTITY RULE: ${buildIdentityAnchor(world, action.actorId)} Act out YOUR role only.`,
    "",
    `ROSTER RULE: ${buildRosterAnchor(world)}`,
    "",
    buildRelationshipRefresh(world, action.actorId),
  ];
  if (feedback !== undefined && feedback !== "") {
    lines.push("", "Validation Feedback (previous output was invalid)", "", feedback);
  }
  lines.push(
    "",
    // PLAN_V2 Phase 5 (the director): the style guide — instructions for
    // eventful narration, copied from the PLAN_V2 appendix draft. It tells
    // the narrator how to *handle* drama, not when to invent it; the
    // deterministic staleness trigger decides when incidents arrive.
    "DIRECTOR STYLE GUIDE (how to handle drama — never invent it):",
    "",
    "You are narrating a living scene, not transcribing one. Favor the specific over the generic: a chipped mug, not \"a cup\". " +
      "Let small frictions surface — interruptions, misunderstandings, unfinished sentences. " +
      "When a director incident arrives, treat it as real and let every character react in character; do not resolve it in the same paragraph it appears. " +
      "Never summarize feelings instead of showing them. " +
      "Never let three consecutive turns pass with everyone merely being polite — if the facts give you nothing, say what the room feels like. " +
      "The world facts are final: narrate what happened, not what should have.",
    "",
    "Task",
    "",
    `Narrate what ${actorName} observably did this turn, grounded strictly in the executed facts above.`,
    "Return COMPACT single-line JSON only.",
  );
  return lines.join("\n");
}
