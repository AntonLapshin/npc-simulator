# Experiment 2: 7 user moves, local default models + Laya, text mode, debug on

Date: 2026-10-08. Scenario: `scenarios/office.json` (you play Jeff; NPCs Ana, Dan) —
same scenario as Experiment 1 (`experiments/local-8b-7moves-2026-10-07.md`) for comparability.
Setup (mirrors `npm run start:text -- --provider ollama --debug`, plus the Laya decision
layer at maximum utilization):
all four engines on local Ollama, default models (`OLLAMA_MODEL=fluffy/l3-8b-stheno-v3.2`,
`LLM_SIMPLE_MODEL=huihui_ai/llama3.2-abliterate:3b`, both tiers `ollama`), debug trace
captured (`NPC_LOG_PROMPTS=1`, `LLM_JSON_MODE=1`), and Laya fully on:
`LAYA_MODE=dynamic LAYA_SELECTION=1 LAYA_JUDGE=1 LAYA_TRIAGE=1 LAYA_SALIENCE=1 LAYA_PLANNER=1
LAYA_PLAUSIBILITY=1`, `LAYA_URL=http://127.0.0.1:8000` (laya-serve on CUDA, all three
checkpoints loaded: english, multilingual, typed-decisions; live choice probe PASS p=0.99).
Driver: `runTurn` per turn with reactive user text (acted on circumstances each round);
1 user turn + NPC turns until control returns; state in `saves/exp2-laya-debug.json`,
traces in `logs/exp2_laya_m1.jsonl` … `m7.jsonl`, driver `/tmp/opencode/exp2-round.ts`.
Note: `.env` currently asks for `OLLAMA_MODEL=qwen3:14b`, which is NOT pulled locally
(only the two recommended models are); the driver overrides to the documented defaults
(S10 below). 21 turns total, ticks 0–20, per-turn latency 7–21 s (no blowups).

## How the scenario unfolded (user moves 1–7, ticks 0–20)

1. Greet the room, introduce self to Ana → user turn **partial-applied** (3 validation
   failures; attempt 2 was the Anton→Tanya attractor; salvaged narrative kept but Jeff
   (1,10)→(0,10), a step *west*). Ana clean (glance + back to laptop), Dan clean (temple rub).
2. Walk up to Ana: "What are you working on?…" → user turn **applied w/ movement repair**
   (1 failure), Jeff (0,10)→(6,10) — big *eastward* step toward Ana, quote preserved,
   state → "near the ana's desk". Ana applied ("approach the stranger", (8,8)→(7,8)),
   Dan applied (glare → back to monitor). Best round of the run.
3. "No rush… what engineering work do you do? walk closer" → user turn **corrupt partial**:
   `Jeff: Jeff greet Dan.` (wrong addressee, no quote, repaired teleport (6,10)→(8,7)).
   Ana **fallback** on a *perfect* turn ("…says 'Hi Jeff, welcome to the team…'" rejected
   for `narrative.echoes_action`, retries diverged to teleport/folder). Dan partial
   (typing turn salvaged, 3 failures incl. impossible `cup` object at (4,4)).
4. "Thanks Ana! …where should I sit? stay near her desk" → user turn **fallback**
   (`ana_papers` invented id + `sit_no_pose` fired on the *question* "where I should sit").
   Ana applied-but-wrong: `Ana: Jeff introduces Ana to Dan.` for a silent coffee-sip action
   (see S2). Dan applied-but-wrong: `Dan walks into the conference room…` for action
   "Stay where you are", teleporting (15,8)→(12,8) (see S2).
5. Turn to Dan: "Sorry to interrupt… where is an empty spot?" → user turn **corrupt partial**:
   `Jeff turns to walk out the door.` (opposite of the action; explicit
   `[speech.question_dropped]` note; (8,7)→(8,9) south). Ana clean, Dan clean
   (frustrated sigh — very in-character).
