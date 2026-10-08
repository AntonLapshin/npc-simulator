# Experiment 5: 10 user moves, local default models + Laya, text mode, debug on

Date: 2026-10-08. Scenario: `scenarios/office-anton.json` (you play Anton, the new
backend hire; NPCs Tanya — former Sixt coworker who referred you — and Dana, the
recruiter). Third run on this scenario (Exp-3/Exp-4 were the first two), so directly
comparable: same roster, same Laya-max env, same reactive-user driver shape. Setup: all
four engines on local Ollama, documented default models
(`OLLAMA_MODEL=fluffy/l3-8b-stheno-v3.2`,
`LLM_SIMPLE_MODEL=huihui_ai/llama3.2-abliterate:3b`, both tiers `ollama`), debug trace
captured (`NPC_LOG_PROMPTS=1`, `LLM_JSON_MODE=1`), and Laya fully on:
`LAYA_MODE=dynamic LAYA_SELECTION=1 LAYA_JUDGE=1 LAYA_TRIAGE=1 LAYA_SALIENCE=1 LAYA_PLANNER=1
LAYA_PLAUSIBILITY=1`, `LAYA_URL=http://127.0.0.1:8000` (laya-serve on CUDA, checkpoints
loaded; pre-run `diagnose:ai:live` 18 passed / 0 failed, laya choice probe PASS p=0.99).
Driver: `runTurn` per turn with reactive user text (waited for my turn, then acted on
circumstances each round — greetings, questions, coffee, desk-seeking, lounge); 1 user
turn + NPC turns until control returns (the same engine path `src/ui/text/textUi.ts`
uses — the text UI only forwards action text to `runTurn` and renders history, so a
`runTurn` driver with `NPC_LOG_PROMPTS=1` is the text-mode debug run without the
readline wrapper); state in `saves/exp5-laya-anton.json`, single trace in
`logs/exp5_laya.jsonl` (session `exp5_laya`, 1195 entries), driver `exp5-round.ts`
(per round: `npx tsx ./exp5-round.ts '<action>' saves/exp5-laya-anton.json exp5_laya`
with the env overrides above). Note: `.env` still asks for `OLLAMA_MODEL=qwen3:14b`,
which is NOT pulled locally (only the two recommended models are); the driver overrides
to the documented defaults (Exp-2 S10 / Exp-3 S9 / Exp-4 S8, still open — fifth run).
30 turns total, ticks 0–29, 411 s engine span (≈13.7 s/turn, fastest Anton-scenario run;
no blowups).

## How the scenario unfolded (user moves 1–10, ticks 0–29)

1. Greet room, introduce self, walk toward Tanya's desk → user **applied**
   (`Anton says hello to Tanya at her desk`, moved (16,2)→(11,5)) but the greeting quote
   was paraphrased away (no quoted speech kept). Tanya **fallback** (first-person
   test-plan glance). Dana **applied with repair** (`Dana approaches Tanya`, stepped
   (15,11)→(14,11) — honest 1-cell step, best Dana turn of the run).
2. Walk closer to Tanya, ask what she's working on + what to tackle first → user
   **applied** ((11,5)→(7,7), now adjacent) but role-reversed prose: `Anton asks if Tanya
   has her first task` (I asked what *I* should tackle; narrative flips the newcomer
   role onto Tanya). Tanya **fallback** (first-person `walk over to Anton's desk to
   introduce myself properly` — incoherent: she knows Anton from Sixt). Dana
   **fallback** (first-person `walk over to Anton`).
3. Stay put, ask about her morning/test plan → user **fallback** (stationary speech
   unsatisfiable again — Exp-4 moves 7–8 class). Tanya **fallback** (mug-of-tea offer,
   a new intent at least). Dana **applied-ish partial** (`approaches the desk where
   Tanya sits, setting her laptop open… She asks, 'Can you let me know…'` — teleports
   (14,11)→(10,7), 6+ cells; `her`/`She` for Dana (he/him); laptop from thin air).
