# Experiment 3: 10 user moves, local default models + Laya, text mode, debug on

Date: 2026-10-08. Scenario: `scenarios/office-anton.json` (you play Anton, the new
backend hire; NPCs Tanya — former Sixt coworker who referred you — and Dana, the
recruiter). First run on this scenario (Exp-1/2 used `office.json` with Jeff/Ana/Dan),
so roster-invention dynamics differ: Anton/Tanya/Dana are the *correct* ids here.
Setup (same as Exp-2, maximum Laya utilization): all four engines on local Ollama,
default models (`OLLAMA_MODEL=fluffy/l3-8b-stheno-v3.2`,
`LLM_SIMPLE_MODEL=huihui_ai/llama3.2-abliterate:3b`, both tiers `ollama`), debug trace
captured (`NPC_LOG_PROMPTS=1`, `LLM_JSON_MODE=1`), and Laya fully on:
`LAYA_MODE=dynamic LAYA_SELECTION=1 LAYA_JUDGE=1 LAYA_TRIAGE=1 LAYA_SALIENCE=1 LAYA_PLANNER=1
LAYA_PLAUSIBILITY=1`, `LAYA_URL=http://127.0.0.1:8000` (laya-serve on CUDA, all three
checkpoints loaded; live choice probe PASS p=0.99). Driver: `runTurn` per turn with
reactive user text (acted on circumstances each round — greetings, questions, coffee,
desk-seeking); 1 user turn + NPC turns until control returns; state in
`saves/exp3-laya-anton.json`, traces in `logs/exp3_laya_m1.jsonl` … `m10.jsonl`,
driver `/tmp/opencode/exp3-round.ts`. Note: `.env` still asks for `OLLAMA_MODEL=qwen3:14b`,
which is NOT pulled locally (only the two recommended models are); the driver overrides
to the documented defaults (Exp-2 S10, still open). 30 turns total, ticks 0–29,
~10.5 min wall time (≈21 s/turn — slower than Exp-2's 7–21 s, no blowups).

## How the scenario unfolded (user moves 1–10, ticks 0–29)

1. Greet the room, introduce self, walk toward Tanya's desk → **triple fallback**
   (user + Tanya + Dana all `(not done)`). User attempt 1 went fully off-distribution:
   `The hungry stranger stumbled upon a nearby cafe` (actor `stranger`, object `cafe`).
   Tanya's attempts moved *Anton* as an observer and invented `leon`; Dana's attempts
   moved Anton three times. Nobody moved; Anton stuck at the entrance (16,2).
2. Walk to Tanya's desk, ask what she's working on + what to tackle first → user turn
   **applied via format salvage** (narrative ≈ raw action text, no movement, but thought
   implanted: `Giving Dana the pen she requested` — Dana never asked for a pen).
   Tanya **fallback** (stand-up + handshake). Dana **partial** (`Dana: Dana: Minimize my
   screen…` — doubled-name prefix, drifted (15,11)→(14,11) on a stationary action).
3. Step east toward Tanya, reassure her → user **corrupt partial**: `Anton approaches
   Tanya` (question dropped, no quote) with a teleport (16,2)→(12,6), state
   `near the tanya's mug`. Tanya **fallback** (same handshake action again). Dana
   **partial** (`Dana turns to Anton, looking at his laptop`, drifting to (13,11)).
4. Stay put, ask Tanya where to sit → user **partial** (`Anton stands nearby, greeting
   Tanya and Dana` — asked question vanished). Tanya **partial** (stood up (8,7)→(11,6)
   while narrative says `looks over at Dana, nodding`). Dana **applied w/ repair**
   (`adjusts the monitor, sits at her desk`, but state reads `near the tanya's desk sign`
   while sitting at his *own* desk).
5. Turn to Dana, ask what he's hiring for → user **partial** (`Anton greets Tanya` —
   Dana-directed question rerouted to Tanya, quote dropped). Tanya **partial**
   (`turns to face Anton`, minimal but sane). Dana **partial** with invented stage
   business (`Slide Dana's papers…` proposal text leaked verbatim as narrative) and a
   5-cell teleport (12,11)→(16,14) for a sit-and-review action.
