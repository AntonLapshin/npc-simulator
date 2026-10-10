# NPC Simulator — Architecture

Reviewed against `origin/master` @ `0bd873b` ("Clean up", on top of the
`4e902bb` code-structure cleanup), 2026-10-07. This document describes the
system's design principles as implemented, then its known flaws. It is a
review artifact, not a marketing page: every flaw cites the file that owns it.

## What it is

A turn-based, open-ended life simulation. One scenario holds an environment,
objects, and characters. A human controls one character; every other character
is an autonomous NPC driven by LLMs. Each turn, exactly one character performs
one immediate, free-form action — speech, movement, object interaction, social
or emotional behavior, or any combination. LLM "engines" interpret the text
and propose how the world changes; a deterministic engine decides whether it
does.

```
┌─────────────┐     ┌──────────────┐     ┌───────────────────┐     ┌────────────┐
│  Text /     │     │  Intelligence│     │  Deterministic    │     │  World     │
│  Graphic UI │────▶│  layer       │────▶│  engine           │────▶│  store     │
│  (commands) │     │  (4 LLM roles│     │  (validate →      │     │  (immutable│
│             │     │  + mocks)    │     │   apply → log)    │     │   snapshots│
└─────────────┘     └──────────────┘     └───────────────────┘     └────────────┘
```

## Design principles (as implemented)

### P1. LLMs decide intent and narrate; deterministic code executes (PLAN_V2)

Two LLM roles exist — **Intent** (decide the ONE thing the actor does next:
`{ action, quote }`, one third-person sentence the engine executes
literally) and **Narrate** (describe what happened as prose). Neither can
mutate the world. Every narration is a `ConsequenceResult` — prose only
(`narrative`, `thoughts`, `emotion`, `reasoning?`) — that must pass
`validateRenderProse` (`src/engine/validate/render.ts`) before
`applyRenderResult` (`src/engine/patchApplier.ts`) touches state.
Psychology (thoughts, emotion, goal, memories) is free-form text; physics
and turn structure are hard rules. The pipeline is: intent → Laya parse →
engine executes and clamps → narrate the executed facts. The old
propose-then-pick pipeline (LLM proposal + LLM/Laya selection engines,
intent cascade, renderability screen) was deleted in PLAN_V2 Phase 6 —
it was over-engineered scar tissue that cost 3–4 provider calls per turn
against a 30-second turn budget.

### P2. Patch-based world mutation

The world is a plain data structure (`src/types.ts`: `World` = scenario +
`tick` / `turnIndex` / `history`). Consequences only *propose* `ActorPatch` /
`ObjectPatch` lists; the applier works on a `structuredClone` — worlds are
immutable snapshots and `worldStore.ts` is a thin holder. There is no
spawn/despawn: actor and object membership is fixed at scenario load.

### P3. Free-form semantics, structured physics

Only coordinates, bounds, rectangles, passability, vision/sound blocking, turn
order, and tick are structured (per the header comment in `src/types.ts`).
Everything else is text — but text is policed. A deterministic semantic layer
(`actionSemantics.ts` + `deterministicSemantics.ts`) parses the *action text*
(not the narrative) for quoted speech, displacement tokens, named
destinations/addressees, and contact targets via roster/landmark lookup. The
consequence's self-declared `effects` are merged with the independent
SemanticJudge classification and then *grounded* against the action text:
quotes and ids the model invents are dropped before validation.

### P4. Turn discipline

Exactly one actor acts per turn (`runTurn`, `turnOrchestrator.ts:637`).
Observers may only change internal state (thoughts/emotion/goal/
memories/beliefs/relationships); any observer position/state/pose/prop change
is rejected, and the narrative must describe only the acting actor
(observer-as-subject prose check).

### P5. Honest history

Clean turns record the *action text*; fallbacks are marked
`"Name tried: … (not done)"` and never counted as actions/answers; salvaged and
liveness turns record the *narrative* with a `(partial) [note]` marker. Later
proposals ground on what happened, not on the wish.

### P6. Degraded-but-advancing

The turn loop prefers partial progress over giving up: retry with targeted
feedback → deterministic addressee/prop repair → salvage tiers → liveness
floor → fallback. Per-turn outcomes are accounted as clean / salvaged /
liveness / fallback (`turnOutcomes.ts`). Movement is NOT repaired — it is
engine-owned (see "Movement physics" below): the engine computes the step
before the loop, so there is no movement failure left to repair.

### P7. Tiered intelligence routing

Consequence ("hard": creative, long-context prose) defaults to the hosted
backend (`joingonka`, GLM-5.3-Flash); Intent and SemanticJudge ("simple":
one structured decision) default to a local Ollama model. Per-task
`LLM_BACKEND_*` overrides exist (`src/llm/provider.ts` —
`LLM_BACKEND_INTENT`, `LLM_BACKEND_CONSEQUENCE`, `LLM_BACKEND_SEMANTIC`).
Per-task temperatures (`LLM_TEMPERATURE_*`: intent 0.2, consequence 0.9,
semantic 0.2) and token budgets (`LLM_MAX_TOKENS_*`) ride the same pattern.
All backends speak the OpenAI Chat Completions dialect through one
`OpenAICompatibleProvider` base class. Mock engines (`src/mocks/`)
implement the same interfaces for offline/test runs.

### P8. Perception is spatial, memory compounds

