// Concise story debug trace (text UI `debug on` / `story` command).
//
// Goal: one readable block per turn that shows the logical chain in
// chronological order:
//   proposal (in/out + why) -> selection (options, decision + why) ->
//   action (result of proposal/selection, or free user text) ->
//   consequence (why + exact changes + patched vs unpatched) ->
//   validation -> history.
// User turns skip proposal/selection (logged as skipped).
//
// Deliberately excludes full prompts, raw LLM responses, and full world
// dumps — only short reason strings, truncated suggestions, and patch
// summaries. Everything here is derived from LogEntry data.

import type { LogEntry } from "./logTypes.js";
import { paintActor, paintError } from "./colors.js";
import type {
  Action,
  ActorPatch,
  ConsequenceResult,
  ObjectPatch,
  ProposalResult,
  SelectionResult,
} from "../types.js";

export type StoryActorRef = { id: string; name: string };

export type StoryOptions = {
  /** Id of the user-controlled actor (to label "(user)" vs "(NPC)"). */
  userActorId?: string;
  /** Max chars per free-form string (default 140). */
  maxChars?: number;
  /** Max suggestions to list (default 6). */
  maxSuggestions?: number;
  /** Wrap actor blocks in that actor's ANSI color and errors in red. */
  color?: boolean;
};

