import type { Action, Actor, SceneObject, World } from "../types.js";
import { defaultConfig } from "../config.js";
import { distance } from "./geometry.js";
import {
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
  for (const entry of world.history) bytes += entry.length;
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
  keepNewest = defaultConfig.memorySummaryKeepNewest,
  budgetChars = defaultConfig.promptListBudgetChars,
): string {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const key = e.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }
  if (deduped.length === 0) return "(none)";
  const newest = deduped.slice(-Math.max(1, keepNewest));
  const older = deduped.slice(0, Math.max(0, deduped.length - newest.length));
  const lines = newest.map((m) => `- ${m}`);
  if (older.length > 0) {
    // Digest: first clause of each older entry (the fact, not the wording).
    const clauses = older.map((e) => e.split(/[.!\n]/)[0]?.trim() || e.slice(0, 80));
    let digest = `Earlier (${older.length} entries, summarized): ${clauses.join("; ")}`;
    const digestBudget = Math.max(200, Math.floor(budgetChars / 2));
    if (digest.length > digestBudget) digest = digest.slice(0, digestBudget - 3) + "...";
    lines.unshift(`- ${digest}`);
  }
  let out = lines.join("\n");
  if (out.length > budgetChars) {
    // Hard cap: keep the newest lines (they carry the live arc), note the cut.
    const kept: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (used + line.length + 1 > budgetChars && kept.length > 0) break;
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
 */
export function formatHistoryForPrompt(
  history: string[],
  maxEntries: number,
  budgetChars = defaultConfig.promptHistoryBudgetChars,
): string {
  const tail = history.slice(-Math.max(1, maxEntries));
  if (tail.length === 0) return "(no history yet)";
  const kept: string[] = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i]!;
    if (used + line.length + 1 > budgetChars && kept.length > 0) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  const omitted = tail.length - kept.length;
  const body = kept.join("\n");
  return omitted > 0 ? `(${omitted} older entries omitted for budget)\n${body}` : body;
}

export type SubjectiveContextOptions = {
  /** Recent-history entries to include. Defaults to proposalHistoryLimit (20). */
  historyLimit?: number;
  /** Max suggestions requested. Defaults to maxProposalSuggestions (10). */
  maxSuggestions?: number;
};

function resolveHistoryLimit(opts?: SubjectiveContextOptions): number {
  return opts?.historyLimit ?? defaultConfig.proposalHistoryLimit;
}

