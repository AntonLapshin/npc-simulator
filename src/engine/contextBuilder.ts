import type { Action, Actor, EngineConfig, HistoryEntry, SceneObject, World } from "../types.js";
import { NOT_DONE_SENTINEL, normalizeHistoryEntry } from "../types.js";
import { defaultConfig } from "../config.js";
import { sanitizeDisplayText } from "../util/sanitize.js";
import { distance } from "./geometry.js";
import {
  findManipulatedObjects,
  mentionsObjectVariant,
  objectMentionVariants,
  resolveDestinationActorId,
  resolveDestinationObjectId,
  resolveMentionedActorId,
} from "./deterministicSemantics.js";
import { OBJECT_INTERACT_RADIUS } from "./validate/objects.js";
import {
  getVisibleActors,
  getAudibleActors,
  getVisibleObjects,
  getActorById,
} from "./perceptionHelpers.js";
import { LIVENESS_HISTORY_MARKER } from "./patchApplier.js";
import { executedMovementFacts, type MovementOutcome } from "./movementExecutor.js";
import { exactQuoteFacts } from "./speechExecutor.js";

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
];

/** Object-kind nouns for the attractor core (desk/coffee/task/…).
 * Boundaries are snake_case-aware: "dana_papers" names papers ("_" and "-"
 * are separators for object compounds). Actor mentions in `mentioned()`
 * stay strict-\b — "dana_papers" must NOT count as naming Dana, or
 * "move dana_papers" keys to "move|dana" and the paraphrase ban misses
 * (exp-6 item 9, tick-24). */