6. Walk to the coffee machine, pour coffee → user **corrupt partial**: `Anton sits at
   the desk` (coffee→sitting, no object patch), teleport (12,6)→(7,3) `near the water
   cooler` (right direction, wrong landmark). Tanya **fallback** (handshake again).
   Dana **fallback** (papers-shuffle).
7. Walk to my ANTON-sign desk, sit, open laptop → user **fallback** (sit+laptop+move
   combo unsatisfiable). Tanya **fallback** on a *great* action (`Feel free to take a
   look at my current test plan…` with exact quote — the echo/quote trap again, see S3).
   Dana **corrupt partial**: `Dana approaches Tanya's desk and greets her: 'Good morning,
   Tanya. I'm Dana, the new hire.'` — Dana is NOT the new hire; identity confusion
   recorded as canonical history (Exp-2 S2 class, still open).
8. Pure speech: accept Tanya's test-plan offer → user **corrupt partial** honestly
   flagged: `Anton sets his laptop on the coffee table. (partial) [speech.no_speech_rendered]`
   (speech fully dropped; `coffee table` is an invented landmark name — the scenario has
   `lounge_table`; laptop prop materialized from thin air). Tanya **clean, 0 failures**:
   `sips her morning coffee while sitting at her desk` (best turn of the run). Dana
   **fallback** (papers-organizing).
9. Sit at my desk, wait for the test plan → user **applied w/ repair** (fast, 1.8 s, 1
   failure) but fiction: `walks past Dana at his desk` (Dana is 8 cells away) and lands
   (4,5)→(7,10) `near the tanya's papers` — sent to Tanya's desk, not his own
   (`anton_desk` is at (3,8)). Tanya **fallback** (handshake again). Dana **fallback**
   (pushing his chair — a trivial movement failed).
10. Pure speech: thank everyone, set up laptop → user **corrupt partial** (`Anton sits at
    the desk`, speech dropped again, stepped (7,10)→(11,7)). Tanya **applied w/ repair**:
    `walks over to Anton and greets him warmly, offering her hand for a handshake` — but
    the patch moved her (11,6)→(8,10), *away* from Anton (wrong-direction repair, see S5).
    Dana **fallback** (open laptop to refresh pipeline).

Net world mutation after 30 turns: Anton (16,2)→(11,7) — mid-room near Tanya's mug, never
reached his own desk despite moves 6/7/9 targeting it or the coffee corner; Tanya
(8,7)→(8,10) — off her chair while `state` still implies sitting, `pose:sit` at a
non-chair cell; Dana (15,11)→(15,14) — unexplained southward drift while "sitting at his
desk"; **zero scene-object changes** (39 objects untouched); props mutate from thin air
(Anton null→laptop, Tanya laptop→cup, Dana null→laptop, no objectPatches ever applied);
memories compound numerically (Anton 10, Tanya 7, Dana 6) but see M8; emotions frozen
(Anton `nervous` × 30, Tanya `focused` × 30, Dana `stressed` × 30); `state` strings are
ungrammatical (`near the tanya's mug/papers/chair`) and often wrong-desk (S8).

NPC reasonableness: Tanya never answered three direct questions (all her answering turns
fell back or dropped the quote); Dana introduced himself as `the new hire`; the handshake
action was selected 5+ times and never rendered; papers/chair micro-actions died every
time. Bright spots, all on *stationary reactive* beats: Tanya's coffee sip (clean),
`turns to face Anton`, Dana's `adjusts the monitor… logs into her laptop` — the tier is
at its best when the action is one silent beat with no contact, no object, no quote.

## Turn statistics (from `logs/exp3_laya_m*.jsonl`, history cross-checked)

| outcome | ticks | count | Exp-2 | Exp-1 |
|---|---|---|---|---|
| applied (incl. repaired) | 3, 11, 22, 24, 28 | 5/30 (17%) | 13/21 (62%) | 5/21 (24%) |
| applied clean, 0 validation failures | 22 only | 1/30 (3%) | ~10/21 | 5/21 |
| partial-applied, narrative kept w/ notes | 5, 6, 8, 9, 10, 12, 13, 14, 15, 20, 21, 27 | 12/30 (40%) | 4/21 (19%) | 3/21 (14%) |
| fallback `tried: … (not done)` | 0, 1, 2, 4, 7, 16, 17, 18, 19, 23, 25, 26, 29 | 13/30 (43%) | 4/21 (19%) | 9/21 (43%) |