function flat(s: unknown, max: number): string {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
  const oneLine = str.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function findEntry(entries: LogEntry[], module: string, event: string): LogEntry | undefined {
  return entries.find((e) => e.module === module && e.event === event);
}

function findAll(entries: LogEntry[], module: string, event: string): LogEntry[] {
  return entries.filter((e) => e.module === module && e.event === event);
}

function actorLabel(id: string, actors: StoryActorRef[], userActorId?: string): string {
  const name = actors.find((a) => a.id === id)?.name ?? id;
  const tag = userActorId !== undefined && id === userActorId ? " (user)" : " (NPC)";
  return `${name} [${id}]${tag}`;
}

function shortName(id: string, actors: StoryActorRef[]): string {
  return actors.find((a) => a.id === id)?.name ?? id;
}

function summarizeActorPatch(patch: ActorPatch, max: number): string {
  const bits: string[] = [];
  if (patch.x !== undefined && patch.y !== undefined) bits.push(`move to (${patch.x}, ${patch.y})`);
  if (patch.state !== undefined) bits.push(`state=${flat(patch.state, 60)}`);
  if (patch.emotion !== undefined) bits.push(`emotion=${flat(patch.emotion, 60)}`);
  if (patch.goal !== undefined) bits.push(`goal=${flat(patch.goal, 80)}`);
  if (patch.thoughts !== undefined) bits.push(`thoughts=${flat(patch.thoughts, max)}`);
  const list = (label: string, arr?: string[]) => {
    if (arr && arr.length > 0) {
      bits.push(`+${arr.length} ${label}: ${flat(arr[0], max)}${arr.length > 1 ? ` (+${arr.length - 1} more)` : ""}`);
    }
  };
  list("memory", patch.memoriesAppend);
  list("belief", patch.beliefsAppend);
  list("relation", patch.relationshipsAppend);
  return bits.length > 0 ? bits.join("; ") : "(touched, no field changes)";
}

function summarizeObjectPatch(patch: ObjectPatch, max: number): string {
  const bits: string[] = [];
  if (patch.description !== undefined) bits.push(`desc=${flat(patch.description, max)}`);
  if (patch.x !== undefined || patch.y !== undefined) bits.push(`move to (${patch.x ?? "?"}, ${patch.y ?? "?"})`);
  if (patch.passable !== undefined) bits.push(`passable=${patch.passable}`);
  if (patch.blocksVision !== undefined) bits.push(`blocksVision=${patch.blocksVision}`);
  if (patch.blocksSound !== undefined) bits.push(`blocksSound=${patch.blocksSound}`);
  return bits.length > 0 ? bits.join("; ") : "(touched)";
}

/**
 * Render a concise story block for a single tick.
 * `tickEntries` should already be filtered to one tick; `actors` lists
 * all world actors (for affected/unaffected classification).
 */
export function renderTurnStory(
  tickEntries: LogEntry[],
  tick: number,
  actors: StoryActorRef[] = [],
  opts: StoryOptions = {},
): string {
  const max = opts.maxChars ?? 140;
  const maxSug = opts.maxSuggestions ?? 6;
  const useColor = opts.color ?? false;
  const lines: string[] = [];

  if (tickEntries.length === 0) {
    const empty = `-- tick ${tick}: (no log entries) --`;
    return useColor ? paintError(empty) : empty;
  }

  const turnStarted = findEntry(tickEntries, "turn", "turn_started");
  const actionChosen = findEntry(tickEntries, "turn", "action_chosen");
  const userSubmitted = findEntry(tickEntries, "turn", "useractionsubmitted");
  const actorId =
    actionChosen?.actorId ?? userSubmitted?.actorId ?? turnStarted?.actorId ?? tickEntries[0]?.actorId ?? "?";
  const actorIdForColor = actorId;
  const isUser = userSubmitted !== undefined || (opts.userActorId !== undefined && actorId === opts.userActorId);
  // Roster-aware colors guarantee every character gets its own color (up
  // to the palette size): the color is assigned by sorted roster position
  // instead of a bare hash, so anton/dana-style hash collisions can't
  // happen. Every non-error line carries this turn's actor color so
  // consecutive turns are visually distinct; errors/fallbacks are always
  // red.
  const rosterIds = actors.map((a) => a.id);
  const ok = (s: string): string => (useColor ? paintActor(s, actorIdForColor, rosterIds) : s);
  const errPaint = (s: string): string => (useColor ? paintError(s) : s);
  // Paint a line in a *specific* actor's own color (for per-character
  // mentions inside another actor's turn: changes + affected lists).
  const asActor = (s: string, id: string): string => (useColor ? paintActor(s, id, rosterIds) : s);

  lines.push(ok(`-- tick ${tick} | ${actorLabel(actorId, actors, opts.userActorId)} --`));

  // Chronological order: proposal -> selection -> action -> consequence ->
  // validation -> history. (The action is the *result* of proposal/selection,
  // so showing it first confused readers into thinking it preceded them.)

  // 1. Proposal: what it received (actor) and returned (suggestions + why).
  // User turns skip proposal entirely (no suggestions generated).
  const proposalDone = findEntry(tickEntries, "proposal", "proposal_completed");
  const proposalFail = findEntry(tickEntries, "proposal", "proposal_failed");
  const proposalSkipped = findEntry(tickEntries, "proposal", "proposal_skipped");
  if (proposalDone) {
    const out = (asRecord(proposalDone.output) ?? asRecord(proposalDone.parsedResponse)) as unknown as
      | ProposalResult
      | undefined;
    const suggestions = Array.isArray(out?.suggestions) ? out.suggestions : [];
    lines.push(ok(`proposal: in actor=${actorId} | out ${suggestions.length} suggestion(s)`));
    for (const [i, s] of suggestions.slice(0, maxSug).entries()) {
      lines.push(ok(`  [${i + 1}] ${flat(s, max)}`));
    }
    if (suggestions.length > maxSug) lines.push(ok(`  … (+${suggestions.length - maxSug} more)`));
    const why = typeof proposalDone.reasoning === "string" ? proposalDone.reasoning : out?.reasoning;
    lines.push(ok(`  why: ${why ? flat(why, 200) : "(no reasoning)"}`));
  } else if (proposalSkipped || isUser) {
    lines.push(ok(`proposal: skipped (user turn — no suggestions generated; user acts freely)`));
  } else if (proposalFail) {
    lines.push(errPaint(`proposal: FAILED -> fallback suggestions used`));
    if (proposalFail.error) lines.push(errPaint(`  error: ${flat(proposalFail.error, 200)}`));
  } else {
    lines.push(ok(`proposal: (no proposal entry)`));
  }

  // 2. Selection: options it had, decision, why. Skipped on user turns.
  const selectionDone = findEntry(tickEntries, "selection", "selection_completed");
  const selectionFail = findEntry(tickEntries, "selection", "selection_failed");
  const selectionStarted = findEntry(tickEntries, "selection", "selection_started");
  const startedInput = asRecord(selectionStarted?.input);
  const startedSuggestions = Array.isArray(startedInput?.["suggestions"])
    ? (startedInput?.["suggestions"] as unknown[])
    : undefined;
  // Resolve the final action text early so FAILED branches can name it.
  const action = asRecord(actionChosen?.output) as unknown as Action | undefined;
  const actionText = typeof action?.text === "string" ? action.text : undefined;
  const submittedAction = asRecord(userSubmitted?.output) as unknown as Action | undefined;
  const submittedText = typeof submittedAction?.text === "string" ? submittedAction.text : undefined;
  const finalActionText = actionText ?? submittedText;
  if (isUser) {
    lines.push(ok(`selection: skipped (user turn; Decision AI not run)`));
  } else if (selectionDone) {
    const out = (asRecord(selectionDone.output) ?? asRecord(selectionDone.parsedResponse)) as unknown as
      | SelectionResult
      | undefined;
    const n = startedSuggestions?.length ?? " ?";
    lines.push(ok(`selection: in${typeof n === "number" ? ` ${n} option(s)` : ""} | out "${flat(out?.action ?? "", 200)}"`));
    if (startedSuggestions && startedSuggestions.length > 0 && typeof out?.action === "string") {
      const idx = startedSuggestions.findIndex((s) => s === out.action);
      lines.push(ok(idx >= 0 ? `  picked: option [${idx + 1}] (verbatim)` : `  picked: new wording (not verbatim from options)`));
    }
    const why = typeof selectionDone.reasoning === "string" ? selectionDone.reasoning : out?.reasoning;
    lines.push(ok(`  why (Decision AI): ${why ? flat(why, 200) : "(no reasoning)"}`));
  } else if (selectionFail) {
    lines.push(errPaint(`selection: FAILED -> fallback action used`));
    if (selectionFail.error) lines.push(errPaint(`  error: ${flat(selectionFail.error, 200)}`));
    if (finalActionText) lines.push(errPaint(`  fallback action: "${flat(finalActionText, 200)}" (NOT from proposals above)`));
  } else {
    lines.push(ok(`selection: (no selection entry)`));
  }

  // 3. Action (result of proposal/selection, or free user text).
  if (actionText) {
    lines.push(ok(`action: "${flat(actionText, 200)}"${isUser ? "  [user typed]" : "  [NPC decided]"}`));
  } else if (isUser && userSubmitted && submittedText) {
    lines.push(ok(`action: "${flat(submittedText, 200)}"  [user typed]`));
  }

  // 4. Consequence: why + exact changes + affected/unaffected.
  const consequenceDone = findEntry(tickEntries, "consequence", "consequence_completed");
  const consequenceFails = findAll(tickEntries, "consequence", "consequence_failed");
  if (consequenceDone) {
    const out = (asRecord(consequenceDone.output) ?? asRecord(consequenceDone.parsedResponse)) as unknown as
      | ConsequenceResult
      | undefined;
    lines.push(ok(`consequence: narrative "${flat(out?.narrative ?? "", 200)}"`));
    const why = typeof consequenceDone.reasoning === "string" ? consequenceDone.reasoning : out?.reasoning;
    lines.push(ok(`  why: ${why ? flat(why, 200) : "(no reasoning)"}`));
    const actorPatches = Array.isArray(out?.actorPatches) ? out.actorPatches : [];
    const objectPatches = Array.isArray(out?.objectPatches) ? out.objectPatches : [];
    if (actorPatches.length > 0) {
      lines.push(ok(`  changes:`));
      for (const p of actorPatches as ActorPatch[]) {
        // Each change line carries the *patched* actor's own color so
        // every character is visually distinct even inside one turn.
        lines.push(asActor(`    - ${shortName(p.actorId, actors)}: ${summarizeActorPatch(p, max)}`, p.actorId));
      }
    } else {
      lines.push(ok(`  changes: (none — no actor patches)`));
    }
    if (objectPatches.length > 0) {
      lines.push(ok(`  objects changed:`));
      for (const p of objectPatches as ObjectPatch[]) {
        lines.push(ok(`    - ${p.objectId}: ${summarizeObjectPatch(p, max)}`));
      }
    } else {
      lines.push(ok(`  objects changed: (none)`));
    }
    // Affected = patched actors (the only ones with a recorded reaction).
    // "Not affected" means no patch this turn — the model recorded no
    // internal reaction for them (it may have omitted an observer patch
    // even when its reasoning says they heard the event).
    const patchedIds = new Set((actorPatches as ActorPatch[]).map((p) => p.actorId));
    if (actors.length > 0) {
      const affected = actors.filter((a) => patchedIds.has(a.id));
      const unaffected = actors.filter((a) => !patchedIds.has(a.id));
      lines.push(ok(`  affected by event (patched):`));
      if (affected.length > 0) {
        for (const a of affected) lines.push(asActor(`    - ${a.name}`, a.id));
      } else {
        lines.push(ok(`    (none)`));
      }
      lines.push(ok(`  not affected (no patch — no recorded reaction):`));
      if (unaffected.length > 0) {
        for (const a of unaffected) lines.push(asActor(`    - ${a.name}`, a.id));
      } else {
        lines.push(ok(`    (none)`));
      }
    } else if (patchedIds.size > 0) {
      lines.push(ok(`  affected by event (patched):`));
      for (const id of patchedIds) lines.push(ok(`    - ${id}`));
    }
  } else if (consequenceFails.length > 0) {
    // completeJson logs one entry per parse attempt plus a final
    // "fallback: ..." summary from the engine — count only real attempts
    // so the number matches the retry budget (maxRetries + 1).
    const attempts = consequenceFails.filter((e) => !(typeof e.error === "string" && e.error.startsWith("fallback:")));
    const shown = attempts.length > 0 ? attempts : consequenceFails;
    lines.push(errPaint(`consequence: FAILED (${shown.length} attempt(s)) -> fallback "Nothing changes."`));
    const last = shown.at(-1);
    if (last?.error) lines.push(errPaint(`  error: ${flat(last.error, 200)}`));
  } else {
    lines.push(ok(`consequence: (no consequence entry)`));
  }

  // 5. Validation + retries + fallback.
  const validationFails = findAll(tickEntries, "validator", "validation_failed");
  const validationPass = findEntry(tickEntries, "validator", "validation_passed");
  const retries = findAll(tickEntries, "turn", "retry_started");
  const fallback = findEntry(tickEntries, "turn", "fallback_used");
  if (validationFails.length === 0 && validationPass) {
    lines.push(ok(`validation: passed (attempt 1)`));
  } else if (validationFails.length > 0) {
    for (const [i, v] of validationFails.entries()) {
      const errs = Array.isArray(v.validationErrors) ? v.validationErrors : [];
      lines.push(
        errPaint(
          `validation: FAILED attempt ${i + 1}: ${errs.length > 0 ? errs.map((e) => flat(e, 120)).join("; ") : "(no details)"}`,
        ),
      );
    }
    if (validationPass) lines.push(ok(`validation: passed after ${validationFails.length + 1} attempt(s)`));
    else if (!fallback) lines.push(errPaint(`validation: failed, no pass recorded`));
  }
  if (retries.length > 0) lines.push(ok(`retries: ${retries.length} (feedback sent back to consequence engine)`));
  if (fallback) {
    lines.push(errPaint(`turn: FALLBACK used ("Nothing changes." — max retries exceeded)`));
    if (fallback.error) lines.push(errPaint(`  reason: ${flat(fallback.error, max)}`));
  }

  // 6. Resulting history entry.
  const patchApplied = findEntry(tickEntries, "turn", "patch_applied");
  const historyTail = asRecord(patchApplied?.output) as { historyTail?: unknown } | undefined;
  const tailArr = Array.isArray(historyTail?.historyTail) ? historyTail!.historyTail : undefined;
  if (tailArr && tailArr.length > 0) {
    lines.push(ok(`history: "${flat(tailArr[tailArr.length - 1], 200)}"`));
  } else if (actionText) {
    lines.push(ok(`history: (entry appended for ${shortName(actorId, actors)})`));
  }

  return lines.join("\n");
}

/** Ticks present in the log, ascending. */
export function loggedTicks(entries: LogEntry[]): number[] {
  return [...new Set(entries.map((e) => e.tick))].sort((a, b) => a - b);
}

/**
 * Render story blocks for several ticks (ascending), separated by a blank
 * line. Unknown ticks render a "(no log entries)" placeholder.
 */
export function renderStoryRange(
  allEntries: LogEntry[],
  ticks: number[],
  actors: StoryActorRef[] = [],
  opts: StoryOptions = {},
): string {
  return ticks
    .map((t) => renderTurnStory(allEntries.filter((e) => e.tick === t), t, actors, opts))
    .join("\n\n");
}
