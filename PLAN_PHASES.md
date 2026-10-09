# Renderer Architecture: Phase Plan

Companion to `PLAN.md` (the why). This is the how: six phases, each sized
to fit **one implementation run and one PR**. Each phase is independently
mergeable, independently testable with mock engines, and leaves the
simulator working — no phase breaks the previous one.

**Prerequisite:** PR #6 (`exp7-fixes`) merged.

**The rule every phase obeys:** move exactly one responsibility from the
model to the engine. The model's output for that responsibility becomes
advisory, then ignored, then removed from the schema. Never two
responsibilities per phase — that's how we got 11 rounds of tangled
fixes.

**Running scoreboard** (updated per phase):

| Phase | Model calls/turn (typical) | What dies |
|---|---|---|
| now (PR #6) | ~4–6 (proposal + selection + 1–2 consequence + retries) | — |
| 1. Engine-owned movement ✅ | ~3–5 | B3, B6, movement retries |
| 2. Engine-owned speech | ~3–4 | B1, quote-salvage path |
| 3. Engine-owned objects | ~3–4 | prop-stub retries, zero-patch turns |
| 4. Render-only contract | **2–3** (proposal + selection + 1 render) | the patch-validation retry loop (the 70% cost center) |
| 5. Laya cascade | **1–2** (cascade + 1 render) | proposal/selection LLM latency |
| 6. Budgets + protocol | 1–2, enforced | silent 73-minute burns |

---

## Phase 1 — Engine-owned movement

**Goal:** the model never emits coordinates. Movement is computed by the
engine, always materializes, and always moves the right actor.

**Changes:**
- New `src/engine/movementExecutor.ts`: `executeMovement(world, action,
  semantics)` → `{x, y, path} | null`. Resolves the destination from
  action semantics (`destinationActorId` / `destinationObjectId` /
  `destinationPlaceId` — already emitted), pathfinds with the existing
  `pathfinding.ts` / `movementAssist.suggestMoveTarget`, returns the final
  cell. Returns `null` for stationary intents (typing/staring/sipping —
  the A7 downgrade already detects these).
- `turnOrchestrator.ts`: after semantics resolution, if `semantics.moves`
  → run the executor → apply x/y to the **acting actor only**,
  deterministically. Model-emitted x/y for the acting actor is **ignored**
  (logged at debug). This inverts `movementAssist`: from repairer to
  executor.
- Consequence input gains `executedMovement` facts
  ("Anton moved (2,3)→(5,6), now 1 cell from Tanya") so the render call
  narrates what actually happened.
- Prompt change: delete coordinate-emission instructions; add "do not emit
  coordinates; movement is executed by the engine."
- `physicalValidator` movement checks become engine-output invariants
  (kept as assertions in tests, not retry triggers).

**Kills:** B3 (narrated walk, no patch), B6 (wrong actor moved), B7
residuals, and the entire movement-retry category.

**Non-goals:** multi-actor choreography (still one acting actor per turn);
pushing/pulling objects (Phase 3).

**Acceptance:**
- Golden mock run: render engine emits no x/y — or deliberately wrong
  x/y — final position still equals the pathfinder output.
- Regression tests: B3 shape (walk narrated, no patch) and B6 shape
  (patch for the wrong actor) now produce correct engine movement.
- Full suite green; new tests ≥10.

**Size:** large (touches orchestrator, validator, prompts, ~6 files +
tests). Fits one run.

---

## Phase 2 — Engine-owned speech

**Goal:** quotes are verbatim by construction. The model cannot invent
dialogue because the engine dictates the exact words.

**Changes:**
- Engine extracts quoted speech from the action text at turn start
  (`quotedSegments` already exists in `validate/speech.ts`) → `exactQuote`
  becomes ground-truth turn data, alongside `executedMovement`.
- Render contract: "the narrative MUST contain this exact quote,
  character-for-character." The existing exact-containment validator stays
  as the backstop; the deterministic reinsertion path (exp-3 item 3) stays
  as belt-and-braces — it's proven, don't delete working machinery.
- Unquoted speech (greetings, small talk the action didn't specify):
  render call may compose it, but the echo validator + ECHO-BAN
  (PR #6) police it. No new machinery.
- Prompt change: quote handling section rewritten around `exactQuote`.

**Kills:** B1 (invented dialogue — the exp-7 killer), quote-salvage as a
*repair* path (it becomes a pure backstop).

**Non-goals:** multi-quote turns; dialogue *content* policy (out of scope
— the action text is ground truth).

**Acceptance:**
- Mock render returns narrative with altered quote → validator rejects →
  retry hint → or deterministic reinsertion; final history contains the
  exact action quote in all cases.
- B1 regression test: action `Dana says "I need help with the API"` —
  history quote equals the action quote byte-for-byte across 5 seeds.
- Full suite green.

**Size:** medium (~4 files + tests). Fits one run.

---

## Phase 3 — Engine-owned objects and props

**Goal:** physical manipulation (pick up, put down, hand over) is executed
by the engine from affordances. Ends the "zero object/prop patches in 12
turns" era.

**Changes:**
- `src/engine/objects.ts`: affordance table per object type
  (`pickable`, `surface`, `container`, … — most of this data already
  exists in scenario object defs).
- New `executeManipulation(world, action, semantics)`: resolves
  `contactActorId` / object targets from semantics (already emitted);
  mutates `prop` / holder / location deterministically. The existing
  prop-stub repair becomes the executor (same inversion as Phase 1).
- Model stops emitting `objectPatches` for the acting actor's own
  manipulations (ignored if present, logged). Observer objectPatches were
  already rejected by turn discipline.
- Render input gains `executedManipulation` facts
  ("Dana now holds the laptop").

**Kills:** prop-stub retries, phantom props, the whole "model forgot the
physical world" category.

**Non-goals:** multi-step crafting / container nesting (single
pick-up/put-down/hand-over only); object *creation* (still model-narrated,
engine-ignored).

**Acceptance:**
- "Dana picks up the laptop" with a render engine that emits no
  objectPatches → `dana.prop === "laptop"` deterministically.
- Hand-over: "Anton hands Tanya the report" → holder flips, both actors'
  states coherent.
- Full suite green.

**Size:** medium (~4 files + tests). Fits one run.

---

## Phase 4 — Render-only consequence contract

**Goal:** delete the patch-validation retry loop — the 70% cost center.
The consequence engine becomes a *render* engine: prose in, prose out.

**Changes:**
- Schema: `ConsequenceResult` → `{ narrative, thoughts, emotion,
  reasoning? }`. `actorPatches` / `objectPatches` / `effects` leave the
  **model** contract. (The engine keeps its own internal patch types for
  Phases 1–3 executors — those were never the model's business.)
- `llmConsequenceEngine.ts`: single render call, max 2 attempts,
  **prose-only validation** (voice, pronouns, echo, observer-discipline,
  quote containment). No patch validators in the path.
- `turnOrchestrator.ts`: turn = proposal → selection → execute (engine,
  Phases 1–3) → render (LLM). The `resolveWithValidation` patch loop is
  deleted; `turnSalvage` patch machinery is deleted (prose synthesis for
  the liveness floor stays — it's 20 lines).
- Prompt: the consequence prompt shrinks by roughly half — it now says
  "here is what happened (executed, final); narrate it," with the
  executed-facts block (movement, quote, manipulation) as its source of
  truth. Narrative *invention* beyond the facts is a voice violation.

**Kills:** the retry loop itself. Consequence is 1 call, occasionally 2
for prose issues. This is the phase the latency graph bends.

**Non-goals:** touching proposal/selection (Phase 5); prose *quality*
taste (that's what the 14B is for).

**Acceptance:**
- 3-turn mock run with provider-call counting: ≤4 calls/turn total,
  consequence exactly 1 call on clean turns.
- A render engine that returns garbage patches (old schema) → patches
  ignored, turn still clean. (There is nothing left to validate them
  against — by design.)
- Full suite green; deleted-code diff is net negative lines.

**Size:** medium-large, mostly deletion. Fits one run.

---

## Phase 5 — Laya decision cascade (proposal + selection)

**Goal:** replace the two remaining LLM calls with the Laya decision
cascade. A turn becomes: cascade (seconds, local) + 1 render call.

**Changes:**
- Wire the existing flagged Laya machinery as the **default**
  proposal/selection path: intent cascade (what kind of action →
  target/addressee → exact intent), renderability screen, salvage
  ranking, locomotion veto. LLM proposal/selection become the fallback
  (config flag `LLM_DECISION_FALLBACK=1`, default on during transition).
- **Typed intents** `{type, target, quote}` — this is why Phases 1–3 came
  first: every intent type maps directly to an engine executor
  (move → movementExecutor, speak → exactQuote, manipulate →
  executeManipulation). No translation layer, no new ambiguity.
- Dynamically generated Laya questions per Anton's standing goal: the
  cascade's question sets are built from the live roster/scene, not
  hardcoded.
- `eval:run-quality` harness (exp-4) gains a cascade-vs-LLM decision
  comparison mode.

**Kills:** proposal/selection LLM latency — the last LLM cost outside
rendering.

**Non-goals:** Laya for *rendering* (prose stays generative — memory
2026-10-07 established this split); removing the LLM fallback (keep it
until the cascade beats it on the eval harness for 3 consecutive runs).

**Acceptance:**
- `--auto` 5-turn run on the Laya path: mean turn time dominated by the
  single render call; total ≤ ⅓ of the Phase-4 LLM-decision baseline.
- Eval harness: cascade decisions ≥ LLM decisions on the quality rubric,
  or the fallback stays default and the phase is re-scoped (stated
  plainly — no silent downgrade).
- Full suite green.

**Size:** large (wiring + questions + eval). Fits one run because the
cascade machinery already exists behind flags — this phase is
integration, not invention.

---

## Phase 6 — Budgets, telemetry, protocol

**Goal:** make the economics structural. No future experiment silently
burns 73 minutes again.

**Changes:**
- `EngineConfig.turnCallBudget` (default 4): the orchestrator counts
  provider calls per turn and logs a loud warning + `budget_exceeded`
  event when crossed. Not a hard abort (a turn that needs 5 calls to
  avoid a fallback is better than a fallback) — but visible.
- `--auto` gains a turn-time gate: warn at 90 s, and print the running
  table (proposal / selection+execute / render ms + calls) every turn.
- Telemetry: per-turn breakdown appended to the JSONL log; a small script
  (`npm run report:turns`) regenerates the exp-7 findings table from any
  run's log — findings docs become generated, not hand-written.
- `experiments/PROTOCOL.md`: the Phase-gate protocol from PLAN.md §5
  (diagnose preflight → 3B smoke → 14B smoke → 20-turn run), as a checklist
  the runner follows.

**Kills:** silent cost blowups; hand-computed findings tables.

**Non-goals:** changing any engine behavior (telemetry only).

**Acceptance:**
- A rigged run (mock engine with 3 forced render retries) prints
  `budget_exceeded` and the report script shows exactly where the calls
  went.
- `experiments/PROTOCOL.md` followed verbatim for the phase's own
  validation run — dogfooding.
- Full suite green.

**Size:** small-medium. Fits one run easily — good cooldown after Phase 5.

---

## Ordering notes

- Phases 1→2→3 are sequential (each assumes the engine owns more).
- Phase 4 needs 1–3 (nothing left for the model to patch).
- Phase 5 needs 1–3 (typed intents need executors) but **not** 4 — if
  Anton wants speed before the schema slimming, 5 can jump the queue
  after 3. Say so explicitly when proposing it.
- Phase 6 is last (budgets are set against the final architecture).
- If any phase's acceptance criteria fail, the phase is re-scoped, not
  force-merged. A phase that can't meet its bar is information — it means
  the assumption underneath it was wrong, which is exactly what
  Phase-gating is for.