Totals: 96 `validation_failed` records (451 coded gate hits), 69 `retry_started`
(6 `retry_aborted`), 122 `consequence_failed` vs 89 `consequence_completed`,
14 `consequence_lenient_repair`, 4 `movement_repaired`, 23 `salvage_best_attempt` /
23 `salvage_evaluated` (5 `salvage_prose_synthesized`, 1 `salvage_accept_gate_rejected`),
`selection_failed` **0**, `semantic_completed` (chat judge) **0**. Attempt 1 is still
systematically the best; failing turns still burn all 4 attempts. Validator caught 100%
of unknown-id *patches* — but corrupt *narratives* passed twice with patches intact
(tick 20 identity theft; tick 28 wrong-direction arrival prose).

Top failure codes (451 hits): `movement.no_position_change` 56,
`movement.declared_without_patch` 43, `turn_discipline.acting_actor_not_patched` 39,
`observer_moved` 33 + `narrative.observer_as_subject` 33 (observer-as-subject is the
dominant narrative disease: 66 hits), `movement.narrated_without_patch` 29,
`speech.no_speech_rendered` 27, `observer_state_change` 27, `actor.blocked_position` 21,
`narrative.unknown_actor` 13, `contact.action_too_far` 11, `narrative_drops_contact` 10,
`speech.dropped_words` 10, `movement.over_step_cap` 9, `sit_no_pose` 8, `pour_no_patch` 7.

### Laya metrics (the focus of this run)

| metric | Exp-3 (laya max, anton scenario) | Exp-2 (laya max) | Exp-1 (chat-only) | target |
|---|---|---|---|---|
| fallback rate | 43% (13/30) | 19% (4/21) | 43% (9/21) | parity or better ❌ (back to baseline) |
| applied rate | 17% (5/30) | 62% (13/21) | 24% (5/21) | parity or better ❌ |
| selection format failures | **0** | 4 (recovered) | n/a | → 0 ✅ |
| judge chat-LLM calls | **0** (98 `semantic_resolved`, 98 `judge_vs_effects_disagreement`, all via Laya judge) | 0 | >0 per turn | 0 ✅ |
| `laya.intent_decided` | 20/20 NPC turns (100%) | 14/14 | — | cascade runs ✅ |
| `planner_diagram_resolved` | 20/20 NPC turns | 0 events | — | observable ✅ (Exp-2 S6 FIXED) |
| `plausibility_scored` | 92 events | 0 events | — | observable ✅ (Exp-2 S6 FIXED) |
| `salience_scored` / `triage_applied` | 17 / 12 | 0 / 15 | — | observable ✅ (Exp-2 S6 FIXED) |
| best-attempt salvage | 23 evaluations, 5 prose-synthesized, 1 accept-gate rejection | n/a (new machinery) | — | working ✅ |
| observer thought-churn | thoughts implanted on most turns, incl. hallucinated ones (`Giving Dana the pen she requested`, `Another day…`-class) | high | high | lower ❌ (triage gates noise — not yet) |
| turns/hour | ~170/hr (≈21 s/turn avg, 10.5 min for 30 turns) | ~170–250/hr | similar | higher (flat) |

## A. Model issues (small-model hallucination and misses, not engine bugs)

- **M1 — Full off-distribution collapse on attempt 1.** Tick 0: `The hungry stranger
  stumbled upon a nearby cafe` (actors `stranger`, object `cafe`, `moved:true`) for a
  greeting+walk action. The retry loop recovered only to fallback, but one such attempt
  per turn poisons best-attempt salvage pools. New extreme vs Exp-1/2's drift.