Visibility/audibility = Euclidean radius 12 + line-of-sight through
`blocksVision`/`blocksSound` objects, plus a Manhattan-≤2 adjacency rule
(`perceptionHelpers.ts`). Prompt-side memory uses a budget design
(`src/config.ts`, Phase 5): newest entries verbatim, older ones folded into a
one-line digest under char budgets, so per-turn tokens stay flat while the
stored world keeps full detail up to caps.

### P9. Pure core, thin engine (Phase 1)

`src/core/` holds **pure functions only**: deterministic, no I/O, no argument
mutation (new values are returned), no LLM calls, no `Date.now()` /
`Math.random()` (randomness is injected as a parameter). `src/engine/` holds
business logic and orchestration — world mutation, sequencing, LLM calls — and
delegates the pure logic to `src/core/`, staying thin. Every core module has an
exhaustive unit test file under `tests/unit/core/` (branch coverage enumerated
by hand — no coverage tool is installed). Phase 1 establishes the pattern with
`src/core/movement.ts` (destination resolution, step computation, invariants),
`src/core/text.ts` (text predicates), `src/core/geometry.ts` and
`src/core/pathfinding.ts` (moved verbatim out of `src/engine/`; the old paths
are re-export shims). Phase 2 adds `src/core/speech.ts` (exact-quote
extraction, verbatim containment, deterministic reinsertion) under
`src/engine/speechExecutor.ts` (turn pre-pass, render-contract facts,
in-loop quote backstop); the old quote-repair logic in `turnSalvage.ts`
delegates to it, and `validate/speech.ts`'s quote parser is consolidated
onto the core (`parseActionQuotes`). Phase 3 adds `src/core/objects.ts`
(the canonical affordance kind table, `planManipulation` — pick-up /
put-down / hand-over planned as data from the action text — the shared
verb ontology, and engine-output invariants) under
`src/engine/manipulationExecutor.ts` (turn pre-pass, in-loop refresh on
the merged contact, `applyEngineManipulation`); the prop-stub repair
(`propStubForGroundingErrors`, `repairMissingPropStub`) is deleted —
subsumed by the executor. Phase 5 adds `src/core/decision.ts` (target
questions over the live roster/scene, target resolution, deterministic
intent-candidate templates, probability ranking — the pure half of the
Laya decision cascade) under `src/decision/` (proposal/selection engines,
shared intent-cascade step). Phase 6 adds `src/core/telemetry.ts` (turn
economics: budget predicate, duration formatting, generated-findings
report) under `src/engine/turnTelemetry.ts` (`ProviderCallCounter`) and
the orchestrator's per-turn `turn_telemetry` event.

## Turn pipeline (PLAN_V2 — the only turn loop)

`runTurn(world, deps)`:

1. **Turn start** — acting actor = `order[turnIndex % order.length]`; logs
   `turn_started` with a full world clone.
2. **Intent (1 LLM call)** — the user actor's action comes straight from the
   UI (no model call). Every NPC: `intentEngine.intent(world, actorId)` →
   `{ action, quote }`: ONE third-person sentence the engine executes
   literally (no teleporting, no invented props) plus the exact quoted
   speech (or `""`). Exactly 1 retry, then the deterministic
   `FALLBACK_INTENT` ("waits and observes the situation."). Logged
   `intent_started` / `intent_completed` / `intent_failed`; occupies the
   `proposal` slot of the turn call budget.
3. **Parse (1 local Laya decide)** — `parseActionSemantics`
   (`src/engine/semanticParser.ts`) runs the Laya semantic judge over the
   single action sentence: ONE batched `decide()` with the judge question
   set (`q_moves` / `q_speaks` / `q_addressee` / `q_destination` /
   `q_contact`, `src/decision/judgeQuestions.ts`) → `ActionSemantics` for
   the executors. Laya is a parser here, never a decider — it never sees
   scene-level classification (this kills the Stage-3 miscalibration
   failure by construction: there is no scene-level classification left to
   get wrong). Fail-open: any parse failure (Laya down, protocol error,
   `LAYA_MODE=off`) returns `undefined` and the executors' deterministic
   text parsers take over; the turn never blocks on the parser. Logged
   `parser_completed` / `parser_fallback` (module "laya"). The locomotion
   veto (`checkLocomotionVeto`) also runs here when the plan moves — a
   genuine physics guard: Laya only ever VETOES a planned move it is
   confident needs no relocation; failure or low confidence keeps the
   deterministic verdict.