const looseWord = (body: string): RegExp =>
  new RegExp(`(?:^|[^a-z0-9])(?:${body})(?:$|[^a-z0-9])`, "i");
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
  if (noun === "") {
    for (const [re, stem] of CORE_NOUNS) {
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
 * Exp-5 item 9 (S8): concrete object-kind nouns for intent-CLUSTER bans.
 * The exact verb|noun key misses near-variants of one failing intent
 * ("I offer to help Anton set up his laptop" → offer|anton vs "I glance
 * at the test plan on my laptop" → gesture|laptop — same laptop-setup
 * cluster, different keys; exp-5 ticks 13/19/22). Only concrete object
 * kinds cluster (desk, coffee, laptop, mug, …): actor mentions are
 * deliberately excluded — banning every Anton-directed intent after two
 * failed walks would also kill greetings — and so are abstract nouns
 * (task, question). Pure.
 */
const CLUSTER_NOUNS: Array<[RegExp, string]> = [
  [looseWord("desk"), "desk"],
  [looseWord("coffee"), "coffee"],
  [looseWord("laptop"), "laptop"],
  [looseWord("mug|cup"), "mug"],
  [looseWord("email|papers?|notes?"), "papers"],
  [looseWord("chair"), "chair"],
  [looseWord("table"), "table"],
  [looseWord("hand|hands"), "hand"],
];

export function suggestionClusterNouns(text: string): string[] {
  const out: string[] = [];
  for (const [re, stem] of CLUSTER_NOUNS) {
    if (re.test(text) && !out.includes(stem)) out.push(stem);
  }
  return out;
}

/**
 * Exp-3 item 6 (S2): prompt line naming this actor's currently-banned
 * intents so the proposal engine doesn't burn suggestion slots on them.
 * Returns "" when nothing is banned. Single trailing scan: per-key counts
 * in the window before the first applied own entry ARE the consecutive
 * streaks (non-matching intents don't break the streak — only an applied
 * own entry does), so this matches consecutiveIntentFailures exactly.
 */
function buildFailedIntentsLine(world: World, actorId: string, cfg: EngineConfig): string {
  const threshold = cfg.intentFailureBanThreshold ?? 2;
  const actor = world.actors.find((a) => a.id === actorId);
  const prefixes =
    actor !== undefined
      ? [`${actor.name}:`, `${actor.id}:`, `${actor.name} tried:`, `${actor.id} tried:`]
      : [`${actorId}:`, `${actorId} tried:`];
  const counts = new Map<string, number>();
  const examples = new Map<string, string>();
  for (let i = world.history.length - 1; i >= 0; i--) {
    const text = world.history[i]!.text;
    if (!prefixes.some((p) => text.startsWith(p))) continue;
    // Exp-4 item 7 (S3): liveness-floor entries bypass validation — they
    // neither count as failures nor break the streak (matches
    // consecutiveIntentFailures).
    if (text.includes(LIVENESS_HISTORY_MARKER)) continue;
    if (!text.includes(NOT_DONE_SENTINEL)) break;
    const beforeSentinel = text.split(NOT_DONE_SENTINEL)[0] ?? "";
    const triedIdx = beforeSentinel.indexOf(" tried: ");
    if (triedIdx < 0) continue;
    let actionText = beforeSentinel.slice(triedIdx + " tried: ".length);
    const notDone = " (not done)";
    if (actionText.endsWith(notDone)) actionText = actionText.slice(0, -notDone.length);
    const key = suggestionCore(world, actionText, actorId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!examples.has(key)) examples.set(key, actionText);
  }
  const banned: string[] = [];
  for (const [key, count] of counts) {
    if (count < threshold) continue;
    const example = (examples.get(key) ?? key).replace(/\s+/g, " ").trim();
    const short = example.length > 60 ? `${example.slice(0, 57)}…` : example;
    banned.push(`"${short}" (${key}, failed ${count}x)`);
  }
  if (banned.length === 0) return "";
  return (
    `Your recent attempts at these FAILED and could not be rendered: ${banned.join("; ")}. ` +
    `Do NOT suggest them again — try a fundamentally different approach.`
  );
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

/**
 * Exp-5 items 5+7: pre-consequence selection screen. Returns a rejection
 * reason when the chosen action casts another roster actor as the subject /
 * pursues their goals (POV mismatch, item 7) or repeats the verb+noun core
 * of a recent own action (attractor loop, item 5) — so the turn can
 * substitute a clean candidate instead of burning 4 consequence attempts
 * on a known-bad pick. Used by the selection engine's format check and by
 * the turn orchestrator as defense-in-depth (mock engines don't check).
 */
export function validateSelectionForActor(
  world: World,
  actorId: string,
  actionText: string,
): string | undefined {
  const leak = detectIdentityLeak(world, actorId, actionText);
  if (leak !== undefined) return leak;
  // NOTE (Exp-4 item 6 / S4): no voice gate here. Proposal suggestions are
  // first-person BY DESIGN ("Write every suggestion from the deciding
  // actor's own point of view" — the "I" is unambiguous identity
  // anchoring), so rejecting first-person picks would substitute every
  // NPC turn to fallback. Voice discipline is enforced where it matters:
  // the consequence narrative gate (validateNarrativeVoice) keeps
  // first-person prose out of canonical history.
  const prior = findCoreRepeat(world, actorId, actionText);
  if (prior !== undefined) {
    return (
      `repetition: "${actionText.slice(0, 60)}" repeats recent action ` +
      `"${prior.slice(0, 60)}" (same verb+noun core) — choose something that moves the scene forward instead`
    );
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
  // format ever changes. Q1: clean turns record the narrative now, so
  // these are narrative records of own turns.
  const mine = world.history
    .map((h) => h.text)
    .filter(
      (h) => !h.includes(NOT_DONE_SENTINEL) && (h.startsWith(prefixName) || h.startsWith(prefixId)),
    );
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

/**
 * Exp-6 item 8 (object interaction), strengthened per Q7: affordance nudge.
 * Zero object touches across 70+ turns in four experiments is structural:
 * the engine punishes missing object/prop patches after the fact but never
 * *demands* them up front. Two tiers:
 * - STRONG: the action carries a manipulation verb or manipulates an
 *   object in a grab clause ("open the laptop") — the consequence is
 *   INCOMPLETE without the patch, stated as a hard requirement.
 * - SOFT: the action merely names a manipulable object (walk to the coffee
 *   machine) — one eliciting line so the consequence considers using it
 *   instead of narrating around it.
 * Both tiers name exact object ids, the required patch shape, and the
 * physical-reach rule (F4: within OBJECT_INTERACT_RADIUS cells). Building
 * fabric (walls/windows/doors/signs) is never manipulable.
 * Returns undefined when the action names nothing manipulable.
 */
const MANIPULATION_VERBS =
  "pour|pours|pouring|brew|brews|brewing|open|opens|opening|pick|picks|picking|grab|grabs|grabbing|" +
  "hold|holds|holding|carry|carries|carrying|sip|sips|sipping|drink|drinks|drinking|fill|fills|filling|" +
  "set\\s+up|boot|boots|booting|move|moves|moving|hand|hands|handing|pass|passes|passing|give|gives|giving|" +
  "sit|sits|sitting|sat|stand|stands|standing|stood";

const NON_MANIPULABLE_RE = /wall|window|door|sign/i;

/** Manipulable objects the action text names (by id/name), even without a manipulation verb. */
function findNamedManipulableObjects(
  world: World,
  actionText: string,
): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const o of world.scene.objects) {
    if (NON_MANIPULABLE_RE.test(`${o.id} ${o.name}`)) continue;
    if (objectMentionVariants(o).some((v) => mentionsObjectVariant(actionText, v))) {
      out.push({ id: o.id, name: o.name });
    }
  }
  return out;
}

export function buildObjectAffordanceNudge(world: World, action: Action): string | undefined {
  const verbHit = new RegExp(`\\b(?:${MANIPULATION_VERBS})\\b`, "i").test(action.text);
  // Objects the action text manipulates in a grab/manipulation clause
  // ("open the laptop" → anton_laptop; "walk to the desk to set up the
  // laptop" → the laptop, not the desk). Building fabric is not
  // manipulable.
  const manipulated = findManipulatedObjects(world, action.text).filter(
    (o) => !NON_MANIPULABLE_RE.test(`${o.id} ${o.name}`),
  );
  if (verbHit || manipulated.length > 0) {
    const target =
      manipulated.length > 0
        ? manipulated.map((o) => `"${o.id}" (${o.name})`).join(", ")
        : "the named object (resolve its exact id from OBJECT IDS above)";
    const patchFor =
      manipulated.length > 0
        ? manipulated.map((o) => `"${o.id}"`).join(", ")
        : "the object";
    return (
      `OBJECT AFFORDANCE: the action manipulates ${target} — the consequence is INCOMPLETE without its patch: ` +
      `set 'prop' (cup|laptop|null) and/or an objectPatch for ${patchFor} reflecting the change (new description, position, or passable/blocksVision/blocksSound flags). ` +
      `PHYSICAL REACH: moving/resizing/toggling an object requires the acting actor within ${OBJECT_INTERACT_RADIUS} cells of it — walk up first, then manipulate. ` +
      `A verb like pour/open/pick up/hold/sit with no backing patch fails validation — emit the patch, do not just narrate the verb.`
    );
  }
  // Q7 soft tier: the action names a manipulable object without a
  // manipulation verb ("walk to the coffee machine", "stand by the desk").
  // Elicit the interaction instead of letting the turn narrate past it.
  const named = findNamedManipulableObjects(world, action.text);
  if (named.length === 0) return undefined;
  const target = named.map((o) => `"${o.id}" (${o.name})`).join(", ");
  return (
    `OBJECT AFFORDANCE: the action names ${target}. If the actor uses, touches, or changes it in any way, ` +
    `that MUST be backed by an objectPatch for its exact id (or 'prop' for a held item) — narrating the use without the patch fails validation. ` +
    `Manipulation requires being within ${OBJECT_INTERACT_RADIUS} cells of the object.`
  );
}

// Proposal and Selection contexts contain ONLY what the current actor
// perceives, remembers, believes, and knows — never another actor's
// private memories, beliefs, hidden goals, or unperceived events.
//
// Proposal is a slim affordance brainstorm (position + high-priority
// thoughts + state + goal + perceivables + narrative/history + beliefs +
// memories + constraints). Persona, emotion, and relationships are
// deliberately dropped here — Selection (the Laya personality gate) owns
// personalization. Selection uses the full subjective context instead.
//
// Proposal is a slim affordance brainstorm (position + high-priority
// thoughts + state + goal + perceivables + narrative/history + beliefs +
// memories + constraints). Persona, emotion, and relationships are
// deliberately dropped here — Selection (the Laya personality gate) owns
// personalization. Selection uses the full subjective context instead.
export function buildProposalContext(
  world: World,
  actorId: string,
  opts?: SubjectiveContextOptions,
): string {
  const actor = getActorById(world, actorId);
  if (!actor) throw new Error(`unknown actor: ${actorId}`);
  const visible = getVisibleActors(world, actorId);
  const objects = getVisibleObjects(world, actorId);
  const cfg = resolveCfg(opts);
  const historyLimit = resolveHistoryLimit(opts, cfg);
  const maxSuggestions = resolveMaxSuggestions(opts, cfg);
  // F6: the prompt sees only what this actor perceived or authored.
  const recentHistory = formatHistoryForPrompt(historyVisibleTo(world, actorId), historyLimit, undefined, cfg);
  const openQuestions = getOpenQuestions(world, actorId, MAX_OPEN_QUESTIONS, cfg);
  const questionsLine =
    openQuestions.length > 0
      ? `Open questions addressed to you (answer these before starting anything new):\n${openQuestions.map((q) => `- ${q}`).join("\n")}`
      : "Open questions addressed to you: (none)";
  const recentOwn = getRecentOwnActions(world, actorId);
  const repetitionLine =
    recentOwn.length > 0
      ? `Your recent actions (do NOT repeat yourself):\n${recentOwn.map((a) => `- ${a}`).join("\n")}\nDo not propose an action you already took above unless the situation clearly changed.`
      : "Your recent actions: (none yet)";
  // Exp-3 item 6 (S2): surface banned intents to the proposal engine so it
  // doesn't burn a suggestion slot on something the deterministic screen
  // will reject anyway. Soft signal only — the hard ban in runTurn is the
  // load-bearing half (small models ignore prompt lines).
  const failedIntentsLine = buildFailedIntentsLine(world, actorId, cfg);
  const coworkerAnchor = buildCoworkerAnchor(world, actorId);

  return [
    // Exp-4 item 9: the proposal prompt LEADS with who is deciding (not
    // buried after candidates) — POV swaps (Dana-as-Anton, Tanya-as-Anton)
    // are machine-rejected downstream (see detectIdentityLeak).
    buildIdentityAnchor(world, actorId),
    "",
    "Current Actor",
    "",
    `ID: ${actor.id}`,
    `Name: ${actor.name}`,
    `State: ${actor.state}`,
    `Goal: ${actor.goal}`,
    `${THOUGHTS_GUIDANCE}: ${actor.thoughts || "(none yet)"}`,
    "",
    questionsLine,
    "",
    repetitionLine,
    ...(failedIntentsLine ? ["", failedIntentsLine] : []),
    "",
    buildRosterAnchor(world),
    "",
    buildRelationshipRefresh(world, actorId),
    ...(coworkerAnchor !== "" ? ["", coworkerAnchor] : []),
    "",
    "Memories",
    "",
    summarizeListForPrompt(actor.memories),
    "",
    "Beliefs",
    "",
    summarizeListForPrompt(actor.beliefs),
    "",
    "Perceived Environment",
    "",
    `Position: ${actor.x}, ${actor.y}`,
    `Visible actors: ${formatVisibleActors(visible)}`,
    `Visible objects: ${formatVisibleObjects(objects)}`,
    `Current narrative: ${world.narrative}`,
    `Recent history: ${recentHistory}`,
    `Tick: ${world.tick}`,
    "",
    "Physical constraints: actors are points; non-passable objects block movement; movement must be reachable; stay inside scene bounds.",
    "If you move toward someone/something, you must END the turn strictly closer to them than you started (no teleports, no wrong-direction moves). Physical contact (handshake, handing coffee) requires ending ADJACENT to them.",
    "",
    "Task",
    "",
    `Generate up to ${maxSuggestions} possible actions this actor could take right now.`,
    "Actions may be physical, verbal, emotional, social, object-related, or any combination.",
    "Do not use fixed action categories.",
    "Each suggestion must be one free-form action sentence or short paragraph.",
    "Return JSON only.",
  ].join("\n");
}

function buildFullActorContext(
  world: World,
  actorId: string,
  opts?: SubjectiveContextOptions,
): string {
  const actor = getActorById(world, actorId);
  if (!actor) throw new Error(`unknown actor: ${actorId}`);
  const visible = getVisibleActors(world, actorId);
  const objects = getVisibleObjects(world, actorId);
  const cfg = resolveCfg(opts);
  const historyLimit = resolveHistoryLimit(opts, cfg);
  // F6: the prompt sees only what this actor perceived or authored.
  const recentHistory = formatHistoryForPrompt(historyVisibleTo(world, actorId), historyLimit, undefined, cfg);

  return [
    "Current Actor",
    "",
    `ID: ${actor.id}`,
    `Name: ${actor.name}`,
    `Persona: ${actor.persona}`,
    `State: ${actor.state}`,
    `Emotion: ${actor.emotion}`,
    `Goal: ${actor.goal}`,
    `${THOUGHTS_GUIDANCE}: ${actor.thoughts || "(none yet)"}`,
    "",
    "Memories",
    "",
    summarizeListForPrompt(actor.memories),
    "",
    "Beliefs",
    "",
    summarizeListForPrompt(actor.beliefs),
    "",
    "Relationships",
    "",
    summarizeListForPrompt(actor.relationships),
    "",
    "Perceived Environment",
    "",
    `Position: ${actor.x}, ${actor.y}`,
    `Visible actors: ${formatVisibleActors(visible)}`,
    `Visible objects: ${formatVisibleObjects(objects)}`,
    `Current narrative: ${world.narrative}`,
    `Recent history: ${recentHistory}`,
    `Tick: ${world.tick}`,
    "",
    "Physical constraints: actors are points; non-passable objects block movement; movement must be reachable; stay inside scene bounds.",
    "",
    "Task",
    "",
    "Generate possible actions this actor could take right now.",
    "Actions may be physical, verbal, emotional, social, object-related, or any combination.",
    "Do not use fixed action categories.",
    "Each suggestion must be one free-form action sentence or short paragraph.",
    "Return JSON only.",
  ].join("\n");
}

export function buildSelectionContext(
  world: World,
  actorId: string,
  suggestions: string[],
  opts?: SubjectiveContextOptions,
): string {
  const fullContext = buildFullActorContext(world, actorId, opts);
  const candidates =
    suggestions.length > 0
      ? suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "(no candidates)";
  const cfg = resolveCfg(opts);
  // F6: open questions are perception-filtered inside getOpenQuestions.
  const openQuestions = getOpenQuestions(world, actorId, MAX_OPEN_QUESTIONS, cfg);
  const recentOwn = getRecentOwnActions(world, actorId);
  const questionsBlock =
    openQuestions.length > 0
      ? [
          "",
          "Open questions addressed to you (action item: answer before anything new)",
          "",
          ...openQuestions.map((q) => `- ${q}`),
          "If someone asked you a direct question above, your chosen action should ANSWER it (with words, movement, or both) instead of repeating a greeting or going back to work.",
        ].join("\n")
      : "";
  const repetitionBlock =
    recentOwn.length > 0
      ? [
          "",
          "Your recent actions (do NOT repeat yourself)",
          "",
          ...recentOwn.map((a) => `- ${a}`),
          "Do not pick or invent an action you already took above unless the situation clearly changed. Greeting, welcoming, or walking over to the same person twice in a row is a repeat — choose something that moves the scene forward.",
        ].join("\n")
      : "";
  const coworkerAnchor = buildCoworkerAnchor(world, actorId);
  return [
    fullContext,
    "",
    buildIdentityAnchor(world, actorId),
    buildRosterAnchor(world),
    buildRelationshipRefresh(world, actorId),
    ...(coworkerAnchor !== "" ? [coworkerAnchor] : []),
    questionsBlock,
    repetitionBlock,
    "",
    "Candidate Actions",
    "",
    candidates,
    "",
    "Task",
    "",
    "Choose the action this actor actually performs.",
    "You may choose a candidate action or produce a different action if it better fits the actor and situation.",
    "Prefer answering an open question above over repeating a recent action above.",
    "Return the action text alone, without any leading candidate number (never '1. ...' or '3) ...').",
    "Return JSON only.",
  ].join("\n");
}

// Consequence context uses a slim objective snapshot (Phase 5 context
// budget) because it updates all affected actors and objects — but shipping
// the full world JSON grows linearly with memories/history and drowns small
// models (~15 min/21 turns, infeasible at 200 turns). The snapshot carries
// only what adjudication needs: the acting actor in detail, every actor's
// position (movement/adjacency reasoning), perceivers + named targets in
// detail, nearby + named-target objects with rects, bounded history, and
// the exact-id catalog (kept as a separate line below).
export function getPerceivingActors(
  world: World,
  action: Action,
  cfg: EngineConfig = defaultConfig,
): Actor[] {
  const actor = getActorById(world, action.actorId);
  if (!actor) return [];
  return world.actors.filter((o) => {
    if (o.id === action.actorId) return true;
    const from = { x: o.x, y: o.y };
    const to = { x: actor.x, y: actor.y };
    return (
      getVisibleActors(world, o.id, cfg).some((a) => a.id === action.actorId) ||
      getAudibleActors(world, o.id, cfg).some((a) => a.id === action.actorId) ||
      Math.abs(from.x - to.x) + Math.abs(from.y - to.y) <= 2
    );
  });
}

function formatSnapshotActor(a: Actor, thoughtsBudget = 160): string {
  const bits = [`${a.name} (${a.id}) at (${a.x}, ${a.y})`, `state=${a.state}`, `emotion=${a.emotion}`, `goal=${a.goal}`];
  if (a.pose) bits.push(`pose=${a.pose}`);
  if (a.prop) bits.push(`prop=${a.prop}`);
  if (a.thoughts) {
    const t = a.thoughts.length > thoughtsBudget ? a.thoughts.slice(0, thoughtsBudget - 3) + "..." : a.thoughts;
    bits.push(`thoughts="${t}"`);
  }
  return bits.join(", ");
}

function formatSnapshotObject(o: SceneObject): string {
  const desc = o.description.length > 120 ? o.description.slice(0, 117) + "..." : o.description;
  return `${o.name} (${o.id}) at (${o.x}, ${o.y}, ${o.w}x${o.h}) [${o.passable ? "passable" : "blocked"}]: ${desc}`;
}

/**
 * Phase 5 slim objective snapshot for the consequence call. Bounded by the
 * snapshot radius + named targets: far-actor memories and far furniture
 * never enter the prompt, so per-turn tokens stay flat as the run
 * compounds. Named movement/speech targets are always included even when
 * far (the walk needs their positions).
 */
export function buildSlimObjectiveSnapshot(
  world: World,
  action: Action,
  cfg: EngineConfig = defaultConfig,
  radius?: number,
): string {
  const r = radius ?? cfg.consequenceSnapshotRadius;
  const actor = getActorById(world, action.actorId);
  const at = actor ? { x: actor.x, y: actor.y } : { x: 0, y: 0 };
  const destActorId = actor ? resolveDestinationActorId(world, action.actorId, action.text) : undefined;
  const mentionedActorId = actor ? resolveMentionedActorId(world, action.actorId, action.text) : undefined;
  const destObjectId = resolveDestinationObjectId(world, action.text, action.actorId);
  const textLower = action.text.toLowerCase();

  const detailIds = new Set<string>();
  if (actor) detailIds.add(actor.id);
  for (const p of getPerceivingActors(world, action, cfg)) detailIds.add(p.id);
  if (destActorId) detailIds.add(destActorId);
  if (mentionedActorId) detailIds.add(mentionedActorId);
  const detailActors = world.actors.filter((a) => detailIds.has(a.id));

  const targetObjectIds = new Set<string>();
  if (destObjectId) targetObjectIds.add(destObjectId);
  const nearbyObjects = world.scene.objects.filter((o) => {
    if (targetObjectIds.has(o.id)) return false;
    // Named anywhere in the action text ("pour from the coffee machine").
    if (o.id.toLowerCase().length >= 3 && textLower.includes(o.id.toLowerCase())) {
      targetObjectIds.add(o.id);
      return false;
    }
    if (o.name.toLowerCase().length >= 3 && textLower.includes(o.name.toLowerCase())) {
      targetObjectIds.add(o.id);
      return false;
    }
    const center = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
    return distance(at, center) <= r;
  });
  const targetObjects = world.scene.objects.filter((o) => targetObjectIds.has(o.id));

  const stats = memoryGrowthStats(world);
  const lines = [
    `Scene: ${world.scene.width}x${world.scene.height}, bounds 0,0 to ${world.scene.width},${world.scene.height}. Tick ${world.tick}. Narrative: ${world.narrative}`,
    `Acting actor: ${actor ? `${formatSnapshotActor(actor)}, goal=${actor.goal}` : "(unknown)"}`,
    `All actor positions: ${world.actors.length > 0 ? world.actors.map((a) => `${a.name} (${a.id}) at (${a.x}, ${a.y})`).join(" | ") : "(none)"}`,
    `Involved actors (detail): ${detailActors.map((a) => formatSnapshotActor(a)).join(" | ") || "(none)"}`,
  ];
  if (actor) {
    lines.push(`Acting actor memories (latest + digest): ${summarizeListForPrompt(actor.memories, 5).replace(/\n/g, " ")}`);
  }
  lines.push(
    `Nearby objects (within ${r} cells): ${nearbyObjects.map((o) => formatSnapshotObject(o)).join(" | ") || "(none)"}`,
    `Named-target objects (always included): ${targetObjects.map((o) => formatSnapshotObject(o)).join(" | ") || "(none)"}`,
    // F6: the consequence snapshot is built for the acting actor — history
    // is filtered to what they perceived or authored.
    // Exp-7 item A5: the immediately-preceding turn's narrative is the echo
    // attractor (exp-7 B2: tick-0's greeting echoed verbatim at ticks 1-2
    // despite retry feedback) — drop it from the consequence history
    // window and keep the older context.
    `Recent history: ${formatHistoryForPrompt(historyVisibleTo(world, action.actorId).slice(0, -1), 8, undefined, cfg).replace(/\n/g, " ")}`,
    `Memory stats: ${world.actors.length} actors, ${stats.historyEntries} history entries, ${stats.memoryBytes} bytes compounding (prompt stays flat via summaries).`,
  );
  return lines.join("\n");
}

export function buildConsequenceContext(
  world: World,
  action: Action,
  feedback?: string,
  cfg: EngineConfig = defaultConfig,
  // Phase 1: the engine already executed this turn's movement — the facts
  // below tell the render call what happened so it narrates honestly.
  // Undefined = unknown (older callers); null = no movement executed.
  engineMovement?: MovementOutcome | null,
  // Phase 2: the engine already dictated this turn's exact quote — the
  // facts below state the verbatim contract so the render call copies it
  // character-for-character instead of inventing dialogue.
  // Undefined = unknown (older callers); null = no quoted speech.
  exactQuote?: string | null,
): string {
  const actor = getActorById(world, action.actorId);
  const perceivers = getPerceivingActors(world, action, cfg);
  // Exp-6 item 8: demand the object/prop patch up front when the action
  // names a manipulable object — don't just punish its absence later.
  const affordanceNudge = buildObjectAffordanceNudge(world, action);
  const lines = [
    "Objective Snapshot (slim — nearby actors/objects + named targets; far state omitted for budget)",
    "",
    buildSlimObjectiveSnapshot(world, action, cfg),
    "",
    "Current Action",
    "",
    `Actor ID: ${action.actorId}`,
    `Action text: ${action.text}`,
    "",
    `Acting actor position: ${actor ? `${actor.name} (${actor.id}) at (${actor.x}, ${actor.y})` : "(unknown)"}`,
    // Phase 1: engine-owned movement — the render call narrates the
    // already-executed movement; it never emits coordinates.
    ...(engineMovement !== undefined ? executedMovementFacts(world, action.actorId, engineMovement) : []),
    // Phase 2: engine-owned speech — the render call copies the
    // engine-dictated exact quote verbatim; it never invents dialogue.
    ...(exactQuote !== undefined ? exactQuoteFacts(world, action.actorId, exactQuote) : []),
    `All actor positions: ${world.actors.length > 0 ? world.actors.map((a) => `${a.name} (${a.id}) at (${a.x}, ${a.y})`).join(" | ") : "(none)"}`,
    `Landmarks (move targets — resolve "my desk", "coffee machine", "door" to an id below): ${world.scene.objects.length > 0 ? world.scene.objects.map((o) => `${o.name} (${o.id}) at (${o.x}, ${o.y}, ${o.w}x${o.h})`).join(" | ") : "(none)"}`,
    "MOVEMENT IS ENGINE-EXECUTED: the EXECUTED MOVEMENT section above is what already happened this turn — narrate it honestly and never invent coordinates. Do not emit x/y for any actor (any coordinates you emit are ignored).",
    "A single turn covers at most 6 cells of engine movement — a cross-room walk takes several turns, never one teleport.",
    buildObjectIdCatalog(world),
    "EXACT QUOTE RULE: the action's quoted words are engine-owned ground truth (see EXACT QUOTE above) — the narrative MUST contain the exact quote character-for-character. Never paraphrase, alter, truncate, invent, or substitute different dialogue.",
    "PHYSICAL CONTACT RULE: if the action shakes hands, hugs, high-fives, pats, kisses, or hands/passes/gives something to someone, the acting actor MUST end ADJACENT to that person (within 2.5 cells Euclidean). A handshake across the room is invalid — walk over first, then touch.",
    "IDENTITY RULE: " + (actor ? `${buildIdentityAnchor(world, action.actorId)} Act out YOUR role only.` : "Act out the acting actor's role only."),
    "ROSTER RULE: " + buildRosterAnchor(world),
    buildRelationshipRefresh(world, action.actorId),
    "PRONOUN RULE: preserve every actor's pronouns exactly as used in their persona and the world above — never flip he/him to she/her or vice versa. If the scenario says Dana is he/him, every verb and pronoun for Dana stays he/him.",
    "POSE/PROP/OBJECT RULE: when the action observably changes the body or the world, say so in patches — sitting/standing/kneeling sets 'pose'; picking up/holding/carrying a cup/laptop sets 'prop' (null when put down); pouring coffee, opening a laptop, moving a bag, or changing furniture sets 'objectPatches'. Sitting at a desk without a pose patch, or pouring coffee without an object patch, is an incomplete consequence. Handshake/hug/hand-over sets contactActorId and ends adjacent; omitting the verb from the narrative never excuses omitting the patch.",
    // Exp-6 item 8: demand the object/prop patch up front when the action
    // names a manipulable object — don't just punish its absence later.
    ...(affordanceNudge ? [affordanceNudge] : []),
    "",
    `Perceiving actors (MUST each get an actorPatch with a fresh 'thoughts' reaction, even if nothing else changes): ${
      perceivers.length > 0 ? perceivers.map((a) => `${a.name} (${a.id})`).join(" | ") : "(acting actor only)"
    }`,
    "Actors NOT listed here perceived nothing — do NOT patch them.",
    "ADDRESSEE RULE: if the action speaks to, asks, greets, or names one of the perceivers above (e.g. 'ask Tanya for my first task'), that addressee MUST get an actorPatch (thoughts at minimum) — an event that leaves no trace on the person spoken to is invalid.",
    "EFFECTS DECLARATION (required, machine-readable): set effects.moved (own whole-body locomotion only), effects.destinationActorId (exact roster id moved toward, when the action names a person), effects.destinationObjectId (exact landmark id moved toward, when the action names a desk/machine/door), effects.spoke + effects.quotedSpeech (exact uttered segments), effects.addresseeActorId (exact roster id spoken to), effects.contactActorId (exact roster id touched or handed something).",
    "",
    "Physical Constraints",
    "",
    `Scene bounds: 0,0 to ${world.scene.width},${world.scene.height}`,
    "Actors are points.",
    "Objects are axis-aligned rectangles.",
    "Objects with passable=false block movement.",
    "Objects with blocksVision=true block sight.",
    "Objects with blocksSound=true strongly reduce hearing.",
    "Movement is immediate but must be physically reachable.",
    "Do not move actors outside the scene.",
    "Do not move actors into non-passable objects.",
    "MOVEMENT RULE: declare what the action does in \"effects\" (\"moved\" true ONLY for the acting actor's own whole-body locomotion — a position change).",
    "Never emit x/y coordinates for any actor: the engine executes movement (see EXECUTED MOVEMENT above) and any coordinates you emit are ignored.",
    "\"spoke\" is true when the acting actor utters words; \"quotedSpeech\" lists the exact uttered segments (empty when nothing is said).",
    "In-place gestures (turn/look/shake or nod the head, wave/raise a hand, reach for an object, sip/drink) and someone ELSE's motion in a subordinate clause ('as he enters') are NOT locomotion — no x/y change needed. Resuming a task ('return/returning/back to typing/staring/work/task/focus') is NOT locomotion either — only 'return to <place>' counts. Never place an actor INSIDE a desk/table rect; stand NEXT to it.",
  ];
  if (feedback) {
    lines.push("", "Validation Feedback (previous output was invalid)", "", feedback);
  }
  lines.push(
    "",
    "TURN DISCIPLINE (strict — a character only acts on its own turn)",
    "",
    `Acting actor this turn: ${action.actorId}. ONLY this actor may speak, move, change physical state, or perform any observable action.`,
    "All other actors are observers of this event. They MUST NOT speak (no dialogue, no quoted replies, no 'calls back' / 'says' / 'nods welcome'), MUST NOT move (no x/y changes), and MUST NOT change state.",
    "Observers may only react INTERNALLY: set their one-time 'thoughts' field (private immediate inner reaction to this event — never spoken aloud, never narrated; be blunt, candid, profane/explicit when in-character, e.g. surprise, recognition, annoyance), and optionally adjust emotion, goal, memoriesAppend, beliefsAppend, relationshipsAppend.",
    "Set 'thoughts' for EVERY perceiving actor listed above (including the acting actor — its take on what just happened). Thoughts are one-time and will guide that actor's next turn. An event with no observer patch means that observer recorded no reaction.",
    `Narrative rule: describe ONLY what ${action.actorId} observably does, grounded strictly in the given action text.`,
    "If the action is speech, quote its exact words character-for-character (see EXACT QUOTE above) — never paraphrase, never invent different dialogue lines, never truncate a longer speech to a fragment.",
    "Do NOT describe any other actor perceiving, hearing, speaking, moving, glancing, looking up, or reacting — even passively.",
    "You may name another actor only as a stationary spatial landmark for the acting actor's own movement (e.g. 'toward Jeff'), never as someone doing something.",
    "Observer awareness belongs ONLY in their thoughts/memoriesAppend patches, never in the narrative. Each observer's visible response belongs to their own future turn.",
    "",
    "Task",
    "",
    "Interpret the action naturally and determine what happens next.",
    "Patch ONLY affected actors/objects (listed perceivers + observably changed objects) — never re-emit unchanged walls/furniture.",
    "Add memories, beliefs, and relationships when relevant.",
    "Use concise natural-language strings.",
    "Return COMPACT single-line JSON only.",
  );
  return lines.join("\n");
}
