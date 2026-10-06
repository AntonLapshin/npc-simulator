# Simulation Flow Verification + Action Items

Date: 2026-10-06. Verified against code in `src/` (turnOrchestrator, contextBuilder, perceptionHelpers, prompts, physicalValidator, patchApplier).

## 1) Turn flow — mostly confirmed, one divergence

**Your model:**
a) User turn → Consequence Engine mutates world/character state.
b) NPC turn → Proposal (perceivable input only) → Selection (Decision AI Laya) → Consequence mutates world.

**Verdict: CONFIRMED with one correction.**

Actual code (`src/engine/turnOrchestrator.ts:320-435`):

1. `getCurrentActor(world)` → tick/turnIndex determine actor.
2. **User turn: NO proposal, NO selection.** `proposal_skipped` is logged, `getUserAction(actor.id, [])` is called with empty suggestions (`turnOrchestrator.ts:338-377`). User acts freely.
   - Divergence from `plan.md §9.9` (which says user turns do `propose → display suggestions → wait for input`). Plan is stale; code skips both LLM calls for the user.
3. **NPC turn: Proposal → Selection** (`turnOrchestrator.ts:379-384`), then `stripSelectionPrefix`, then shared path:
   `resolveWithValidation → applyConsequence → incrementTick → advanceTurn → autosave`.
4. **Consequence input = full objective world.** `buildConsequenceContext` (`src/engine/contextBuilder.ts:95-174`) embeds `JSON.stringify(world)` + action text + perceiver list. Output = `narrative + actorPatches + objectPatches + effects + reasoning`, applied by `patchApplier.ts` (x/y, state, emotion, goal, thoughts, pose, prop, memories/beliefs/relationships appends, object rect/flags/description, history trim).
5. **Proposal/Selection input = subjective only.** `buildProposalContext` (`contextBuilder.ts:16-65`) includes only own persona/state/emotion/goal/thoughts/memories/beliefs/relationships + `getVisibleActors`/`getVisibleObjects` + narrative + last-6 history + tick. No other actor's private fields. Consequence is the only module that sees everything.

**Duplication question — yes, real duplication today:**
`buildSelectionContext = buildProposalContext + numbered candidate list` (`contextBuilder.ts:67-91`). Both receive the *identical* full personal context (persona, emotion, thoughts, memories, beliefs, relationships). The only delta is `suggestions[]`.

Why it exists (not pointless, but costly):
- Proposal = divergent breadth (generate options); Selection = convergent choice (commit to one). Two-call pattern reduces single-call self-bias and lets Selection be routed to a different model — the Laya Decision AI (`src/llm/llmSelectionEngine.ts:1-8`, `src/llm/provider.ts:290-295`: "creative work on JoinGonka, fast local decisions on Laya").
- Selection may ignore candidates and invent a better-fitting action, so Proposal is advisory, not binding.
- Cost: 2× LLM calls per NPC turn with near-identical prompts; both persona-weighted, so Proposal already pre-filters by personality and Selection re-filters — narrowing diversity for double cost.

## 2) Do NPCs see objects? — YES, visible ones only

**Verdict: CONFIRMED.**