function resolveMaxSuggestions(opts?: SubjectiveContextOptions): number {
  return opts?.maxSuggestions ?? defaultConfig.maxProposalSuggestions;
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
export function getOpenQuestions(world: World, actorId: string, limit = MAX_OPEN_QUESTIONS): string[] {
  const actor = getActorById(world, actorId);
  if (!actor) return [];
  const nameLower = actor.name.toLowerCase();
  const idLower = actor.id.toLowerCase();
  const scanWindow = Math.max(
    defaultConfig.openQuestionScanWindow,
    defaultConfig.proposalHistoryLimit,
  );
  const entries = world.history.slice(-scanWindow);
  const authorPrefixes = [`${actor.name}:`, `${actor.id}:`];
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    // Exp-4 item 6: fallback attempts never happened — their questions
    // were never asked and must not become open questions.
    if (entry.includes("(not done)")) continue;
    if (!entry.includes("?")) continue;
    const lower = entry.toLowerCase();
    const mentionsMe = lower.includes(nameLower) || lower.includes(idLower) || /\byou\b/.test(lower);
    const mine = lower.startsWith(`${nameLower}:`) || lower.startsWith(`${idLower}:`);
    if (!mentionsMe || mine) continue;
    // Answered once the addressee authored any later entry (their response
    // turn) — until then the question stays open no matter how many other
    // turns intervene.
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
  [/\b(looks?|looked|looking|glances?|glanced|watch|watches|nods?|nodded|smiles?|smiled)\b/i, "gesture"],
];

/** Object-kind nouns for the attractor core (desk/coffee/task/…). */
const CORE_NOUNS: Array<[RegExp, string]> = [
  [/\bdesk\b/i, "desk"],
  [/\bcoffee\b/i, "coffee"],
  [/\blaptop\b/i, "laptop"],
  [/\bmug\b|\bcup\b/i, "mug"],
  [/\btask\b|\bcode\b|\bbackend\b/i, "task"],
  [/\bquestion\b|\bhelp\b|\bdirections?\b/i, "question"],
  [/\bemail\b|\bpapers?\b|\bnotes?\b/i, "papers"],
  [/\bbreak\b|\blunch\b|\btea\b/i, "break"],
  [/\bmeeting\b/i, "meeting"],
  [/\bhand\b|\bhands\b/i, "hand"],
];

/**
 * Exp-4 item 10: verb+noun core of an action from one actor's perspective
 * ("Anton shakes hands with Tanya" on Tanya's turn → "shake|anton"). The
 * repetition guard lists prior actions but the model re-emits them anyway
 * (6 handshakes, 6 greetings) — comparing cores proposal-side beats
 * another prompt line. The deciding actor (`selfId`) is skipped when
 * scanning mentions so both "Shake Anton's hand" and the observer-subject
 * variant "Anton shakes hands with Tanya" core to the other participant;
 * when nobody else is named, the self mention (or object kind) is kept.
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
  const mentioned = (a: { id: string; name: string }): boolean => {
    const first = a.name.split(/[^a-z0-9]+/i)[0]?.toLowerCase() ?? "";
    return (
      (a.id.length >= 2 && lower.includes(a.id.toLowerCase())) ||
      (a.name.length >= 2 && lower.includes(a.name.toLowerCase())) ||
      (first.length >= 3 && new RegExp(`\\b${first}\\b`).test(lower))
    );
  };
  let noun = "";
  for (const a of world.actors) {
    if (selfId !== undefined && a.id === selfId) continue;
    if (mentioned(a)) {
      noun = a.id;
      break;
    }
  }
  if (noun === "" && selfId !== undefined) {
    const self = world.actors.find((a) => a.id === selfId);
    if (self && mentioned(self)) noun = self.id;
  }
  if (noun === "") {
    for (const [re, stem] of CORE_NOUNS) {
      if (re.test(text)) {
        noun = stem;
        break;
      }
    }
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
  // Exp-4 item 6: fallback attempts ("tried … (not done)") never happened —
  // neither a repeat to avoid nor a question answered. The "tried:" prefix
  // already misses the ":" author match below; the explicit filter keeps
  // this true even if the format ever changes.
  const mine = world.history.filter(
    (h) => !h.includes("(not done)") && (h.startsWith(prefixName) || h.startsWith(prefixId)),
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
  return `IDENTITY: You are ${actor.name} (${actor.id}). Role: ${actor.persona} Current goal: ${actor.goal}.${notLine} Your next action must fit YOUR role and goal above.`;
}

/** Pronouns for the roster anchor: explicit tag when present, else inferred. */
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
    (a) => `${a.name} (${a.id}, ${extractPronouns(a.persona)}) at (${a.x}, ${a.y})`,
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
  const historyLimit = resolveHistoryLimit(opts);
  const maxSuggestions = resolveMaxSuggestions(opts);
  const recentHistory = formatHistoryForPrompt(world.history, historyLimit);
  const openQuestions = getOpenQuestions(world, actorId);
  const questionsLine =
    openQuestions.length > 0
      ? `Open questions addressed to you (answer these before starting anything new):\n${openQuestions.map((q) => `- ${q}`).join("\n")}`
      : "Open questions addressed to you: (none)";
  const recentOwn = getRecentOwnActions(world, actorId);
  const repetitionLine =
    recentOwn.length > 0
      ? `Your recent actions (do NOT repeat yourself):\n${recentOwn.map((a) => `- ${a}`).join("\n")}\nDo not propose an action you already took above unless the situation clearly changed.`
      : "Your recent actions: (none yet)";
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
  const historyLimit = resolveHistoryLimit(opts);
  const recentHistory = formatHistoryForPrompt(world.history, historyLimit);

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
  const openQuestions = getOpenQuestions(world, actorId);
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
export function getPerceivingActors(world: World, action: Action): Actor[] {
  const actor = getActorById(world, action.actorId);
  if (!actor) return [];
  return world.actors.filter((o) => {
    if (o.id === action.actorId) return true;
    const from = { x: o.x, y: o.y };
    const to = { x: actor.x, y: actor.y };
    return (
      getVisibleActors(world, o.id).some((a) => a.id === action.actorId) ||
      getAudibleActors(world, o.id).some((a) => a.id === action.actorId) ||
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
  radius = defaultConfig.consequenceSnapshotRadius,
): string {
  const actor = getActorById(world, action.actorId);
  const at = actor ? { x: actor.x, y: actor.y } : { x: 0, y: 0 };
  const destActorId = actor ? resolveDestinationActorId(world, action.actorId, action.text) : undefined;
  const mentionedActorId = actor ? resolveMentionedActorId(world, action.actorId, action.text) : undefined;
  const destObjectId = resolveDestinationObjectId(world, action.text, action.actorId);
  const textLower = action.text.toLowerCase();

  const detailIds = new Set<string>();
  if (actor) detailIds.add(actor.id);
  for (const p of getPerceivingActors(world, action)) detailIds.add(p.id);
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
    return distance(at, center) <= radius;
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
    `Nearby objects (within ${radius} cells): ${nearbyObjects.map((o) => formatSnapshotObject(o)).join(" | ") || "(none)"}`,
    `Named-target objects (always included): ${targetObjects.map((o) => formatSnapshotObject(o)).join(" | ") || "(none)"}`,
    `Recent history: ${formatHistoryForPrompt(world.history, 8).replace(/\n/g, " ")}`,
    `Memory stats: ${world.actors.length} actors, ${stats.historyEntries} history entries, ${stats.memoryBytes} bytes compounding (prompt stays flat via summaries).`,
  );
  return lines.join("\n");
}

export function buildConsequenceContext(
  world: World,
  action: Action,
  feedback?: string,
): string {
  const actor = getActorById(world, action.actorId);
  const perceivers = getPerceivingActors(world, action);
  const lines = [
    "Objective Snapshot (slim — nearby actors/objects + named targets; far state omitted for budget)",
    "",
    buildSlimObjectiveSnapshot(world, action),
    "",
    "Current Action",
    "",
    `Actor ID: ${action.actorId}`,
    `Action text: ${action.text}`,
    "",
    `Acting actor position: ${actor ? `${actor.name} (${actor.id}) at (${actor.x}, ${actor.y})` : "(unknown)"}`,
    `All actor positions: ${world.actors.length > 0 ? world.actors.map((a) => `${a.name} (${a.id}) at (${a.x}, ${a.y})`).join(" | ") : "(none)"}`,
    `Landmarks (move targets — resolve "my desk", "coffee machine", "door" to an id below): ${world.scene.objects.length > 0 ? world.scene.objects.map((o) => `${o.name} (${o.id}) at (${o.x}, ${o.y}, ${o.w}x${o.h})`).join(" | ") : "(none)"}`,
    "If the action says to move toward/close to/next to/beside someone, the new x,y MUST be strictly closer to that actor than the current position (Euclidean distance). Example: an actor at (1,10) moving toward someone at (8,8) could go to (5,8) — never inside a desk rect, stand NEXT to it.",
    "Same rule for NAMED LANDMARKS: if the action names a desk, the coffee machine, the door, or any object above ('my desk', 'west-side desk', 'NW-corner coffee machine'), the new x,y MUST be strictly closer to that object's rectangle than the current position. Never teleport across the room to an unrelated area; never move AWAY from the named target.",
    "A single turn covers at most 6 cells — a cross-room walk takes several turns of real progress each time, never one teleport and never a token shuffle toward a distant target.",
    buildObjectIdCatalog(world),
    "QUOTED-SPEECH COPY RULE: if the action text contains \"...\" segments, copy each one character-for-character into effects.quotedSpeech AND into the narrative. Never invent quotes, never add greetings, never substitute different dialogue.",
    "PHYSICAL CONTACT RULE: if the action shakes hands, hugs, high-fives, pats, kisses, or hands/passes/gives something to someone, the acting actor MUST end ADJACENT to that person (within 2.5 cells Euclidean). A handshake across the room is invalid — walk over first, then touch.",
    "IDENTITY RULE: " + (actor ? `${buildIdentityAnchor(world, action.actorId)} Act out YOUR role only.` : "Act out the acting actor's role only."),
    "ROSTER RULE: " + buildRosterAnchor(world),
    buildRelationshipRefresh(world, action.actorId),
    "PRONOUN RULE: preserve every actor's pronouns exactly as used in their persona and the world above — never flip he/him to she/her or vice versa. If the scenario says Dana is he/him, every verb and pronoun for Dana stays he/him.",
    "POSE/PROP/OBJECT RULE: when the action observably changes the body or the world, say so in patches — sitting/standing/kneeling sets 'pose'; picking up/holding/carrying a cup/laptop sets 'prop' (null when put down); pouring coffee, opening a laptop, moving a bag, or changing furniture sets 'objectPatches'. Sitting at a desk without a pose patch, or pouring coffee without an object patch, is an incomplete consequence. Handshake/hug/hand-over sets contactActorId and ends adjacent; omitting the verb from the narrative never excuses omitting the patch.",
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
    "Emit x and y for the acting actor IFF \"moved\" is true, with a NEW position reflecting that movement; if it names another actor, the new position MUST be strictly closer to that actor and \"destinationActorId\" MUST carry that actor's exact id.",
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
    "If the action is speech, preserve its wording — quote or closely paraphrase it, never invent different dialogue lines. If the action contains quoted words, the narrative MUST contain those same words.",
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