4. Turn to Dana, ask what he's hiring for → user **applied with contact invention**:
   `Anton shakes Tanya's hand firmly. Anton says "Hi Dana, I'm Anton… What roles are you
   hiring for right now?"` (quote kept, but handshake materialized while addressing
   Dana). Tanya **liveness floor** (`holds position, taking in the room` — 3-fallback
   streak trips the floor). Dana **fallback** (first-person laptop-turn).
5. Walk to coffee machine, pour coffee → user **fallback** (cross-room walk + pour,
   repairs vetoed). Tanya **fallback** (first-person laptop-setup offer, 1st of 3).
   Dana **applied** (`sits at her desk with a laptop` — he is at (10,7) near Tanya, not
   his desk; `her` again; laptop from thin air).
6. Walk to ANTON-sign desk, sit, open laptop → **triple fallback** (sit+move+object
   combo unsatisfiable; handshake attractor again for Tanya; Dana candidate-skim, 1st
   of 2 identical failures).
7. Pure speech: ask to see the test plan → user **applied** (quote kept verbatim) with a
   stub prefix (`Anton greets Tanya and asks about her first task` — the role-reversal
   stub again). Tanya **fallback** (same laptop-setup offer, 2nd time). Dana
   **fallback** (same candidate-skim, 2nd time — ban threshold not triggered, S8).