- `MockProposalEngine` and `LLMProposalEngine` both call `buildProposalContext`, which calls `getVisibleObjects(world, actorId)` (`contextBuilder.ts:20`, `perceptionHelpers.ts:61-73`).
- Prompt line: `Visible objects: <name (id) at (x,y): description> | ...` (`contextBuilder.ts:50`). Example: coffee machine description → model can propose "take a coffee break"; sofa → "sit on the sofa". Mock fallback even does `Interact with <objects[0].name>` (`src/mocks/mockProposalEngine.ts:51-53`).
- **Filter = perception, not omniscience:** `canSeePoint` = distance ≤ `defaultPerceptionRadius` (12, `src/config.ts:6`) AND segment not blocked by any `blocksVision=true` object (`perceptionHelpers.ts:17-26`). Center-point test per object. Beyond radius / behind wall = excluded. No audio path for objects (sensible — objects don't speak).
- **Gaps found:**
  - Visible-actor line exposes only `name (id) at (x,y): state` (`contextBuilder.ts:49`) — **no pose, prop, emotion**. An NPC can't reliably propose "join the seated person" vs "approach the standing one" or react to a held cup/laptop except via free-text `state`.
  - Object line exposes description but not explicit `passable` flags; model must infer sit-ability/blocking from prose + the generic "non-passable objects block movement" hint.

## 3) Split Proposal (impersonal affordances) vs Selection (personal choice) — sensible, with risks

**Your proposal:** Proposal generates up to ~10 possible actions from physical world state *without* character state; Selection personalizes via persona/thoughts/mood.

**Verdict: MAKES SENSE as an optimization, but do NOT strip all character state — use a tiered split.**

Current input to **both** Proposal and Selection (identical base):
`ID, Name, Persona, State, Emotion, Goal, Thoughts, Memories[], Beliefs[], Relationships[], Position (x,y), Visible actors (name/id/pos/state), Visible objects (name/id/pos/description), Narrative, Recent history (last 6), Tick, Physical-constraints hint` + (Selection only) `Candidate Actions (numbered)`.

Proposed split:

| Input | Proposal (affordance brainstorm, ~10 items) | Selection (Laya personal decision) |
|---|---|---|
| Position, Visible actors, Visible objects, Narrative, Recent history, Tick, Physical constraints | KEEP | KEEP (rebuilds grounding; cheap) |
| State, Goal (current activity/intent) | KEEP (minimal anchor — otherwise proposes physically impossible acts) | KEEP |
| Persona, Emotion, Thoughts, Memories, Beliefs, Relationships | DROP or compress to 1-line summary | KEEP full |
| Candidate list | — (produces it) | KEEP |

**Benefits:** cheaper Proposal (smaller prompt, can use smaller/faster model or rules), wider/diverse options, clearer mental model, Selection (Laya) becomes the single personality gate.
**Risks / issues:**
1. **Irrelevant proposals** (e.g. "sprint across room" when `state=injured`, "chat loudly" when goal demands silence). Mitigation: keep `state+goal` in Proposal; Selection already may invent a new action when all candidates are bad (currently allowed — keep that escape hatch).
2. **Wasted tokens** if Selection routinely discards all 10. Track discard rate in logs before committing.
3. **Validity drop**: persona currently helps Proposal stay in-character and physically plausible; stripping it needs the movement/turn-discipline hints to stay in the Proposal prompt.
4. **Two prompts to maintain** + golden-test churn (proposal/completed log snapshots change).
5. Recommended path: A/B behind a flag (`proposalMode: full | affordance`), compare suggestion diversity, selection-discard rate, validation retry rate.

## 4) Private thoughts should be candid/explicit — AGREE, not yet implemented

**Verdict: CONFIRMED as a gap. Lower the bar.**

Today:
- System prompt (`src/llm/prompts.ts:9-23`) bans refusal/filtering for "actions, speech, emotions, relationships, conflicts, outcomes" — **`thoughts` is not named**, and the consequence examples are sanitized ("Hope they like me.", "surprise, recognition, annoyance" in `contextBuilder.ts:157`).
- `thoughts` mechanics are otherwise correct: one-time inner reaction per perceiving actor (`types.ts:48-51`, `patchApplier.ts:33`), fed back into next Proposal/Selection (`contextBuilder.ts:32`), never in narrative/history (`patchApplier.ts:58-64` pushes only `Name: action.text`; TURN DISCIPLINE forbids other actors in narrative).
- **Leak to fix:** text UI `look actor <id>` / `thoughts [actor]` (`src/ui/text/textUi.ts:491-495`, `commands.ts:180,233`) exposes *any* actor's thoughts to the user. Decide: GM-debug only (gate behind `debug on`) vs. always-visible. Currently always visible.

## Action items (confirmed with the owner)

- [ ] **P0 — Fix stale plan:** update `plan.md §9.9` turn flow to match code (user turns skip proposal/selection; `proposal_skipped` + `getUserAction(id, [])`). File: `plan.md`, ref `src/engine/turnOrchestrator.ts:338-377`.
- [ ] **P0 — Explicit thoughts policy:** add `thoughts` to the uncensored list in `LLM_SYSTEM_PROMPT` + add "Thoughts are private, never spoken aloud, never narrated; be blunt, candid, profane/explicit when in-character" to `consequenceSuffix()` and the `Thoughts (...)` line in `buildProposalContext`. Files: `src/llm/prompts.ts`, `src/engine/contextBuilder.ts:32,157`.
- [ ] **P1 — Thoughts are visible if using** `look actor <other>` thoughts + `thoughts [other]` even not in debug mode. Files: `src/ui/text/textUi.ts`, `src/ui/text/commands.ts`. Thoughts should be included to the proposal engine and selection engine with high priority, but only for this specific character, thoughts are private and never included in other npc turn.
- [ ] **P1 — Proposal/Selection split:** Proposal prompt = position + thoughts (high priority) + state + goal + perceivables + narrative/history (up to N, let's say 20 for now), beliefs and memories + constraints (drop persona/emotion/relationships); Selection unchanged full context. Files: `src/engine/contextBuilder.ts`, `src/llm/llmProposalEngine.ts`, `src/config.ts`, golden tests.
- [ ] **P1 — Enrich perceivables:** include `pose/prop/emotion` in the visible-actor line (or a compact `pose=X, prop=Y` suffix) so proposals can use sitting/holding cues; consider appending `passable` for objects. File: `src/engine/contextBuilder.ts:49-50`.
- [ ] **P2 — Deduplicate Selection prompt option:** since Selection rebuilds the full Proposal context, log prompt token sizes for both calls for one session to quantify the 2× cost; use data to justify the split. Files: `src/llm/llmProposalEngine.ts:85-97`, `src/llm/llmSelectionEngine.ts:89-101`.
- [ ] **P2 — Cap proposal count:** specify max suggestions (e.g. 10) in the Proposal task text; currently unbounded. File: `src/engine/contextBuilder.ts:57-64`.