6. Step back, explore middle of room → user turn **applied w/ repair** (generic "walks into
   the office and greets Ana", but directionally sane; (8,9)→(6,8)). Ana clean (watch glance),
   Dan applied after 3 failures ("asks for clarification"; attempt 2 was Tanya→Anton).
7. Pure speech: "Ana, could you show me where I should sit?" → user turn **fallback**
   (attempts: phantom desk → handshake with Dan → `_desk_report` invention → Tanya
   shoulder-touch). Ana **fallback** on another near-perfect welcome-smile turn
   (echoes_action again, then couch/Tanya divergence). Dan clean ("stays put", 0 failures).

Net world mutation after 21 turns: Jeff (1,10)→(6,8) — *eastward, toward Ana's desk*
(vs Exp-1's westward drift to (3,8)); Ana (8,8)→(7,8); Dan (15,8)→(12,8) (approach arc);
**zero object changes** (same as Exp-1); memories compound this time (Jeff 6, Ana 7,
Dan 8 entries — vs Exp-1's Jeff stuck at 1); `state` strings update on moves
("near the ana's desk"); emotions mostly static (Jeff "nervous" all game).

## Turn statistics (from `logs/exp2_laya_m*.jsonl`)

| outcome | ticks | count | Exp-1 |
|---|---|---|---|
| clean applied, 0 validation failures | 1, 2, 4, 5, 8, 13, 14, 15, 16, 20 (+3 repaired: 3, 6*, 15*) | 13/21 (62%) | 5/21 (24%) |
| applied after deterministic movement repair | 3, 6(user→(8,7)), 15 | 3/21 | 4/21 |
| fallback `tried: … (not done)` | 7, 9, 18, 19 | 4/21 (19%) | 9/21 (43%) |
| partial-applied, hallucinated narrative kept | 0, 6, 8, 12 | 4/21 (19%) | 3/21 (14%) |

Totals: 38 `validation_failed`, 36 `consequence_failed`, 27 `retry_started` (3 `retry_aborted`),
5 `consequence_lenient_repair`. Failing turns still burn all 4 attempts and attempt 1 is
still systematically the best (retry divergence unchanged). Validator still caught 100% of
unknown-id *patches* — but see S2: two corrupt *narratives* passed with patches intact.

### Laya metrics (the focus of this run)

| metric | Exp-2 (laya max) | Exp-1 (chat-only) | target |
|---|---|---|---|
| fallback rate | 19% (4/21) | 43% (9/21) | parity or better ✅ |
| clean applied rate | 62% (13/21) | 24% (5/21) | parity or better ✅ |
| selection format failures (`selection_failed`) | 4 (all recovered via chat fallback → `selection_completed`) | n/a | → 0 (not yet) |
| judge chat-LLM calls (`semantic.semantic_completed`) | **0** (48 `semantic_resolved`, 48 `judge_vs_effects_disagreement`, all via Laya judge) | >0 per turn | 0 ✅ |
| `laya.intent_decided` | 14/14 NPC turns (100%) | — | cascade runs |
| `laya.triage_applied` | 15/21 turns | — | gates noise |
| salience / planner / plausibility events | **0 events logged** (S6) | — | observable |
| proposal breadth | 2–3 suggestions on narrowed NPC turns (intent-first working), 10 on others | ~10 always | narrower ✅ (mixed) |
| observer thought-churn | thoughts still implanted on most turns (incl. corrupt S2 turns) | high | lower (not yet) |
| turns/hour | ~170–250/hr local (≈7–21 s/turn, no 47-min blowup) | similar | higher (mixed) |

## A. Model issues (small-model hallucination and misses, not engine bugs)

- **M1 — Anton/Tanya attractor persists at the same base rate.** `anton`/`tanya` in m1
  attempt 2 ("Anton walks toward Tanya"), m6 Dan attempt 2 ("Tanya turns to face Anton"),
  m7 attempt 4 ("stands next to Tanya's desk, hand on her shoulder"), plus lisa/john-style
  drift in earlier rounds. Laya cannot fix this: it decides *between* options, it never sees
  generative id-invention. The validator held on patches every time.
- **M2 — moved=true with no x/y still the modal first-attempt failure**, incl. user turns.
  Repair covers it when a destination is declared (tick 3 eastward ✅); without one the step
  is still undirected (S5).
- **M3 — Quote/question dropping.** `speech.dropped_words` / `question_dropped`: m3
  "Jeff greet Dan" keeps no quote; m5 "walk out the door" drops the asked question (flagged
  honestly in the note). Generation still paraphrases-away the utterance it must preserve.
- **M4 — Retry divergence unchanged.** Attempt 1 is systematically the best and attempt 4 the
  worst (tick 7: perfect welcome → teleport → folder-sales; tick 19: smile → couch → handshake
  → Tanya; tick 11: stay → coffee-pour → conference-room). Retry feedback (esp. multi-gate
  dumps) still pushes the 8B off-distribution. Laya plausibility notes, if emitted, had no
  visible steering effect (no plausibility events in logs).
- **M5 — Object id invention.** `*_mug`, `_desk_report`, `ana_papers`, `project_management_desk`,
  `cup` at (4,4) — the model invents holders instead of using roster ids. Zero applied object
  patches in 21 turns (same as Exp-1 open Q7).
- **M6 — Register/coherence drift.** "Walks into the office" while already inside (ticks 0,
  15), "turns to walk out the door" as the *opposite* of a stay-and-chat action (tick 12),
  conference room that does not exist (tick 11). Genre logic is fragile on this tier.
- **M7 — "Stay where you are." as NPC action still produces movement fantasies** (tick 11
  conference-room teleport; tick 17 pacing attempt). The selection tier likes stationary
  wording the consequence tier then refuses to render literally.

What the model did *well* (more of it than Exp-1): Ana's reactive beats (glance → acknowledge
→ watch-check), Dan's irritability arc (temple rub → glare → sigh → "stays put"), perceiver
correctness, and — new vs Exp-1 — actual memory/belief/thought patches on most turns
(compounding works when the model emits them).

## B. Simulation issues (engine/validator/repair bugs — model-independent)

- **S1 — Salvage still keeps hallucinated prose as canonical history (Exp-1 S2, still open).**
  Ticks 0 ("nervously approaching" with no approach), 6 ("Jeff greet Dan"), 12 ("walk out
  the door", the opposite of the action) are recorded as Jeff's turns with `(partial)` notes.
  Patch-stripping without prose re-check continues to launder fiction into history.
- **S2 — NEW, critical: two fully-corrupt consequences PASSED validation (no gate fired on
  the final attempt).** Tick 10 (Ana's turn, action: silent coffee sip) applied
  `Ana: Jeff introduces Ana to Dan.` — wrong subject (observer-as-subject), invented dialogue
  attributed to Dan, thought implants on all three actors. Tick 11 (Dan's turn, action: "Stay
  where you are") applied `Dan walks into the conference room and greets everyone.` —
  invented landmark, invented quote, observer thought implants, teleport (15,8)→(12,8).
  Turn-discipline, acting-actor-presence, action-verb-coverage and destination-grounding gates
  should each have rejected these; none did on the applying attempt. Hypothesis: the final
  (salvage/accept) path applies with weaker checking, or the gates are advisory where the
  action text is vague ("Stay…", "reaches…"). Either way the "deterministic code decides"
  guarantee (ARCHITECTURE P1) has a hole — investigate whether these went through
  `trySalvageConsequence` accept-paths or passed `validateConsequence` outright.
- **S3 — NEW: `narrative.echoes_action` vs `speech.dropped_words` jointly unsatisfiable.**
  Tick 7 attempt 1 (Ana's welcome, exact quote) was rejected for echoing the action verbatim;
  every retry that paraphrased was then failed for dropping words. Tick 19 repeated it
  (smile-welcome → fallback). For speech turns where the action *is* the utterance, verbatim
  rendering is correct — the echo gate must exempt fully-spoken actions (or the speech gate
  must accept the echo-gate's paraphrase; currently they fight and the turn dies).
- **S4 — NEW: "sit" substring false positive.** Tick 9: the *question* "where I should sit"
  triggered `action.sit_no_pose` ("action says to sit"), demanding a sit pose patch for a
  speech-only turn → fallback. Verb detection needs word-sense/boundary handling (asking
  about sitting ≠ sitting), same class as Exp-1 S4/S5.
- **S5 — "turn to face" fires the movement token.** Tick 12: "I turn to Dan" (face, not walk)
  gated `moves=true`, and the repair stepped (8,7)→(8,9) south — movement added to a
  speech turn. Extend the resumed-activity exemption concept to facing/turning-to-face
  ("turn to/toward <person>" with no step verb). When a destination IS declared the repair
  now goes the right way (tick 3 eastward ✅ — Exp-1 S1 mitigated, not fully fixed).
- **S6 — NEW: salience/planner/plausibility are unobservable.** With all three `=1`, zero
  `salience_scored` / planner-diagram / plausibility events appear in 21 turns of logs
  (only `intent_decided` + `triage_applied`). Either they ran silently (no counters) or never
  fired (planner cache? confidence gates? dynamic-mode wiring?). The Phase-5 eval needs the
  `layaEvents` histogram to distinguish "working silently" from "dead" — add per-phase
  counters even when the outcome is "no-op".
- **S7 — Best-attempt-discarded (Exp-1 S7, still open, now with receipts).** Ticks 7 and 19
  both had a near-perfect attempt 1; salvage/fallback worked from the *last* (worst) attempt.
  Keep the attempt with fewest hard-gate errors for salvage; abort retries early when
  hard-error count grows two attempts in a row.
- **S8 — State/emotion coherence still weak (Exp-1 S8).** All three actors read
  "near the ana's desk" at the end though Dan is 5 cells away; Jeff "nervous" for 21 ticks.
  Cosmetic.
- **S9 — `diagnose-ai` "engine wiring" FAIL is pre-existing and unrelated to live runs**
  (`Cannot read properties of undefined (reading 'trim')` in the stub-selection check —
  reproduced before the run and after). Fix the stub path so the gate is green again.
- **S10 — `.env` default `OLLAMA_MODEL=qwen3:14b` is not installed** (only the two
  documented recommended models are pulled). `diagnose-ai:live` warns every run. Either pull
  qwen3:14b via `setup:ollama` or default `.env.example`/`.env` back to
  `fluffy/l3-8b-stheno-v3.2`.

What the simulation did *well*: turn discipline held on *patches* (no hallucinated id entered
the store in 21 turns); honest history (`(not done)`, `(partial)` + codes) made every failure
auditable; perceivers correct; deterministic memory-append floor works (memories 6/7/8 vs
Exp-1's stuck-at-1); movement repair direction correct when the destination is declared;
no crashes; per-turn latency acceptable for local 8B.

## C. Action items

Model-side (prompts/routing, no validator changes):
1. Roster-discipline line + negative Anton/Tanya example in the consequence prompt; repeat the
   3-id roster in retry feedback (Exp-1 item, still valid — base rate unchanged by Laya).
2. Route *user-turn* consequence through the capable tier when available (Exp-1 item; this run:
   4/7 user moves went fallback/partial vs 4/14 NPC — user turns are the most visible failures
   and get no intent-narrowing today).
3. Exempt fully-spoken actions from `echoes_action`, or define the canonical form once
   ("quote the utterance, narrate only the non-speech frame") so S3 stops killing perfect turns.
4. `prop`/object auto-hint examples (typing→`prop:laptop`, sip→`prop:cup` + roster object ids);
   small models will not invent the patch convention unaided (M5, zero object patches again).

Simulation-side (ordered by impact):
5. **S2 first**: trace ticks 10/11 accept-paths; re-run the full gate suite after any
   patch-stripping/salvage accept; add a regression test (sip-action → Jeff-subject narrative
   must reject; stay-action → teleport narrative must reject). P1 depends on it.
6. **S3**: make echo-vs-quote consistent (exempt quoted-speech turns from the echo gate).
7. **S1/S7**: salvage from the best attempt (fewest hard-gate errors), and re-check prose gates
   (unknown-actor, observer-subject) after patch-stripping — or synthesize the salvaged
   narrative from the action text; never implant thoughts naming stripped actors.
8. **S4/S5**: word-sense movement verbs — "where I should sit" (question) and "turn to Dan"
   (facing) are not locomotion. Boundary + sense checks before `moves=true`.
9. **S6 (laya observability)**: log one event per phase per turn even on no-op
   (`salience_scored`, planner fallback/cache-hit, plausibility note/none) so the Phase-5
   `layaEvents` histogram can tell "ran" from "dead".
10. **S9/S10**: fix the `diagnose-ai` stub wiring FAIL; align `.env` model default with what
    `setup:ollama` actually pulls.

## D. Laya verdict (the question this run was designed to answer)

*Does utilizing the decision model more give better quality for local small LLMs?*
**Partial yes — for decisions; not yet for rendering.**

- Choosing got better: intent cascade ran 14/14 NPC turns; proposals narrowed to 2–3 options
  on about half the NPC turns; Laya selection needed chat fallback only 4 times (always
  recovered); the chat SemanticJudge was fully replaced (**0 judge LLM calls** vs ~1/turn
  before) with no judge-attributed failure visible; NPC fallback rate more than halved
  (43%→19%) and clean-turn rate nearly tripled (24%→62%).
- Rendering did not: consequence generation — the tier Laya deliberately does not touch — is
  still the bottleneck (36 failures, retry divergence, Anton/Tanya inventions, quote drops,
  zero object patches). User turns, which skip proposal/selection entirely, still fail the
  most (4/7). Planner/plausibility left no trace in the logs, so their contribution is
  currently unmeasurable (S6).
- Thesis check (LAYA_PLAN §8): "small models fail at choosing/formatting, not writing" is
  half-confirmed. Choosing/formatting *did* improve under Laya. But the 8B's *writing* —
  grounding prose to the action text without inventing people, rooms and opposite-day stage
  directions — remains the dominant failure source, and no decision cascade stands between
  the writer and the world store except the validator (which S2 shows has a hole).

Practical consequence: keep Laya ON for the decision subtasks (selection, judge, triage —
measured wins, ~33 ms each), fix the S2 gate hole and the S3/S4/S5 verb gates before pushing
more load onto generation, and make S6 observability the precondition for any
planner/plausibility rollout claims.

Repro: `saves/exp2-laya-debug.json`, `logs/exp2_laya_m1.jsonl` … `m7.jsonl`,
driver `/tmp/opencode/exp2-round.ts` (per round:
`npx tsx /tmp/opencode/exp2-round.ts '<action>' saves/exp2-laya-debug.json <session>`),
env overrides in the driver header. Laya: `laya-serve` on CUDA (3 checkpoints),
live probe `diagnostics ping → winner p=0.99` during the run.