- **M2 — Roster invention persists even when the roster matches the bias.**
  `leon` (tick 1, Tanya's turn: `Leon moves closer to Dana, picking up his laptop`),
  `stranger`/`cafe` (tick 0), `phone` ×2, `couch` ×2. The Anton/Tanya attractor from
  Exp-1 is now *legitimate vocabulary*, which makes real invention (`leon`) harder to
  spot by eye — validator held on patches every time (only 4 `actor.unknown_id` +
  5 `object.unknown_id` slipped into attempts, all rejected).
- **M3 — Observer-as-subject is now the dominant narrative disease** (66 gate hits:
  33 moved-observer + 33 observer-as-subject). Dana's turns repeatedly move *Anton*
  (`Anton walks over and sits down next to Tanya…`, three teleports in one turn); Tanya's
  attempt 2 moves Anton too. The model treats the viewpoint character as the most
  writable actor. Laya cannot see this (it never reads generative output).
- **M4 — Quote/question dropping is worse here than Exp-2.** `speech.no_speech_rendered`
  27 + `dropped_words` 10 + `question_dropped` 4: three direct questions to Tanya never
  got quoted; two pure-speech user turns (moves 8, 10) rendered zero speech with honest
  `(partial)` flags. Generation paraphrases away the utterance it must preserve.
- **M5 — Contact/handshake is unrenderable for this tier.** `contact.action_too_far` 11,
  `narrative_drops_contact` 10: the handshake was *selected* 5+ times and applied once
  (tick 28, with wrong-direction movement). Selection loves social wording the
  consequence tier cannot ground at these distances.
- **M6 — Object interaction still unsatisfiable, now with landmark invention.**
  `pour_no_patch` 7, `pickup_no_patch` 4, `sit_no_pose` 8: coffee pour → sitting; papers
  organize → fallback ×3; `coffee table` invented for the existing `lounge_table`. Zero
  `objectPatches` applied in 30 turns (third run in a row); props instead materialize
  (`prop:laptop` from thin air, tick 21).
- **M7 — Identity confusion (new extreme).** Tick 20: `I'm Dana, the new hire` — wrong
  actor claims the user's role, recorded as canonical history with a memory echo in
  Dana's compounding store. Exp-2 S2's hole now has a speaking example.
- **M8 — Memory compounding works numerically but pollutes semantically.** Counts rose
  (10/7/6 vs Exp-1's stuck-at-1), yet entries are quote-dropped stubs (`Anton: Anton
  greets Tanya`), doubled prefixes (`Dana: Dana: Minimize…`), and identity-theft lines
  (`I'm Dana, the new hire`) — all now permanent "memories". Deterministic append
  preserves fiction faithfully (Exp-1 action item 3's downside, realized).
- **M9 — Movement magnitude delusion.** 5-cell teleports for sit-and-review actions
  (tick 14: (12,11)→(16,14)), `over_step_cap` 9, `blocked_position` 21 — the model has
  no feel for the 20×20 grid scale and treats any destination as adjacent.

What the model did *well*: stationary silent beats render fine (tick 22 coffee sip,
0 failures; `turns to face Anton`; `adjusts the monitor… logs into her laptop`); thoughts
are usually in-character; proposal breadth is sane; perceiver gating correct throughout.

## B. Simulation issues (engine/validator/repair bugs — model-independent)

- **S1 — Fallback rate back to chat-only baseline (43%) despite full Laya.** The headline
  result: Exp-2's 43%→19% win did not replicate. Decision subtasks are absorbed (table
  above), yet end-to-end quality regressed to Exp-1 levels. Contributing factors: richer
  object-dense scenario (39 objects vs office.json's few — longer prompts, more anchors
  to misuse), user-turn-heavy failure mix (user turns get no intent-narrowing), and the
  selection↔consequence capability gap (S2). Laya optimizes choosing; this run was lost
  in rendering.
- **S2 — NEW (the mechanism behind S1): selection repeatedly picks actions the
  consequence tier cannot render, with no feedback loop.** Handshake ×5, papers-shuffle
  ×3, chair-push ×1 — the same unrenderable intents get selected, fail 4 attempts, fall
  back, and get selected again next turn (Tanya's greeting action failed ticks 1, 4, 7
  nearly verbatim). Intent-narrowing makes proposals *narrower*, not *renderable*.
  Fix: feed per-intent failure history back into proposal/selection (ban or down-rank
  intents that failed N consecutive times), or add a Laya renderability `score` node
  before committing to an action.
- **S3 — Corrupt narratives still pass as canonical history (Exp-2 S2, still open, now
  with an identity-theft receipt).** Tick 20 (`I'm Dana, the new hire`) applied with
  patches intact — no gate fired on the final attempt. The new salvage accept-gate
  rejected 1 turn (progress), and best-attempt salvage + prose synthesis ran 23 times,
  but the full-gate re-check after accept is still missing. Regression tests needed:
  sip-action→wrong-subject must reject; stay-action→teleport must reject;
  non-new-hire→new-hire-claim must reject (identity-consistency gate).
- **S4 — Echo-vs-quote trap killed the run's best NPC action (Exp-2 S3, still open).**
  Tick 19: Tanya's test-plan offer with exact quote fell back; tick 7 (Exp-2) was the
  same shape. For speech turns where the action *is* the utterance, verbatim rendering
  must be legal — exempt fully-spoken actions from `echoes_action`.
- **S5 — Movement repair goes the wrong way when the destination is ambiguous.**
  Tick 24 (repair to Tanya's papers instead of Anton's own desk), tick 28 (Tanya stepped
  *away* from Anton while narrating approach), tick 6 (right direction, wrong landmark:
  water cooler instead of coffee machine). `suggestMoveTarget` still never parses the
  action text for named destinations (Exp-1 S1, mitigated only when the model declares
  a destination id — which it rarely does: `declared_without_patch` 43).
- **S6 — State/pose labels are ungrammatical and often wrong-desk (Exp-1 S8, worse).**
  `near the tanya's mug/papers/chair` (article + possessive), Dana `near the tanya's
  desk sign` at his own desk, Anton `pose:sit` at (11,7) — no chair there. No gate
  requires state updates on move or checks label grammar/landmark ownership. Cheap fix
  with high readability payoff: template state labels from nearest owned landmark.
- **S7 — Retry divergence unchanged (Exp-1 S7 / Exp-2 S7, still open despite
  best-attempt salvage landing).** Salvage now *selects* the best attempt (23 evaluations
  — the machinery works), but generation still diverges 1→4 every failing turn, burning
  ~4× latency for worse text. Next step is early abort on growing hard-error counts,
  not just best-pick at the end.
- **S8 — Thought implants bypass triage.** `Giving Dana the pen she requested` (tick 3),
  identity-echo thoughts on corrupt turns — `triage_applied` 12/30 turns but thought
  churn is undiminished and hallucinated thoughts still land. Triage gates *whether* to
  write thoughts, not *what* they claim; add a thought-grounding check (no new
  proper nouns / requested-object claims without history support).
- **S9 — `.env` default `OLLAMA_MODEL=qwen3:14b` still not installed (Exp-2 S10,
  still open).** Every `diagnose-ai:live` warns; newcomers following `.env` get a broken
  default. Align `.env`/`.env.example` with what `setup:ollama` pulls.
- **S10 — Salience/triage thresholds unvalidated.** `salience_scored` 17 but memories
  still append stubs and doubled prefixes; either the threshold passes trivia or the
  gate is advisory where it should bind. Measure memory-precision (entries that
  paraphrase real turns vs stubs/fiction) before tuning.

What the simulation did *well* (real progress vs Exp-2): Exp-2 S6 (unobservable
planner/plausibility/salience) is FIXED — 20/20 diagrams, 92 plausibility scores, 17
salience events, all in-log; best-attempt salvage + prose synthesis + accept-gate
rejection are live and auditable; validator still rejects 100% of unknown-id patches;
`movement_repaired` fired 4 times without crashes; per-turn latency acceptable for local
8B albeit slower (≈21 s avg).

## C. Action items

Model-side (prompts/routing, no validator changes):
1. Roster-discipline line + negative `leon/stranger`-style example in the consequence
   prompt; repeat the 3-id roster in retry feedback (Exp-1/2 item, still valid — the
   attractor now hides inside legitimate vocabulary).
2. Route *user-turn* consequence through the capable tier when available (Exp-1/2 item;
   this run: user turns supplied 6/10 of the worst corrupt partials and get no
   intent-narrowing today).
3. Canonical speech-turn form, once: "quote the utterance, narrate only the non-speech
   frame" + exempt fully-spoken actions from `echoes_action` (S4; kills perfect turns).
4. Renderability-matched proposal prompts: handshake/contact and object-use suggestions
   must include the grounding the consequence tier needs (distance ≤2 for contact,
   roster object id for pour/pickup/sit) — or stop suggesting them (feeds S2).

Simulation-side (ordered by impact):
5. **S2 first**: per-intent failure memory — down-rank/ban intents that failed N
   consecutive turns; add a Laya renderability `score` node (distance + object + quote
   checks, ~33 ms) before committing to greeting/contact/object actions.
6. **S3**: full gate-suite re-check after any patch-stripping/salvage/prose-synthesis
   accept; add the three regression tests (wrong-subject sip, teleport stay,
   identity-theft claim). P1 depends on it — third run open.
7. **S5**: give `suggestMoveTarget` the action text: resolve named landmarks/actors
   (`coffee machine`, `my desk`, `Tanya`) to coordinates, break ties toward the hint,
   never step *away* from a named approach target; verify arrival prose direction
   post-repair (tick 28).
8. **S6**: template `state` labels from nearest *owned* landmark (`at Tanya's desk`,
   no article+possessive stacking); require/refresh `state` on every x/y change;
   validate `pose:sit` against chair cells.
9. **S7**: early-abort retries when hard-error count grows two attempts in a row
   (best-attempt selection already landed — stop paying 4× latency for divergence).
10. **S8**: thought-grounding check — reject thoughts introducing new proper nouns or
    claimed requests/grants with no history support; make triage a content gate.
11. **S9/S10**: align `.env` model default with `setup:ollama` reality; measure
    memory-precision and bind the salience gate to it.

## D. Laya verdict (the question these runs were designed to answer)

*Does utilizing the decision model more give better quality for local small LLMs?*
**Yes for decisions — decidedly; no (further) for rendering — and this run defines the
ceiling.**

- The decision layer is now maximally utilized and fully reliable: 20/20 intents, 20/20
  planner diagrams, 92 plausibility scores, 0 selection format failures, **0 chat-LLM
  judge calls across 30 turns** (98 Laya resolutions + 98 disagreements handled without
  the chat tier). Exp-2's observability gap (S6) is closed; best-attempt salvage works.
  There is nothing left in the choosing stack to delegate — the tank is empty.
- Yet end-to-end quality fell back to the chat-only baseline (43% fallback, 17% applied,
  1 clean turn in 30). The mechanism is visible: selection faithfully picks
  handshake/papers/sit actions the consequence tier cannot render, Laya scores them
  plausibly, the validator kills all 4 attempts, and the loop repeats next turn. Every
  decision can be perfect and the turn still dies in generation.
- Thesis check (LAYA_PLAN §8): "small models fail at choosing/formatting, not writing"
  is now **refuted in its strong form**. Choosing/formatting *are* fixed under Laya
  (0/0 failures). The 8B's *writing* — grounding prose to action text without moving
  observers, inventing people/rooms, dropping quotes, or teleporting bodies — remains
  the dominant failure source (451 gate hits), and no decision cascade stands between
  the writer and the world store except the validator (which S3 shows still leaks
  narratives).
- Practical consequence: stop pushing decisions onto Laya (diminishing returns reached);
  the next quality dollar goes to the generation side — renderability-aware selection
  (S2), quote-preserving consequence prompts (S4), action-text-aware movement repair
  (S5), and the S3 accept-path gate hole — plus a discharge criterion for the small
  tier: user-turn consequence routed up when available, since user turns fail most and
  bypass every Laya gain by construction.

Repro: `saves/exp3-laya-anton.json`, `logs/exp3_laya_m1.jsonl` … `m10.jsonl`, driver
`/tmp/opencode/exp3-round.ts` (per round:
`npx tsx /tmp/opencode/exp3-round.ts '<action>' saves/exp3-laya-anton.json <session>`),
env overrides in the driver header. Laya: `laya-serve` on CUDA (3 checkpoints),
live probe `diagnostics ping → winner p=0.99` during the run.