8. Step back, give Tanya space, no rush → user **fallback** (even a half-step + speech
   dies). Tanya **liveness floor** (2nd time). Dana **applied but corrupt**:
   `Tanya and Dana turn to look at Anton as he enters the office` — observer-as-subject
   (Tanya moved on Dana's turn), stale by 24 ticks (Anton entered at tick 0), stepped
   (10,7)→(9,7) while narrating a look.
9. Walk to lounge sofa, look around → user **applied with stale prose + teleport**:
   (7,7)→(4,12) with narrative `Anton enters the office.` (5-cell jump; drops the
   lounge entirely). Tanya **fallback** (handshake greeting `as you approach` —
   second-person leak). Dana **fallback** (asks about Anton's `open laptop` — he has
   `prop:null`).
10. Pure speech: thanks + set up laptop → user **fallback** (the run's most punishing
    false negative — see S4). Tanya **fallback** (walk-to-Anton + setup question, 3rd
    laptop-setup variant). Dana **fallback** (glances at Anton's laptop screen — same
    phantom laptop).

Net world mutation after 30 turns: Anton (16,2)→(11,5)→(7,7)→(4,12) — reached Tanya's
side by tick 3, froze there for 20 ticks (moves 5/6/8 all died), then teleported to the
lounge on a stale `enters the office` narrative; Tanya never moved (8,7) all 30 turns
while `state` still says sitting (true this time — she is on her chair cell); Dana
(15,11)→(14,11)→(10,7)→(9,7) — abandoned his desk at tick 8 and never went back, `state`
reads `at Tanya's chair` while standing adjacent to it; **zero scene-object changes**
(39 objects byte-identical, fifth run in a row); props stayed honest this run (Anton
null, Tanya laptop, Dana null throughout — no thin-air props, a first); memories
compound numerically (Anton 7, Tanya 4, Dana 5) but see M8; emotions *partially
unfroze* (Anton `nervous`→`pleased` at tick 9, Dana `stressed`→`focused` — first change
across all five runs; Tanya `focused` × 30); `state` labels still weak (`near the
lounge sofa` with article, `at Tanya's chair` for standing adjacent, S5).

NPC reasonableness: Tanya never answered three direct questions (all answering turns
fell back, liveness-floored twice, or offered laptop-setup instead); Dana never answered
Anton either, drifted gender (`her`/`She` ×2), and banked two corrupt narratives as
canonical (ticks 8, 23); the handshake was narrated once without ever being grounded
(tick 9). Bright spots: Dana's tick-2 approach (honest 1-step), the two liveness-floor
turns (honest silence instead of fiction), and zero invented people — the first
three-run streak of roster discipline.

## Turn statistics (from `logs/exp5_laya.jsonl`, history cross-checked)

| outcome | ticks | count | Exp-4 | Exp-3 |
|---|---|---|---|---|
| applied (narrative kept, no marker) | 0, 2, 3, 8, 9, 14, 18, 23, 24 | 9/30 (30%) | 12/30 (40%) | 5/30 (17%) |
| partial-applied, liveness floor | 10, 22 | 2/30 (7%) | 4/30 (13%) | 12/30 (40%) |
| fallback `tried: … (not done)` | everything else | 19/30 (63%) | 14/30 (47%) | 13/30 (43%) |

Totals: 85 `validation_failed` records (664 coded gate hits), 56 `retry_started`
(17 `retry_aborted`), 80 `consequence_completed` vs 76 `consequence_failed`,
18 `consequence_lenient_repair`, 5 `movement_repaired` vs **8 `movement_repair_vetoed`**
+ 6 `movement_repair_resteered`, 24 `salvage_best_attempt` / 26 `salvage_evaluated`
(3 `salvage_prose_synthesized`, 2 `salvage_quote_reinserted`,
1 `salvage_accept_gate_rejected`), `selection intent_banned` 1 + `selection_substituted`
1, `proposal_failed` 4, `semantic_completed` (chat judge) **0** (86 `semantic_resolved`
via Laya judge + 86 disagreements, zero chat calls). User turns: 5 applied / 5 fallback
(ticks 0,3,9,18,24 applied; 6,12,15,21,27 fallback) — user turns remain the highest-
variance class and get no intent-narrowing by construction.

Top failure codes (664 hits): `movement.no_position_change` 89,
`movement.declared_without_patch` 66, `movement.narrated_without_patch` 57,
`speech.dropped_words` 47, `turn_discipline.acting_actor_not_patched` 43,
`turn_discipline.observer_moved` 35 + `narrative.observer_as_subject` 34 (observer-as-
subject complex: 69 hits), `turn_discipline.observer_state_change` 34,
`speech.question_dropped` 26, `action.stand_no_pose` 23, `action.pour_no_patch` 20,
`object.unknown_id` 18, `actor.blocked_position` 17, `narrative.unknown_actor` 14,
`speech.no_speech_rendered` 14, `movement.unexpected_move` 12,
`speech.invented_dialogue` 11, `narrative.placeholder` 10, `state.prop_state_mismatch`
10, `object.too_far` 9, `contact.too_far` 7 + `action.sit_no_pose` 7.

### Laya metrics

| metric | Exp-5 | Exp-4 | Exp-3 |
|---|---|---|---|
| fallback rate | 63% (19/30) | 47% | 43% |
| applied rate | 30% (9/30) | 40% | 17% |
| judge chat-LLM calls | **0** | 0 | 0 |
| `laya.intent_decided` | 20/20 NPC turns | 20/20 | 20/20 |
| `planner_diagram_resolved` | 20/20 | 20/20 | 20/20 |
| `plausibility_scored` | 80 events | 85 | 92 |
| `salience_scored` / `triage_applied` | 11 / 7 | 16 / 9 | 17 / 12 |
| `intent_banned` | **1** (tick 22, `other\|anton`) | 1 | 0 |
| `liveness_applied` | **2** (ticks 10, 22) | 1 | 0 |
| `accept_gate_rejected` | **1** (tick 27 — FALSE POSITIVE, see S4) | 1 (true +) | 1 (true +) |
| `movement_repair_vetoed` / `resteered` | **8 / 6** | 15 / 0 | n/a |
| `proposal_failed` | 4 (Dana turns) | — | — |
| turns/hour | ~260/hr (≈13.7 s/turn) | ~240/hr | ~170/hr |

## A. Model issues (small-model hallucination and misses, not engine bugs)

- **M1 — First-person NPC action text persists.** Proposal emits `I glance…`, `I stand
  up…`, `I turn my laptop…`, `I offer…`, `I open…`, `I slide…` for NPC turns (10+
  occurrences across ticks 1, 4, 5, 7, 11, 13, 16, 19, 26, 28, 29); consequence echoes
  the `I` into canonical history (`Dana tried: I turn my laptop…`). Third run in a row.
  Validator has no voice gate, so diary entries stand as world history (S4 fix below).
- **M2 — Quote/question dropping + role-reversal stubs.** `dropped_words` 47,
  `question_dropped` 26, `no_speech_rendered` 14: three direct questions to Tanya never
  got quoted answers; two applied user turns (ticks 3, 18) kept the quote only by
  prepending a stub (`Anton asks if Tanya has her first task` — I asked what *I* should
  do first; the newcomer role flips onto Tanya). `salvage_quote_reinserted` fired twice
  (ticks 9, 18) and is the only reason those quotes survived.
- **M3 — Observer-as-subject persists (69 hits).** Tick 23 (`Tanya and Dana turn to
  look…` on Dana's turn — rejected nowhere, applied as canonical); tick-23 repair patch
  implants `anton` thoughts on Dana's turn; tick-0/2 thought implants write `tanya`
  thoughts on Anton's turn. The model treats the viewpoint character as the most
  writable actor. Laya never reads generative output, so it cannot see this.
- **M4 — Contact/handshake is unrenderable for this tier.** `contact.too_far` 7 +
  `narrative_drops_contact` 6: tick 9 narrates `shakes Tanya's hand firmly` while
  addressing Dana with no contact patch; ticks 16/25 select handshake-intros that die
  (`action.stand_no_pose` 23 rides along — the tier narrates standing/walking without
  patching it). Selection loves social wording the consequence tier cannot ground.
- **M5 — Locomotion magnitude delusion continues.** Teleports for look/sit/review
  actions (tick 8: (14,11)→(10,7); tick 24: (7,7)→(4,12)), `blocked_position` 17,
  `not_closer_actor/object` 11, `over_step_cap` 3; attempt-1 positions usually missing
  (`no_position_change` 89, `declared_without_patch` 66). The model has no feel for the
  20×20 grid scale.
- **M6 — Object interaction still unsatisfiable.** `pour_no_patch` 20, `pickup_no_patch`
  3 + `pickup_no_patch` (grounding) 2, `sit_no_pose` 7, `sip_no_prop` 4, `pour_too_far`
  6: coffee pours, laptop opens/skims, mug sips, chair sits — 18 nonempty
  `objectPatches` were *proposed* in `consequence_completed` outputs yet **zero**
  applied in the world (all stripped by validation/repair). Fifth run with zero applied
  object patches. Props stayed honest this run (nothing materialized), which only
  sharpens the point: the tier can neither ground objects nor (this time) fake them.
- **M7 — Role/social incoherence (new examples).** Tanya re-introduces herself to a
  former Sixt coworker (tick 4); Tanya asks nothing while Anton asks everything, then
  history claims *he* asked about *her* first task; Dana genders drift (`her`/`She`,
  ticks 8/14); Dana asks about Anton's `open laptop` / `laptop screen` twice (ticks 26,
  29) while Anton has `prop:null`; tick-25 Tanya greeting leaks second person
  (`as you approach`).
- **M8 — Memory compounding pollutes semantically.** Counts rose (7/4/5) but entries
  are stubs (`Anton: Anton says hello to Tanya at her desk`), role-reversed lines
  (ticks 3/18), and corrupt canonicals (`Tanya and Dana turn to look at Anton as he
  enters the office` is now a permanent Dana "memory"). Deterministic append preserves
  fiction faithfully.
- **M9 — Roster discipline: third clean run.** Zero invented people (`leon`/`stranger`-
  class absent); `unknown_actor` 14 / `actor.unknown_id` 6 / `object.unknown_id` 18
  hits were all rejected at patch level. (`narrative.unknown_actor` also fired once on
  the word `Consequence` — that one is the engine's fault, S4.)

What the model did *well*: stationary silent beats render when nothing is asked of them
(tick-2 honest 1-step approach, liveness silences); thoughts mostly in-character;
proposal breadth sane; perceiver gating correct throughout; zero roster invention.

## B. Simulation issues (engine/validator/repair bugs — model-independent)

- **S1 — Fallback worst yet (63%) despite full Laya.** Exp-2's 19% has not replicated
  on any Anton-scenario run (43%, 47%, now 63%) on the same Laya-max config. Same
  mechanism as Exp-3 S1 / Exp-4 S1: selection picks handshake/show-test-plan/sit/pour/
  skim actions the consequence tier cannot render; Laya scores them plausibly; the
  validator kills all attempts. Generation-tier variance dominates any decision-layer
  delta. Plus this run's sample: 5/10 user turns fell back, and user turns bypass every
  Laya gain *and* the capable tier is a no-op here (`LLM_USER_CAPABLE_TIER=1` with both
  tiers on the same local 8B logs `user_capable_tier_noop` — Exp-4 item 2 verified live).
- **S2 — Veto-without-alternative still freezes the avatar (Exp-4 S2, still open).**
  8 `movement_repair_vetoed` + 6 `resteered`: Anton stuck at (7,7) for 20 consecutive
  ticks (moves 5/6/8 died with zero displacement). The resteer path (new since Exp-4)
  fires — 6 capped toward-steps — but none of them landed a legal move on coffee/desk/
  lounge walks either. A veto/resteer without a *committed* legal fallback is still a
  fallback machine. Fix remains: when repair is vetoed, commit a capped step *toward*
  the named target (or downgrade to honest stationary prose) instead of burning the
  remaining attempts.
- **S3 — Corrupt narratives still pass as canonical (Exp-2 S2 / Exp-3 S3, still open,
  now with three fresh receipts).** Tick 8 (6-cell teleport + wrong pronouns + phantom
  laptop), tick 23 (observer-as-subject + 24-tick-stale `enters`), tick 24 (5-cell
  teleport under a stale `enters the office`) — all applied with patches intact, no gate
  fired on the final attempt. Regression tests still missing: stay-action→teleport must
  reject; non-entrant→`enters the office` must reject; observer-as-subject must reject
  on the *accept* path, not just mid-retry.
- **S4 — NEW (false positive, worst of the run): the accept gate rejected a PERFECT
  salvage because it scanned the wrong field.** Tick 27: candidate narrative
  `Anton says "Thanks both for making me feel welcome. I'm going to get my laptop set
  up now."` — verbatim quote preservation, correct subject, no movement claimed — was
  rejected with `[narrative.unknown_actor] narrative names unknown actor "Consequence"`:
  the word came from the *reasoning* string (`Fallback due to Consequence Engine
  failure`), not the narrative. The gate must scope name-checks to `narrative` (+
  quotes), never to `reasoning`. Cost: a pure-speech user turn that did everything
  right fell back. Fix: field-scope the check; add this exact case as a regression
  test (good-quote salvage with engine-worded reasoning must pass).
- **S5 — State/pose labels still weak (Exp-1 S8 / Exp-3 S6 / Exp-4 S5, still open).**
  `near the lounge sofa` (article stacking), `at Tanya's chair` for Dana standing
  adjacent at (9,7) while the chair is at (8,7), `pose:sit` for Dana mid-room. Template
  state labels from nearest *owned* landmark; require/refresh `state` on every x/y
  change; validate `pose:sit` against chair cells.
- **S6 — Zero applied object patches, fifth run (Exp-3 S6 / Exp-4 S6 class).** 18
  nonempty `objectPatches` proposed, 0 applied. Either make object-wording
  deterministically repairable (sip→`prop:cup`, typing→`prop:laptop`, pour→roster
  `coffee_machine`+`coffee_mug` grounding) or stop selecting object verbs the tier
  cannot ground (feeds S1). Measure applied-objectPatches per run until nonzero.
- **S7 — Retry divergence unchanged (Exp-1 S7, fifth run).** 56 retries across 25/30
  ticks; attempt 1 systematically best; 17 `retry_aborted` (hard-error counts grew:
  e.g. tick 7 went 1→4→8 errors). Best-attempt salvage (24 evaluations) picks well but
  the 4× latency is still paid. Early-abort on growing hard-error counts (Exp-3 item 9,
  still open).
- **S8 — Intent-ban keys still too narrow (Exp-4 S3, still open).** The laptop-setup
  offer failed 3× (ticks 13, 19 + variants) with no ban; only tick 22 banned
  (`other|anton`) and immediately substituted a near-identical glance-at-test-plan
  intent that also failed. Normalize keys (case/leading-pronoun/verb-form/object-
  strip) before counting, and ban the *cluster*, not the string.
- **S9 — `.env` default `OLLAMA_MODEL=qwen3:14b` still not installed (Exp-2 S10,
  fifth run).** Every `diagnose-ai:live` warns; newcomers following `.env` get a broken
  default. Align `.env`/`.env.example` with what `setup:ollama` pulls.
- **S10 — Salience/triage thresholds unvalidated (Exp-3 S10 / Exp-4 S9).** Memories
  still append stubs and corrupt canonicals; emotions half-unfroze (Anton/Dana changed —
  progress, but no evidence it was the salience gate vs lenient-repair emotion writes).
  Measure memory-precision (entries paraphrasing real turns vs stubs/fiction) before
  tuning.

What the simulation did *well*: validator rejected 100% of unknown-id patches (roster
discipline holds at the patch level); `movement_repair_resteered` is a live new path
(6 events — Exp-4 S2's veto now steers before it vetoes); quote-reinsert saved 2 speech
turns; liveness floor fired twice instead of a 5th consecutive fallback; intent-ban +
substitution fired once end-to-end; `proposal_failed` retried cleanly (4 events, Dana
turns, no crash); fastest Anton run yet with zero blowups; honest
`(not done)`/`(partial)` history throughout.

## C. Action items

Model-side (prompts/routing, no validator changes):
1. Third-person discipline line in proposal + consequence prompts with a negative `I …`
   example, repeated per-NPC-turn (M1; the leak is NPC-specific, third run).
2. Route *user-turn* consequence through a genuinely capable tier when available, and
   keep the loud `user_capable_tier_noop` warning when both tiers resolve identically
   (S1; user turns are 5/10 failed here and bypass every Laya gain by construction).
3. Canonical speech-turn form + exempt fully-spoken actions from `echoes_action`
   (Exp-3 S4, still open; tick-27's perfect quote died to S4 instead, but pure-speech
   moves 3/8/10 died to rendering all the same).
4. Renderability-matched proposals: contact/object verbs must carry grounding
   (distance ≤2, roster object id) or not be suggested (feeds S1/S6; M4/M6).

Simulation-side (ordered by impact):
5. **S4 first (new, cheapest, reverses a false negative)**: scope the accept-gate
   name/actor checks to `narrative` (+ quoted speech), never `reasoning`; add the
   tick-27 regression case (good-quote salvage + engine-worded reasoning must pass).
6. **S2**: vetoed/resteered repair must *commit* a constructive alternative — capped
   step toward the named narrative target, else honest stationary downgrade; never
   veto-then-retry-to-fallback (8 vetoes + 6 resteers still froze the avatar 20 ticks).
7. **S3**: full gate-suite re-check after any patch-stripping/salvage/prose-synthesis
   accept; add the three regression tests (stay→teleport, stale `enters the office`,
   observer-as-subject on the accept path). Sixth run open.
8. **Voice gate (Exp-4 S4, still open)**: fail fast on first-person self-reference in
   NPC action text / consequence narrative (targeted retry hint); fixes M1 at source.
9. **S8**: normalize intent-ban keys (case/leading-pronoun/verb-form/object-strip) and
   ban intent *clusters*; verify ticks-13/19/22 ban after 2 consecutive failures.
10. **S5**: template `state` labels from nearest owned landmark; require/refresh `state`
    on every x/y change; validate `pose:sit` against chair cells.
11. **S7**: early-abort retries when hard-error count grows two attempts in a row
    (best-attempt selection already landed — stop paying 4× latency for divergence).
12. **S6**: deterministic prop stubs for object verbs (sip→`prop:cup`, typing→
    `prop:laptop`) or roster mug/laptop grounding; measure applied-objectPatches (still
    0 after five runs).
13. **S9/S10**: align `.env` model default with `setup:ollama`; measure
    memory-precision and bind the salience gate; confirm what unfroze emotions (gate vs
    repair write).

## D. Laya verdict

*Does utilizing the decision model more give better quality for local small LLMs?*
**Decisions: yes, saturated (again). Rendering: no — and Exp-5 finds the binding
constraint has moved into the NOS (new failure: the guardrail itself).**

- The decision layer remains fully utilized and reliable: 20/20 intents, 20/20 planner
  diagrams, 80 plausibility scores, 0 chat-judge calls, intent-ban + substitution +
  liveness + resteer + accept-gate all fired live. Nothing left to delegate in choosing.
- End-to-end fell further (63% fallback vs 47%/43%/19%) on the identical Laya-max
  config — variance across runs/scenarios again exceeds any Laya-attributable delta:
  generation-tier variance dominates. New mechanism this run: the accept gate — the
  last line of defense — false-positived on a *perfect* quote-preserving salvage
  (S4), converting the run's best-behaved user turn into a fallback. Guardrails that
  scan the wrong field trade true negatives for false positives.
- Counter-evidence to log (honest): fastest run yet (13.7 s/turn), props stayed honest
  (no thin-air materialization for the first time), emotions half-unfroze, resteer is a
  live new repair path, and roster discipline held a third straight run. The floor is
  rising even as the ceiling (fallback rate) got worse — progress metric must stay on
  *task completion* (did Anton reach the coffee machine / his desk / the lounge?) plus
  *history honesty*, not fallback-rate alone: by task completion, moves 5/6/7/8/10
  failed even when the history stayed mostly honest.
- Practical consequence (extends Exp-3/Exp-4): stop pushing decisions onto Laya; the
  next quality dollar is (a) field-scoped accept gates (S4), (b) constructive movement
  repair (S2), (c) voice grounding + quote preservation — plus the task-completion eval
  harness, since fallback-rate now punishes vetoes that freeze the world and gates that
  reject good salvages.

Repro: `saves/exp5-laya-anton.json`, `logs/exp5_laya.jsonl`, driver `exp5-round.ts`
(per round: `LLM_BACKEND=ollama LLM_SIMPLE_BACKEND=ollama
OLLAMA_MODEL=fluffy/l3-8b-stheno-v3.2 LLM_SIMPLE_MODEL=huihui_ai/llama3.2-abliterate:3b
LAYA_MODE=dynamic LAYA_SELECTION=1 LAYA_JUDGE=1 LAYA_TRIAGE=1 LAYA_SALIENCE=1
LAYA_PLANNER=1 LAYA_PLAUSIBILITY=1 LAYA_URL=http://127.0.0.1:8000 NPC_LOG_PROMPTS=1
LLM_JSON_MODE=1 LLM_USER_CAPABLE_TIER=1 npx tsx ./exp5-round.ts '<action>'
saves/exp5-laya-anton.json exp5_laya`). Laya: `laya-serve` on CUDA, live during the
run. User texts (10, in order): greet + walk to Tanya; closer + work/first-task
question; stay + morning/test-plan question; turn to Dana + hiring question; coffee-
machine walk + pour; ANTON-desk walk + sit + laptop; pure speech test-plan request;
half-step back + no-rush; lounge-sofa walk + look; pure speech thanks + laptop setup.
