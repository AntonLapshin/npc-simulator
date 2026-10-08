# Experiment 4: 10 user moves, local default models + Laya, text mode, debug on

Date: 2026-10-08. Scenario: `scenarios/office-anton.json` (you play Anton, the new
backend hire; NPCs Tanya — former Sixt coworker who referred you — and Dana, the
recruiter). Second run on this scenario (Exp-3 was the first), so directly comparable:
same roster, same driver shape, same Laya-max env. Setup: all four engines on local
Ollama, documented default models (`OLLAMA_MODEL=fluffy/l3-8b-stheno-v3.2`,
`LLM_SIMPLE_MODEL=huihui_ai/llama3.2-abliterate:3b`, both tiers `ollama`), debug trace
captured (`NPC_LOG_PROMPTS=1`, `LLM_JSON_MODE=1`), and Laya fully on:
`LAYA_MODE=dynamic LAYA_SELECTION=1 LAYA_JUDGE=1 LAYA_TRIAGE=1 LAYA_SALIENCE=1 LAYA_PLANNER=1
LAYA_PLAUSIBILITY=1`, `LAYA_URL=http://127.0.0.1:8000` (laya-serve on CUDA, checkpoints
loaded). Driver: `runTurn` per turn with reactive user text (acted on circumstances each
round — greetings, questions, coffee, desk-seeking, lounge); 1 user turn + NPC turns
until control returns; state in `saves/exp4-laya-anton.json`, single trace in
`logs/exp4_laya.jsonl` (session `exp4_laya`, 1265 entries), driver `exp4-round.ts`
(same shape as Exp-3's). Note: `.env` still asks for `OLLAMA_MODEL=qwen3:14b`, which is
NOT pulled locally (only the two recommended models are); the driver overrides to the
documented defaults (Exp-2 S10 / Exp-3 S9, still open — fourth run). 30 turns total,
ticks 0–29, ~7:21 engine log span (≈15 s/turn, no blowups).

## How the scenario unfolded (user moves 1–10, ticks 0–29)

1. Greet room, introduce self, walk toward Tanya → user **partial** (quote reinserted by
   salvage, moved (16,2)→(11,5)) but narrative invents a `whiteboard` + `diagram` that do
   not exist. Tanya **partial** (help offer, quote reinserted). Dana applied (`notices the
   new employee`). Best round of the run.
2. Walk closer to Tanya, ask what she's working on + what to tackle first → user
   **applied**: (11,5)→(7,7), quote kept — but narrative says `walks over to Dana's desk`
   while landing at Tanya's chair (wrong-desk prose). Tanya applied (`glances at her
   laptop and Anton` — direct question NOT answered). Dana **fallback** (first-person
   `I point to one of the open laptop tabs…`, 8 cells away from Anton).
3. Stay put, ask about her morning/test plan → user **fallback** (stationary speech
   unsatisfiable again). Tanya **partial** via format-collapse salvage (thought-like prose,
   still no answer). Dana **fallback** (first-person `I gesture…` again).
4. Turn to Dana, ask what he's hiring for → user **applied** (`Anton opens the laptop` —
   laptop prop materializes from thin air; quote kept). Tanya **fallback** (first-person
   `I put down the laptop and walk over to Anton to introduce myself properly` —
   incoherent: she knows Anton from Sixt). Dana **applied** but corrupt-ish: `Dana: Dana:
   I glance up…` (doubled-name prefix + first-person leak into canonical history).
5. Walk to coffee machine, pour coffee → user **fallback** (zero movement; repairs
   vetoed, see S2). Tanya **fallback** (first-person test-plan-showing, 1st of 3
   identical failures). Dana **applied** (`looks at Anton's laptop` from across the room).
6. Walk to ANTON-sign desk, sit, open laptop → user **fallback** (sit+move+object combo
   unsatisfiable; repairs vetoed). Tanya **fallback** (same test-plan intent, 2nd time).
   Dana **applied** (`asks Tanya about her morning` — reasonable, but never answers Anton).
7. Pure speech: ask to see the test plan → user **fallback** (speech-only turn dies).
   Tanya **liveness floor** (`holds position, taking in the room` — the Exp-5 liveness
   machinery fires for the first time this scenario). Dana **fallback**.
8. Step back, give Tanya space, no rush → user **fallback** (4th user fallback in a row).
   Tanya **fallback** (same test-plan intent, 3rd time — ban threshold not triggered, S3).
   Dana **applied** (`asks Tanya about her first task`).
9. Walk to lounge sofa, look around → user **fallback** (blocked_position → veto → dead).
   Tanya **applied** (`asks Anton for help with setting up her computer` — role-reversed:
   the experienced QA asks the first-day hire for computer help). Dana **applied** with
   drift: `sits down and opens her laptop` — moves (15,11)→(14,11) on a sit action, `her`
   for Dana (he/him in scenario), laptop from thin air.
10. Pure speech: thanks + set up laptop → user **applied** (`reaches for the coffee mug on
    his desk, taking a sip` — he is at Tanya's chair, not his desk; mug from thin air;
    quote kept). Tanya **fallback** (walks to Anton's desk to move his ANTON sign —
    bizarre stage business). Dana **applied** (`pours coffee from the coffee maker into a
    dana_mug` — pour rendered with zero movement to the machine, no object patch).

Net world mutation after 30 turns: Anton (16,2)→(7,7) — stuck there since tick 3 despite
moves 5/6/9 targeting the coffee corner, his own desk, and the lounge; Tanya never moved
(8,7); Dana (15,11)→(14,11) — one unexplained southward step while "sitting";
**zero scene-object changes** (fourth run in a row); props mutate from thin air (Anton
null→laptop→cup, Dana null→laptop→cup, no objectPatches ever applied); memories compound
numerically (Anton 6, Tanya 8, Dana 8) but see M8; emotions frozen (Anton `nervous` × 30,
Tanya `focused` × 30, Dana `stressed` × 30); `state` strings are adjacent-cell labels
(`at Tanya's chair` while standing, `at Dana's chair` while not on the chair cell).

NPC reasonableness: Tanya never answered three direct questions (all answering turns fell
back or salvaged to glances); Dana never answered Anton either, but his ambient beats
(temple-rub equivalents: notices, nods, asks Tanya about her morning) stayed in-character
for a stressed recruiter; two corrupt-ish narratives passed as canonical (ticks 11, 27).
Bright spots: Dana's ambient turns, Tanya's help offer (move 1), the liveness-floor turn.

## Turn statistics (from `logs/exp4_laya.jsonl`, history cross-checked)

| outcome | ticks | count | Exp-3 | Exp-2 |
|---|---|---|---|---|
| applied (incl. repaired) | 2, 3, 4, 9, 11, 14, 17, 23, 25, 26, 27, 29 | 12/30 (40%) | 5/30 (17%) | 13/21 (62%) |
| partial-applied, narrative kept w/ notes | 0, 1, 7, 19 | 4/30 (13%) | 12/30 (40%) | 4/21 (19%) |
| fallback `tried: … (not done)` | 5, 6, 8, 10, 12, 13, 15, 16, 18, 20, 21, 22, 24, 28 | 14/30 (47%) | 13/30 (43%) | 4/21 (19%) |

Totals: 86 `validation_failed` records (top codes below), 63 `retry_started`
(8 `retry_aborted`), 85 `consequence_failed` vs 83 `consequence_completed`,
14 `consequence_lenient_repair`, 1 `movement_repaired` vs **15 `movement_repair_vetoed`**,
23 `salvage_best_attempt` / 28 `salvage_evaluated` (5 `salvage_quote_reinserted`,
3 `salvage_prose_synthesized`, 1 `format_salvage_applied`, 1 `accept_gate_rejected`),
`selection_failed` 7 (all recovered → `selection_completed` 20/20), `semantic_completed`
(chat judge) **0**. User turns: 3 applied / 1 partial / 6 fallback — user turns remain
the worst turn class and get no intent-narrowing by construction.

Top failure codes: `movement.no_position_change` 48, `movement.declared_without_patch` 33,
`speech.dropped_words` 32, `movement.narrated_without_patch` 28, `pour_no_patch` 26,
`turn_discipline.observer_moved` 26, `narrative.observer_as_subject` 24,
`observer_state_change` 22, `acting_actor_not_patched` 17, `speech.no_speech_rendered` 15,
`speech.question_dropped` 13, `actor.blocked_position` 12, `narrative.unknown_actor` 9.

### Laya metrics

| metric | Exp-4 | Exp-3 | Exp-2 |
|---|---|---|---|
| fallback rate | 47% (14/30) | 43% | 19% |
| applied rate | 40% (12/30) | 17% | 62% |
| selection format failures | 7 (all recovered) | 0 | 4 (recovered) |
| judge chat-LLM calls | **0** (91 `semantic_resolved` via Laya judge) | 0 | 0 |
| `laya.intent_decided` | 20/20 NPC turns | 20/20 | 14/14 |
| `planner_diagram_resolved` | 20/20 | 20/20 | 0 |
| `plausibility_scored` | 85 events | 92 | 0 |
| `salience_scored` / `triage_applied` | 16 / 9 | 17 / 12 | 0 / 15 |
| `intent_banned` (Exp-3 S2 fix) | **1** (tick 19, handshake-intro) | 0 | — |
| `liveness_applied` (Exp-5 floor) | **1** (tick 19) | 0 | — |
| `accept_gate_rejected` | **1** (tick 11, observer-as-subject caught) | 1 | — |
| `movement_repair_vetoed` (Exp-3 S5 fix) | **15** | n/a | — |
| turns/hour | ~240/hr engine time (≈15 s/turn, no blowups) | ~170/hr | ~170–250/hr |

## A. Model issues (small-model hallucination and misses, not engine bugs)

- **M1 — NEW dominant voice defect: first-person NPC action text.** Proposal emits
  `I point…`, `I gesture…`, `I put down the laptop…`, `I walk over to Anton's desk…`
  for NPC turns (6+ occurrences); consequence echoes the `I` into canonical narrative
  (`Dana: Dana: I glance up…`, doubled-name prefix included). Third-person discipline
  holds for user turns but collapses for NPCs. Validator has no voice gate, so these
  read as diary entries in world history.
- **M2 — Quote/question dropping persists** (`dropped_words` 32, `question_dropped` 13,
  `no_speech_rendered` 15): three direct questions to Tanya never got quoted answers;
  pure-speech user turns (moves 7, 8) fell back with zero speech rendered. Mitigation
  note: `salvage_quote_reinserted` fired 5 times and saved moves 1–2 — the deterministic
  reinsert is the only reason the opening round worked.
- **M3 — Observer-as-subject persists** (50 hits: moved-observer 26 + observer-subject
  24) but the accept-gate caught one live (tick 11 `Anton and Tanya welcome Dana` on
  Dana's turn — rejected, Dana fell back instead). Net improved vs Exp-3 (2 leaks).
- **M4 — Roster discipline: best run yet.** Zero invented people (`leon`/`stranger`-class
  absent — first clean run across Exp-1–4) and no invented rooms. Only landmark drift:
  `whiteboard`+`diagram` (tick 0), `coffee maker` prose for `coffee_machine` (tick 29),
  `his desk` for a mug sipped at Tanya's chair (tick 27). `unknown_actor` 9 / `unknown_id`
  3 hits were all rejected at patch level.
- **M5 — Locomotion magnitude delusion continues.** `blocked_position` 12,
  `over_step_cap` 5, `not_closer_actor/object` 15: lounge/sofa walks from (7,7) and
  cross-room coffee walks never produce legal step patches; attempt-1 positions are
  usually missing entirely (`no_position_change` 48, `declared_without_patch` 33).
- **M6 — Object interaction still unsatisfiable, now led by `pour_no_patch` (26).**
  Coffee pours, laptop opens, sign moves, mug sips: zero `objectPatches` applied in 30
  turns (fourth run in a row); props instead materialize (`prop:laptop`, `prop:cup`
  from thin air, ticks 9/26/27/29).
- **M7 — Role/social incoherence (new examples).** Tanya re-introduces herself to a
  former Sixt coworker (tick 10); Tanya asks the first-day hire for computer help
  (tick 25); Tanya rearranges Anton's desk sign unasked (tick 28); Dana genders drift
  (`opens her laptop`, tick 26). Small-model social grounding is fragile beyond one
  silent beat.
- **M8 — Memory compounding pollutes semantically.** Counts rose (6/8/8) but entries
  include doubled prefixes (`Dana: Dana: I glance…`), stubs (`Tanya glances at her
  laptop and Anton`), and role-reversed lines — all now permanent "memories".

What the model did *well*: stationary silent/ambient beats (Dana's notices/nods/questions
to Tanya); thoughts mostly in-character; proposal breadth sane; perceiver gating correct;
zero roster invention.

## B. Simulation issues (engine/validator/repair bugs — model-independent)

- **S1 — Fallback back at baseline-or-worse (47%) despite full Laya.** Exp-2's 19% did
  not replicate on either Anton-scenario run (43%, 47%). Same mechanism as Exp-3 S1:
  selection picks handshake/show-test-plan/sit/pour actions the consequence tier cannot
  render; Laya scores them plausibly; validator kills all attempts. Plus this run's
  sample: 6/10 user turns fell back, and user turns bypass every Laya gain *and* the
  capable tier is a no-op here (`LLM_USER_CAPABLE_TIER=1` with both tiers on the same
  local 8B routes user turns to the same model).
- **S2 — NEW: the movement veto converts wrong movement into NO movement.**
  `movement_repair_vetoed` fired 15× (the Exp-3 S5 fix working as coded): repairs that
  step away from the narrative target are vetoed and the turn retries instead — but the
  retries never produce a legal step either, so user locomotion moves 5, 6, 9 died with
  zero displacement. Anton hasn't moved since tick 3. A veto without a constructive
  alternative is a fallback machine: when repair is vetoed, synthesize a capped step
  *toward* the named target (or downgrade to honest stationary prose) instead of burning
  3 more attempts.
- **S3 — Intent-ban keys are too literal (Exp-3 S2 fix half-working).** The handshake
  intro got banned after 2 consecutive failures (tick 19 — the machinery works), but the
  identical test-plan-showing intent failed 3× (ticks 13, 16, 22) with no ban — first- vs
  third-person wording differences (`I walk…` vs `walk…`) produce different keys for the
  same intent. Normalize keys (lowercase, strip leading pronoun/verb-form) before counting.
- **S4 — NEW: no narrative-voice gate.** First-person `I …` action text (M1) flows from
  proposal → selection → consequence → canonical history untouched. Add a cheap proposal/
  consequence check: NPC action text and narrative must not contain first-person
  self-reference (`I / my / me` outside quotes); either rewrite or fail fast with a
  targeted retry hint. Also covers the `Dana: Dana:` doubled-prefix shape.
- **S5 — State/pose labels still wrong (Exp-1 S8 / Exp-3 S6, still open).**
  `at Tanya's chair` for standing adjacent, `at Dana's chair` while sitting at (14,11)
  though the chair is at (15,11), `pose:sit` drift. Template state labels from nearest
  *owned* landmark; validate `pose:sit` against chair cells.
- **S6 — Props from thin air, fourth run with zero object patches (Exp-3 S6-class).**
  `prop:laptop/cup` appear with no `objectPatches`; pour/sip/open never ground to roster
  ids. Either make object-wording deterministically repairable (typing→`prop:laptop`
  stub was the Exp-1 proposal; still not done) or stop selecting object verbs the tier
  cannot ground (feeds S1).
- **S7 — Retry divergence unchanged (Exp-1 S7, fourth run).** 63 retries, attempt 1
  systematically best; best-attempt salvage (23 evaluations) picks well but the 4× latency
  is still paid. Early-abort on growing hard-error counts (Exp-3 item 9, still open).
- **S8 — `.env` default `OLLAMA_MODEL=qwen3:14b` still not installed (Exp-2 S10,
  fourth run).** Align `.env`/`.env.example` with what `setup:ollama` pulls.
- **S9 — Salience/triage thresholds unvalidated (Exp-3 S10).** Memories still append
  stubs and doubled prefixes; measure memory-precision before tuning.
- **S10 — Emotions frozen all 30 turns** (cosmetic, fourth run: `nervous`/`focused`/
  `stressed` never update despite greetings, ignored questions, and coffee).

What the simulation did *well*: validator rejected 100% of unknown-id patches; accept-gate
rejected 1 corrupt narrative (tick 11); quote-reinsert saved 5 speech turns; liveness floor
fired once instead of a 4th consecutive fallback; intent-ban fired once; no crashes;
no blowups; honest `(not done)`/`(partial)` history throughout.

## C. Action items

Model-side (prompts/routing, no validator changes):
1. Third-person discipline line in proposal + consequence prompts with a negative `I …`
   example (S4/M1); repeat per-NPC-turn (the leak is NPC-specific).
2. Route *user-turn* consequence through a genuinely capable tier when available (S1;
   this run proves the env-flag alone is a no-op when both tiers are the same model —
   warn when `LLM_USER_CAPABLE_TIER=1` resolves to the identical provider+model).
3. Canonical speech-turn form + exempt fully-spoken actions from `echoes_action`
   (Exp-3 S4, still open; pure-speech user moves 7–8 died here).
4. Renderability-matched proposals: contact/object verbs must carry grounding
   (distance ≤2, roster object id) or not be suggested (feeds S1/S6).

Simulation-side (ordered by impact):
5. **S2 first**: vetoed repair must propose a constructive alternative — capped step
   toward the named narrative target, else honest stationary downgrade; never
   veto-then-retry-to-fallback (15× this run, froze the player avatar for 27 ticks).
6. **S4**: first-person voice gate on proposal output + consequence narrative
   (fail fast with targeted retry hint; fixes M1 at the source).
7. **S3**: normalize intent-ban keys (case/leading-pronoun/verb-form) so repeats like
   ticks 13/16/22 ban after 2 consecutive failures.
8. **S5**: template `state` labels from nearest owned landmark; require/refresh `state`
   on every x/y change; validate `pose:sit` against chair cells.
9. **S7**: early-abort retries when hard-error count grows two attempts in a row.
10. **S6**: deterministic prop stubs for object verbs (sip→`prop:cup`, typing→
    `prop:laptop`) or roster mug/laptop grounding; measure applied-objectPatches.
11. **S8/S9/S10**: align `.env` model default with `setup:ollama`; measure
    memory-precision and bind the salience gate; unfreeze emotions or drop them.

## D. Laya verdict

*Does utilizing the decision model more give better quality for local small LLMs?*
**Decisions: yes, saturated. Rendering: no — and Exp-4 locates the new binding constraint
in the repair layer.**

- The decision layer remains fully utilized and reliable: 20/20 intents, 20/20 planner
  diagrams, 85 plausibility scores, 0 chat-judge calls, intent-ban + liveness + accept-gate
  all fired live. Nothing left to delegate in choosing.
- End-to-end still trails Exp-2 badly (47% fallback vs 19%) on the same Laya-max config —
  the variance across runs/scenarios now exceeds any Laya-attributable delta, which itself
  is a finding: generation-tier variance dominates.
- New mechanism this run: the Exp-3 S5 repair veto works exactly as coded (15 vetoes, zero
  wrong-direction arrivals) — and converts the failure mode from *wrong movement* into
  *no movement*, freezing the avatar for 27 of 30 ticks. Guardrails that only veto, without
  synthesizing a legal alternative, trade corrupt-applied turns for honest fallbacks. That
  trade is arguably correct (honest history > fiction), but it means the progress metric
  must be over *task completion* (did Anton reach the coffee machine?), not over
  fallback-rate alone — by task completion, moves 5/6/7/8/9 all failed even when the
  history stayed honest.
- Practical consequence (extends Exp-3): stop pushing decisions onto Laya; the next quality
  dollar is (a) constructive movement repair (S2), (b) voice grounding (S4), (c) quote
  preservation (item 3) — plus a task-completion eval harness, since fallback-rate rewards
  vetoes that freeze the world.

Repro: `saves/exp4-laya-anton.json`, `logs/exp4_laya.jsonl`, driver `exp4-round.ts`
(per round: `npx tsx ./exp4-round.ts '<action>' saves/exp4-laya-anton.json exp4_laya`
with the Exp-3 env overrides). Laya: `laya-serve` on CUDA, live during the run.