4. **Execute + clamp (engine, 0 calls)** — `resolveRender` executes the
   turn deterministically from the action text (+ pre-parsed semantics
   when present): movement (`movementExecutor.ts` → `src/core/movement.ts`),
   speech quote (`speechExecutor.ts` → `src/core/speech.ts`), manipulation
   (`manipulationExecutor.ts` → `src/core/objects.ts`), pose (`planPose` →
   `src/core/text.ts`). The clamp policy (`src/core/clamp.ts` →
   `src/engine/clampPolicy.ts`) records attempted-vs-executed
   (`clampMovement` / `clampContact` / `clampManipulation` →
   `AttemptRecord`); a failed attempt is a story beat ("she reaches for
   his hand, but he's across the room"), never `(not done)`. Logged
   `clamp_applied`.
5. **Narrate (1 LLM call)** — `LLMConsequenceEngine.resolve` narrates the
   executed facts (`buildNarrateContext`): movement / quote / manipulation /
   pose facts + the clamp record + grounding rules + identity/roster +
   the director style guide. The prompt carries NO history section (the
   echo attractor is gone) and NO per-actor memory dump — the executed
   facts are the narrator's only source of truth. The schema is prose-only
   (stray patch keys are stripped and ignored). One retry on validation
   failure, then accept-and-mark honest (`narrate_accepted_despite_violations`)
   — a flawed paragraph beats a dead turn. When the engine itself throws:
   the NPC liveness floor (`buildLivenessConsequence` when
   `consecutiveFallbacks ≥ livenessFallbackThreshold`, default 3) or the
   "Nothing changes." fallback (user turns, and NPCs below threshold).
   `narrateAcceptedDespiteViolations` is recorded on the result.
6. **Director (Phase 5)** — two halves: the style guide verbatim in the
   narrate prompt (how to handle drama — never invent it) + the
   deterministic staleness trigger (`src/core/director.ts`): when an actor
   repeats the same verb|noun action core with a byte-identical physical
   world for `directorStalenessThreshold` turns (default 6), the scenario's
   next `directorEvents` incident is injected as a WORLD FACT in the next
   NPC intent prompt and as a history entry (so the picture shows it).
   Each incident fires at most once across save/load.
7. **Apply** — `applyRenderResult` writes the acting actor's
   thoughts/emotion from the prose; observers are never touched (their
   response belongs to their own turn). Memory caps trim oldest
   (memories 50, beliefs/relationships 30); history capped at 200, one
   tickless entry per turn.
8. **Advance** — `incrementTick` + `advanceTurn`; autosave to
   `saves/<id>_tick<N>.json`; `turn_completed` + `turn_telemetry` (the
   per-stage provider-call breakdown) logged.

**Turn economics.** A clean NPC turn costs exactly 2 LLM calls (intent +
narrate) + 1 local Laya decide (parse); a user turn costs 1 + 1 (intent
skipped). `ProviderCallCounter` (`src/engine/turnTelemetry.ts`) counts
provider-backed engine invocations per turn (engines opt in via
`providerBacked`; the Laya parser is local and costs nothing) — intent
occupies the `proposal` slot, narrate the `render` slot, `selection`
stays 0. Asserted by `tests/integration/v2TurnCost.test.ts` (scripted
proxy: provider-backed stub engines + a counting Laya client).
`TURN_TIME_BUDGET_MS` (default 30000, Anton's hard line) logs a loud
`turn_time_exceeded` event — telemetry only, never an abort.

**Observer triage: cut (Phase 6 decision).** The old pipeline ran a
triage/salience classification to decide which observers react, and wrote
their thoughts/emotions from the acting turn's consequence call. In v2
the narrate contract forbids describing any other actor's perception or
reaction ("Observers react in their own thoughts, on their own turns"),
and `applyRenderResult` writes thoughts/emotion for the acting actor
only — an observer's inner life updates when their own turn's narrate
call runs. The triage machinery is therefore genuinely unused: no code
path reads it, no prompt needs it, and keeping a classifier for a job
the architecture no longer has would be dead weight. Cut outright; if
observer reactions ever feel flat in long runs, the fix belongs in the
director (a staleness-style trigger for ambient reactions), not in a
revived triage step.

**Render validation** (`src/engine/validate/render.ts`): the schema strips
unknown keys (old `actorPatches` / `objectPatches` / `effects` are
ignored, logged at debug); then prose-only checks run against the
engine-executed facts — voice, pronouns, echo/placeholder,
observer-discipline, exact-quote containment, identity, and grounding
(narrated movement requires an engine move; narrated locomotion aimed at
the wrong actor contradicts the engine destination —
`movement.destination_mismatch`; narrated pose changes require the engine
pose; narrated manipulation requires an executed manipulation; narrated
contact requires post-move adjacency; questions and utterances must
survive rendering; thoughts stay grounded).

Deliberate non-goal (Stage-1 A4 decision): validators police *false
claims*, not *missing coverage*. A narrative that omits an executed fact
("looks at the door" for a type-on-laptop turn) is infelicitous but not
fiction, and forcing mentions risks retry inflation on small models. The
repetition screen, however, is engine machinery — its cores derive from
the ground-truth action text (`HistoryEntry.actionText`), never from the
narrative, so a mis-render cannot poison downstream dedup. Omission rates
are a Stage-2 (14B) measurement before any scoping.

**Movement physics** (engine-owned): the model never emits coordinates.
`src/core/movement.ts` (pure) resolves the destination and computes the
step; `src/engine/movementExecutor.ts` (orchestration) runs it once per
turn and merges the result. Per-turn cap 6 cells (half perception
radius); path existence via 4-directional A* on an integer grid
(`src/core/pathfinding.ts`); directed steps must get *strictly closer*
to the named destination — the engine always takes the closest legal
cell within the cap, so real progress holds by construction (no token
shuffles possible); arrival prose must end within 4 cells of the
landmark.

**Speech** (engine-owned): the model never invents dialogue.
`src/core/speech.ts` (pure) owns exact-quote extraction
(`extractExactQuote` — first quoted segment of the action text; the
documented multi-quote rule), verbatim containment (`quoteContained` —
character-for-character modulo quote-style canonicalization), and
deterministic reinsertion (`reinsertQuote`); `src/engine/speechExecutor.ts`
(orchestration) runs the turn pre-pass once, states the render contract
as `EXACT QUOTE` facts, and applies the in-loop backstop
(`applyEngineSpeech`) before validation.

**Object manipulation** (engine-owned): the model never emits
objectPatches or `prop` patches. `src/core/objects.ts` (pure) owns the
canonical affordance kind table (`affordanceForObject` — pickable /
propName / surface / container / brewSource, first match wins), the
shared verb ontology (pick-up / put-down / hand-over verbs, use verbs
that imply holding, the "shake hands" exclusion), `planManipulation`
(the intended mutation as data — never mutates), `nearestKindObject`
(deterministic tie-break by object id), `detectNarrativeManipulation`
(transfer events only — stative holds and use verbs are not events), and
`assertManipulationInvariants`. `src/engine/manipulationExecutor.ts`
(orchestration) runs the turn pre-pass once, refreshes the plan against
the merged contact in-loop, and merges via `applyEngineManipulation`.
The manipulated scene object travels with its holder (pick-up → actor's
cell, put-down → actor's feet, hand-over → recipient's cell). Grounding
is one-directional: the engine may execute a transfer the narrative
never names (fine), but narrative describing a transfer the engine did
not execute fails validation (`object.phantom_manipulation`). Non-goals:
multi-step crafting / container nesting (single manipulation per turn,
documented); object *creation* (still model-narrated, engine-ignored).

**LLM constraint ladder** (`src/llm/complete.ts`, `src/schemas.ts`):
Zod strict schemas for proposal/selection; a lenient "repair" tier for
consequence (fixes `"id"`→`"actorId"`, JSON-encoded strings→arrays, defaults
missing `reasoning`); a `completeJson` loop that logs prompts, extracts JSON
(fence strip → balanced-brace scan → doubled-quote collapse → truncated-JSON
repair), zod-validates, runs engine-specific `extraCheck` (dedup, POV-swap
detection, id validation against the real roster), and retries with an
appended repair prompt. `response_format: {type: "json_object"}` is sent by
default (set `LLM_JSON_MODE=0` to disable).

## Turn economics (budgets, telemetry, protocol)

Turn cost is multiplicative: (calls per turn) × (seconds per call).
PLAN_V2 attacked calls-per-turn structurally: the v2 turn is 2 LLM calls
+ 1 local Laya decide (see Turn pipeline above). The remaining tooling is
telemetry only — nothing here changes engine behavior.

- **Call budget** (`EngineConfig.turnCallBudget`, default 4): the
  orchestrator counts provider-backed engine invocations per turn
  (`ProviderCallCounter` in `src/engine/turnTelemetry.ts`; engines opt in
  via `providerBacked` — the two LLM engines declare it, the Laya parser /
  deterministic stubs / mocks don't). Crossing the budget logs a loud
  `budget_exceeded` event — never a hard abort (a 3-call turn beats a
  fallback).
- **Per-turn telemetry**: every turn logs a `turn_telemetry` JSONL event
  with the per-stage ms split, the per-stage call counts
  (`proposal`=intent / `selection`=0 / `render`=narrate), the budget
  verdict, and the outcome (`clean | liveness | fallback`). The pure
  types, budget predicate, and report formatting live in
  `src/core/telemetry.ts`; `--auto` prints a one-row-per-turn running
  table via the `onTurnTelemetry` hook. `TURN_TIME_BUDGET_MS` (default
  30000) warns at Anton's 30 s hard line.
- **Generated findings**: `npm run report:turns -- logs/<session>.jsonl`
  (`scripts/report-turns.ts`) regenerates the exp-7-style findings table —
  summary, per-turn economics, per-stage latency — from any run's log.
  Findings docs are generated, never hand-written.
- **`--compare` honesty** (`scripts/eval-run-quality.ts`): the Stage-3
  lesson is encoded — failed attempts carrying `usage` payloads
  (`intent_failed` with usage; legacy `proposal_failed` /
  `selection_failed` in old logs) count in the per-turn call tallies via
  `failedDecisionCalls`, because a fallback engine that retries internally
  burns provider calls without ever logging a `*_completed`. Covered by
  `tests/unit/evalCompare.test.ts`.
- **Protocol**: `experiments/PROTOCOL.md` is the phase-gate checklist
  (diagnose preflight → 3B smoke → 14B smoke → 20-turn run), plus the
  re-scope-don't-force-merge discipline.

## Decision layer (PLAN_V2 Phase 6 — the cascade is deleted)

The Laya decision cascade (proposal/selection engines, the static
diagrams, the intent cascade, the renderability screen) is deleted.
It was the wrong shape for the job: scene-level classification is what
Stage 3 falsified (the cascade never converted; the comparison measured
"LLM path + Laya latency tax"). What survives of Laya is exactly two
things:

1. **The semantic parser** (`LayaSemanticJudge`,
   `src/decision/layaSemanticJudge.ts` + `src/decision/judgeQuestions.ts`):
   one batched local `decide()` over the single action sentence, producing
   `ActionSemantics` for the executors (`src/engine/semanticParser.ts`,
   fail-open). Laya as parser, never decider.
2. **The locomotion veto** (`checkLocomotionVeto`): a genuine physics
   guard — Laya only ever VETOES a planned move it is confident needs no
   relocation. Kept because it guards the world, not because it decides.

Wiring is slim: `LayaWiring = { client, config }`
(`src/engine/layaWiring.ts`), `LAYA_MODE=off` disables Laya entirely,
legacy `static`/`dynamic` values map to `on`. `layaClient.ts` and the
question-planner infra the parser needs stay; everything else is gone.

## Flaws

> PLAN_V2 Phase 6 note: several flaws below reference machinery deleted
> with the v1 turn loop (turnSalvage.ts, actionSemantics.ts,
> addressee/proposal patch validators). They are kept as historical
> observations of the old pipeline; the v2 analogues (if any) are noted
> inline. A full re-audit of this section against the v2 pipeline is
> future work.

### Design-level

**F1. The deterministic verb list fully overrides the LLM on `moves` — and the
comment contradicts the code.** `applyDeterministicGrounding`
(`actionSemantics.ts:323-332`) sets `moves` from `hasDisplacementToken` and
discards both `effects.moves` and the judge's verdict, logging "kept token".
The adjacent comment claims an unrecognized real verb "keeps the merged
verdict (status quo)" — false in the code. Consequences: (a) the
MockSemanticJudge's adjacency exemption ("approach/join when already adjacent
→ not locomotion") is dead in production — "walk up to Tanya" while adjacent
*must* move a cell; (b) any locomotion verb outside the ~60-form whitelist
("ambulate", "sashay") can never produce movement, and the mirror-direction
gate then *rejects* a legitimate position change as a teleport. The fixed verb
ontology is the single hardest semantic ceiling in the system.

**F2. Salvage classification is done by regexing human-readable error
strings.** `isSpeechOnlyFailure` and `isTier2Salvageable`
(`turnSalvage.ts`) match substrings like `/exact words|invents dialogue/`
against validator messages. Rewording any validator error silently changes
salvage eligibility — the failure taxonomy is prose, not codes.

**F3. The addressee-repair path is unreachable for non-movement turns.**
`trySalvageConsequence` early-returns "acting actor unpatched and no
locomotion implied" (`turnSalvage.ts:270`) *before* `repairMissingAddressee`
(`:315`) — yet the repair exists precisely for speech-only turns whose
consequence left the addressee unpatched, which `validateAddresseePatch`
rejects. Such turns can never be salvaged; they fall back. Either the guard or
the repair is wrong about the intended contract.

**F4. Object manipulation has no actor-proximity or permission model.** Any
turn can move/resize any object (within bounds) or flip
`passable`/`blocksVision`/`blocksSound` — no check that the actor is near the
object, and no turn-discipline for objects (unlike actors). A character across
the room can teleport the coffee machine; a consequence can make walls
passable. The narrative-side gates check *wording*, not *permission*.

**F5. Observers may rewrite another actor's `goal`.** Turn discipline
restricts observers to internal state — but `goal` is internal state, and goals
drive proposals. A consequence can silently reprogram another NPC's goals on
someone else's turn with no semantic check. Deliberate (social influence) or an
over-broad allowlist — currently undocumented.

**F6. Knowledge is global while perception is spatial.** Proposal/selection
prompts receive the *full global history* unfiltered by perception
(`contextBuilder.ts:625/702`). An NPC in another room "knows" events they
could not perceive; `thoughts` of perceiving actors are even rendered into the
consequence snapshot. The perception model gates positions, not knowledge.

**F7. Injected `EngineConfig` is partially dead.** `perceptionHelpers.ts:14`
falls back to the imported `defaultConfig`, and no caller passes the injected
radius — `config.defaultPerceptionRadius` never takes effect. Same for
`proposalHistoryLimit`, `openQuestionScanWindow`, `consequenceSnapshotRadius`
in `contextBuilder.ts` (`:149, :203-204, :858` read `defaultConfig` directly).
A caller overriding these gets silently ignored.

**F8. Object/prop ontology is hardcoded to the office scenario.**
`validateObjectGrounding` / `validateActionVerbCoverage`
(`validate/objects.ts`) enumerate `laptop|mug|cup|bag|chair|papers?|phone|
monitor` and coffee-brewing assumptions. Reusing the engine for another
scenario carries office-specific gates that misfire or go stale.

**F9. `moves` mirror rule vs. narrative repair paths can fight.** When
grounding downgrades `moves` to false (F1), `validateMovementIntent` demands
the actor stay in place — while `validateNarrativeMovementGrounding` demands a
position patch if the narrative used a locomotion verb. A consequence
satisfying the action text can be trapped between the two.

**F10. No actor-actor collision.** `isPointBlocked` only checks non-passable
objects; two actors may occupy the same cell. `suggestMoveTarget` merely
*deprioritizes* stacking.

**F11. No retry backoff in the shipped loop.** `completeJson`
(`src/llm/complete.ts:82-180`) retries immediately with zero delay. Exp-6's
47-minute turn was retry-amplification (37 timeouts in 9 turns); the in-repo
loop still has that property. The only backoff ever used was an *external*
experiment-runner script that is not in the repo.

**F12. Failover is dead code.** `FailoverProvider` +
`createProviderForTaskWithFailover` (`src/llm/provider.ts:500-585`, Exp-6 item
6) are not exported from `src/llm/index.ts`, and `createLlmEngines` (used by
both UIs) wires plain `createProviderForTask`. The flagship Exp-6 resilience
feature is inert — unreachable from either UI; its only consumer is the unit
test.

**F13. JSON-mode off by default.** Exp-6 item 7 calls `LLM_JSON_MODE=1`
(`response_format: json_object`) the single highest-ROI fix for the dominant
failure mode (14/61 "Let me analyze this…" collapses), yet it is off by
default and nothing in-repo verifies which backends honor it.

**F14. Temperature 0.9 everywhere.** The global `LLM_TEMPERATURE=0.9` (plus
`repeat_penalty=1.1`, which is not a standard OpenAI parameter — Ollama honors
it, the hosted gateway likely ignores it) applies to *all* tasks including the
classification tasks (selection, semantic judge), which want low temperature
for determinism. Should be per-task, mirroring the existing per-task
`LLM_MAX_TOKENS_*` pattern.

**F15. Lenient consequence normalization silently accepts degraded output.**
`reasoning` defaults to `""` even though the prompt says it is *required*
(schema contradicts prompt); unknown keys are dropped by non-strict patch
schemas; `effects` is silently deleted when malformed
(`src/schemas.ts` ~200-225). Model sloppiness can pass validation without a
retry.

**F16. Mocks are keyword-based, production is LLM-based — by design.**
`src/mocks/mockSemanticJudge.ts` is documented as intentionally divergent
("faithful paraphrase understanding belongs to the LLM judge"). Offline/test
behavior can therefore differ from production on anything non-literal (idioms,
metaphors) — the unit suite cannot catch judge-quality regressions.

### Code-level

**F17. Autosave is non-atomic and unbounded.** `persistence.ts:saveWorld`
does a plain `writeFile` — a crash mid-write corrupts the save (no
tmp+rename). The path embeds the tick, so every turn writes a *new* file;
`saves/` grows forever with no rotation.

**F18. ~5 full world deep-clones per turn.** `turn_started` log,
`applyConsequence`, `incrementTick`, `advanceTurn`, `turn_completed` log —
each `structuredClone`s the entire world. Fine at office scale; a real
scalability tax with compounding memories (JSONL logging doubles it further).

**F19. `suggestMoveTarget` is a full-scene scan with per-candidate A*.**
O(width×height) cells × objects, then `canMoveBetween` (A* with a linear-scan
open list — O(n²)) until first success. Fine at 20×20; pathological on large
scenes.

**F20. Duplicate `order` entries not rejected.** `scenarioLoader.ts` checks
unknown/missing order ids but not duplicates — a duplicated id gives an actor
two turns per cycle.

**F21. Mention resolution uses bare substring, no word boundaries.**
`resolveMentionedActorId` (`deterministicSemantics.ts`) and the contact block
in `validateActionVerbCoverage` (`objects.ts`) use `includes(id)` — id `"dan"`
matches `"Dana"`; first roster match wins (order-dependent). Elsewhere
(`actorMentionVariants`) uses `\b`. Inconsistent strictness.

**F22. Fallback-streak counting trusts prompt formatting.**
`consecutiveFallbacks` relies on the `"(not done)"` substring — a
*user-written* action containing "(not done)" would corrupt streak counting
and open-question filtering.

**F23. `isFallbackConsequence` is narrative-string equality.** A legitimate
consequence whose narrative is exactly `"Nothing changes."` with no patches is
misclassified as a fallback (marked "tried … (not done)").

**F24. Token-shuffle failures get a hint but no auto-repair.** The in-loop
`suggestMoveTarget` repair requires `isMovementOnlyFailure`, which excludes
"make real progress"/"token shuffle" errors — the exact failure the repair was
built for (Exp-3 tick 15) only gets a feedback hint, not the deterministic
fix. (Salvage covers it later; the cheaper in-loop path doesn't.)

**F25. `salvageFormatCollapse` skips the perceiver rule.**
`repairMissingAddressee` requires the addressee to perceive the event; the
format-collapse tier adds its addressee stub without that check — inconsistent.

**F26. `WorldStore.applyConsequence` drops `ApplyConsequenceOptions`.**
Callers of the store can't mark fallbacks/honest notes; only `runTurn` (which
bypasses the store) can. The store is thus unusable for the real turn loop.

**F27. Scenario/save `version` is never read.** No migration logic; the field
is decorative.

**F28. Deadline race leaves the LLM call running.** `withTurnDeadline`
ignores the late result but cannot cancel the underlying promise — a hung
provider keeps burning tokens/requests in the background after the turn moved
on.

**F29. Log bloat / privacy.** Every `completeJson` attempt logs full prompts +
raw responses to JSONL with no capping or rotation; prompts contain full
subjective context. Long sessions → large logs; provider names are redacted
but prompt text is verbatim.

**F30. Graphic server posture.** `server.listen(port)` with no host binds **all
interfaces**; CORS `Access-Control-Allow-Origin: *` on API and static
responses; **no auth** on `POST /action` (runs LLM-spend turns) and
`POST /reset`; `/logs` exposes full LLM traces to any client. On a shared
LAN/VPN this is an open LLM-spend endpoint.

**F31. No cost tracking.** Logs record `promptChars` and a crude `chars/4`
token *estimate* for prompts only — no output-token counts, no per-call
totals, no USD. Exp-6 measured ~4–10 LLM calls per NPC turn at 30–120 s/call
on a sick gateway (≈2–4 turns/hour worst case).

**F32. No concurrency across independent calls.** Proposal and selection run
sequentially; nothing overlaps I/O at all. (Selection can't start before
proposal completes, but judge + consequence already overlap — the pattern
exists, it just isn't used elsewhere.)

**F33. Per-task token budgets (`LLM_MAX_TOKENS_*`) cap *output* only.** The
dominant cost driver is *input* (the full world dump in consequence prompts);
nothing caps that beyond the prompt-section char budgets in `src/config.ts`.

**F34. Narrative locomotion misses "heads to".** `HEAD_VERB_RE`
(`validate/narrative.ts`) matches `head to/toward…`, `headed`, `heading` but
not `heads to` — "Heads to the desk" with no position patch passes grounding.
(Action-side `HEAD_TO_RE` has the same gap.)

**F35. Near-duplicate mask regexes can drift.** `maskNonLocomotion`
(`deterministicSemantics.ts`) duplicates `maskResumedActivity`
(`validate/speech.ts`) — two "resumed activity" mask sets maintained
separately.

## Open questions

1. **History records the narrative** (one tickless entry per turn); the
   action text survives in `HistoryEntry.actionText` for the repetition
   cores. The old clean-turn/wish asymmetry is gone with the v1 loop.
2. **The Laya semantic judge is back in the turn loop as the parser**
   (PLAN_V2 Phase 2): one batched decide over the action sentence,
   fail-open. It classifies sentence semantics (moves? speaks? addressee?
   destination? contact?) — never scene-level decisions. The old
   "SemanticJudge references are legacy" note is superseded.
3. **Observer thoughts/emotions (triage/salience): CUT** — decided in
   Phase 6 (see "Observer triage: cut" above). No code remains.
4. **Observer `goal`-rewriting** (F5) — deliberate social-influence lever or an
   over-broad allowlist?
5. **`tick` increments once per turn for the whole world** — not per actor, not
   wall-clock. Any consumer expecting per-actor ticks or time will misread it.
6. **Should `moves` grounding really be token-totalitarian** (F1)? The code and
   its own comment disagree; the mock judge's adjacency exemption suggests the
   *intent* was judge-aware. Which is the intended contract?
7. **Exp-6 §4.2.1 destination precedence** — the model was right, the resolver
   wrong, the merge rule sided wrong. Was the fix (model-declared existing ids
   outrank the resolver) actually landed? Needs a check in
   `engine/deterministicSemantics.ts` / turn salvage.
8. **Zero object-interaction across 4 experiments.** The engine verifies object
   patches strictly but never elicits them — is object manipulation a real
   gameplay pillar or dead weight in the validator? (The old
   `buildObjectAffordanceNudge` reference is gone with the v1 prompts.)

## Notes on running it

- Default local models are tiny and uncensored (`fluffy/l3-8b-stheno-v3.2`
  8B, `huihui_ai/llama3.2-abliterate:3b` 3B via `npm run setup:ollama`); the
  repo's own experiments show small models produce format collapses and
  behavioral attractors (handshake loops, invented roster), while the hosted
  large model hit ~67% applied turns. The uncensored angle is load-bearing:
  the shared system prompt demands no refusal/moralizing.
- A bigger local model (14B–32B class on a 16 GB VRAM card) is untested in
  the experiment harness — `npm run diagnose:ai` plus a 21-turn protocol
  re-run is the honest way to validate before committing.
- The `laya-serve` trap: it exposes a Jev-style typed-decision API
  (`POST /v1/systemone`), *not* Chat Completions — pointing `LAYA_BASE_URL`
  at it fails (`.env.example` documents this).

## Fix log (2026-10-07)

All findings below were addressed on branch `arch-fixes` (commit "Address
ARCHITECTURE.md findings F1-F35 + open questions Q1-Q7"), verified with
`npx tsc --noEmit` clean and 428/428 vitest passing. Open-question decisions
were delegated to the implementers by the repo owner.

- **F1** — `moves = tokenMoves || merged.moves` in `actionSemantics.ts`: token evidence can assert movement but never downgrade a true merged verdict; disagreements still logged; the lying comment fixed.
- **F2** — `ValidationResult.errors` is now `Array<{code, message}>` (~60 stable snake_case codes across the validator); salvage classifiers switch on codes, not prose.
- **F3** — `repairMissingAddressee` now runs before the acting-actor-unpatched early return in `trySalvageConsequence`.
- **F4** — object move/resize/toggle patches require the acting actor within `OBJECT_INTERACT_RADIUS = 4` cells of the object center; description-only patches exempt. Phase 3 goes further: the model emits no object/prop patches at all — the engine executes pick-up/put-down/hand-over from affordances with proximity (4 cells), hand-over adjacency (2.5 cells), and free-hands guards; `object.phantom_manipulation` polices narrative fiction.
- **F5** — validator rejects `goal` patches on non-acting actors (`turn_discipline.observer_goal_rewrite`); own-goal updates allowed.
- **F6** — history entries are `{ text, perceivers }`; perceivers computed at apply time via spatial perception; `contextBuilder` filters history and the open-question scan to what the actor perceived or authored; legacy string saves normalize to globally-perceived.
- **F7** — `EngineConfig` threaded through `contextBuilder`/`perceptionHelpers` (`cfg` param, `defaultConfig` default); `runTurn` passes the injected config. No silent default reads on the hot path.
- **F8** — scenarios accept optional `vocabulary: { objectNouns?: string[] }` (loader-validated, schema-accepted); validators use it with office fallbacks; `office.json` / `office-anton.json` untouched. Phase 3 consolidates the manipulation ontology into one canonical kind table (`OBJECT_KIND_AFFORDANCES` in `src/core/objects.ts`) shared by the planner, the validator's phantom gate, and the executor — still hardcoded (not vocabulary-driven), but no longer triplicated.
- **F9** — resolved by F1; narrative movement grounding unchanged (narrative must match semantics).
- **F10** — destination cell occupied by another actor rejected (`movement.actor_collision`).
- **F11** — `completeJson` retries with exponential backoff + jitter (`min(1000·2^attempt, 8000)ms`); 429 honors `Retry-After`, capped at 30s.
- **F12** — `FailoverProvider` / `createProviderForTaskWithFailover` exported from `src/llm/index.ts` and wired into `createLlmEngines`: set `LLM_FAILOVER_BACKEND` to wrap the primary provider.
- **F13** — JSON mode default ON (`response_format: json_object` unless `LLM_JSON_MODE=0`).
- **F14** — per-task temperatures `LLM_TEMPERATURE_{PROPOSAL,SELECTION,CONSEQUENCE,SEMANTIC}` (defaults 0.9/0.9/0.2/0.2), falling back to `LLM_TEMPERATURE`.
- **F15** — every lenient consequence repair is logged loudly with an FNV-1a payload fingerprint; malformed `effects` logs a warning and keeps the documented fallback-to-judge behavior.
- **F16** — mock judge gained a common-idiom map (heads over / makes his way / sidles up → moves; mutters / whispers / calls out → speaks); intentional divergence re-documented in the header.
- **F17** — atomic saves (tmp file + rename); rotation keeps newest 100 saves per scenario id.
- **F18** — one deep clone per turn (snapshot taken at turn start, passed into `applyConsequence`); `turn_completed` reuses the final object. Known trade-off: the in-memory `turn_started` log entry aliases the world object that the turn then mutates (the JSONL file is safe — stringified synchronously).
- **F19** — A* open list is a binary heap; `suggestMoveTarget` capped at `MAX_SUGGEST_CANDIDATES = 500` and skips actor-occupied cells.
- **F20** — `scenarioLoader` rejects duplicate `order` ids.
- **F21** — word-boundary (`\b`) matching in `resolveMentionedActorId` and the contact block.
- **F22** — fallback entries carry `NOT_DONE_SENTINEL` (U+10FFFF); streak counting and open-question filtering detect the sentinel, not the text.
- **F23** — `ConsequenceResult.fallback?: boolean`, set on the fallback consequence; `isFallbackConsequence` checks the flag first, narrative equality only as legacy fallback.
- **F24** — in-loop deterministic repair now also fires for no-progress/token-shuffle movement errors (suggest → clamp).
- **F25** — format-collapse addressee stub passes the same perceiver check as `repairMissingAddressee`.
- **F26** — `WorldStore.applyConsequence` accepts and forwards `ApplyConsequenceOptions`.
- **F27** — scenario and save `version` validated against `KNOWN_WORLD_VERSIONS = [1]`; descriptive throw otherwise.
- **F28** — `LLMProvider.complete` accepts `{ signal }`; `withTurnDeadline` aborts on timeout; the signal threads through `ConsequenceEngine.resolve` → `completeJson` → fetch.
- **F29** — JSONL rotation at 10MB, 3 rotations; `NPC_LOG_PROMPTS=0` strips prompt/response bodies (metadata kept).
- **F30** — graphic server binds `127.0.0.1` by default (`HOST` overrides); `NPC_API_TOKEN` gates `POST /action`, `POST /reset`, `GET /logs` via `x-api-token` / `Authorization: Bearer` (401 otherwise).
- **F31** — `usage` (`prompt_tokens`/`completion_tokens`) captured per call, logged per attempt, accumulated as `turnUsage` on `turn_completed`.
- **F32** — accepted limitation: dependent calls can't overlap by construction (judge+consequence already overlap); documented in code, no change.
- **F33** — `LLM_MAX_INPUT_CHARS` (default 60000): world-dump portion truncated with a `[truncated]` note, protected instruction tail kept, warning logged.
- **F34** — "heads/headed/heading to|toward" in both head-verb regexes.
- **F35** — single canonical `maskResumedActivity` in `deterministicSemantics.ts`, shared by `validate/speech.ts`.
- **Q1** — decided: clean turns record the **narrative** in history; fallbacks keep sentinel-marked "Name tried: … (not done)" entries; `getOpenQuestions` updated.
- **Q2** — decided: lazy semantic judge — `classify` only runs when the consequence provides no `effects` (also answers the user-turn cost question: no judge call wasted when effects are present).
- **Q3** — decided by F5 (observer goal-rewrite rejected).
- **Q4** — decided: `tick` documented in `src/types.ts` as a world-global turn counter.
- **Q5** — decided by F1 (token asserts, never downgrades).
- **Q6** — decided by F4 (proximity/permission model for objects).
- **Q7** — decided: strengthened `buildObjectAffordanceNudge` (STRONG/SOFT tiers + PHYSICAL REACH rule) plus object-interaction guidance in the proposal prompt. Phase 3 deletes the nudge entirely: the engine plans manipulation from the action text, so the prompt no longer teaches the patch convention.
