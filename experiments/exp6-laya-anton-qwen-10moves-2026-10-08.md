# Experiment 6: 10 user moves, local Laya + qwen3:14b, text mode, debug on

Date: 2026-10-08. Scenario: `scenarios/office-anton.json` (you play Anton, the new
backend hire; NPCs Tanya — former Sixt coworker who referred you — and Dana, the
recruiter). Fourth run on this scenario (Exp-3/4/5 were the first three), directly
comparable in shape: same roster, same Laya-max env, same reactive-user driver.
Setup change vs Exp-5: the hard-tier chat model is now **`qwen3:14b`** (14.8B,
Q4_K_M, ~9.3 GB, pulled this run: `ollama pull qwen3:14b`), configured as the
default in `README.md`, `.env.example`, `.env` (`OLLAMA_MODEL=qwen3:14b`), plus
drive-by alignment in `src/llm/provider.ts` (`DEFAULT_MODEL` + `RECOMMENDED_MODELS`),
`scripts/setup-ollama.sh` (default pulls qwen3 + stheno + llama3.2, `--only qwen3`),
and `scripts/diagnose-ai.ts` ("all recommended models" wording). Simple tier stays
`huihui_ai/llama3.2-abliterate:3b`; Laya fully on (`LAYA_MODE=dynamic
LAYA_SELECTION=1 LAYA_JUDGE=1 LAYA_TRIAGE=1 LAYA_SALIENCE=1 LAYA_PLANNER=1
LAYA_PLAUSIBILITY=1`, `LAYA_URL=http://127.0.0.1:8000`, laya-serve alive, pre-run
`diagnose:ai:live` 19 passed / 0 failed). Debug trace captured
(`NPC_LOG_PROMPTS=1`, `LLM_JSON_MODE=1`). Driver: `runTurn` per turn with reactive
user text (waited for my turn, then acted on circumstances — greetings, questions,
coffee, desk-seeking, lounge); 1 user turn + NPC turns until control returns (the
same engine path `src/ui/text/textUi.ts` uses); state in
`saves/exp6-laya-anton-qwen.json`, single trace in `logs/exp6_laya_qwen.jsonl`
(session `exp6_laya_qwen`, 1165 entries), driver `exp6-round.ts`.
30 turns total, ticks 0–29, **~181 min engine span (≈6.0 min/turn — ~26× slower
than Exp-5's 13.7 s/turn)**. Timing per round (wall): 15:09, 14:51, 20:51, 16:31,
14:16, 20:39, 25:52, 23:35, 10:53, 18:25. A pre-run attempt with the default
`LLM_TIMEOUT_MS=60000` burned 10 min and timed out on the first consequence call
(`ollama: timed out after 60000ms` in the trace); all 10 recorded rounds ran with
`LLM_TIMEOUT_MS=300000`. qwen3:14b sits half in VRAM (7.8 GB of 16 GB, rest on
CPU — `llama-server` at ~355% CPU) with server ctx 4096, and thinks on every call
(~120 reasoning tokens even for a 16-token prompt), so each of the ~110 chat calls
costs minutes.

## How the scenario unfolded (user moves 1–10, ticks 0–29)

1. Greet room, walk toward Tanya's desk → user **applied** (moved (16,2)→(11,5);
   `Anton greets the office` — applied, but my intro quote dropped). Tanya **partial**
   (`'I need help with the report, Anton.'` — quote kept, but the *newcomer* is
   asked for report help: role-reversed). Dana **full** (`types rapidly on the
   keyboard` — stationary, honest, except `prop:null`: typing with empty hands).
2. Step closer, offer help with the report → user **applied movement, dropped
   speech** ((11,5)→(7,7) adjacent, narrative `examines the laptop`, my question
   gone). Tanya **fallback** (mug-sip tea, 1st of 2). Dana **full** (`remains in
   place`).
3. Stay put, ask about morning/test plan → user **partial** (stationary speech
   unsatisfiable; `Anton greets the office`, 2nd time — movement-less speech
   downgraded). Tanya **fallback** (same mug-sip, 2nd identical). Dana **applied with role drift**
   (`'Hey Anton, can you review this test case?'` — quote kept, but a *recruiter*
   assigning test review).
4. Turn to Dana, introduce + ask hiring roles → user **fallback with first-person
   echo** (`Anton tried: I turn toward Dana and say: … (not done)` — raw user
   text echoed with `I`). Tanya **applied but corrupt** ((8,7)→(8,6),
   `Tanya: approach the stranger` — prefix stutter, and Anton the ex-coworker is
   `the stranger`). Dana **applied with thin-air prop** (`opens the laptop`,
   `prop:null`→`laptop` with no pickup).
5. Walk to coffee machine, pour coffee → user **partial** ((7,7)→(3,3), 5.7-cell
   capped step toward the machine, but narrative `Anton greets the office` 3rd
   time — pour vanished). Tanya **applied object patch** (`picks up her mug`,
   `prop:laptop`→`cup` — first applied pickup in six runs). Dana **full**
   (`nods toward Tanya's desk`).
6. Step to machine, pick up clean mug, pour → user **APPLIED pickup**
   ((3,3)→(2,2), `prop:null`→`cup`, `Anton picks up the mug` — pour dropped but
   pickup grounded). Tanya **applied** (`'Hey Dana, can I borrow your laptop for
   a moment?'` — quote kept, situationally fair: her hands hold a mug). Dana
   **full** (`greets Tanya`).
7. Sip coffee, walk to ANTON desk, sit → **user fallback** (sip+walk+sit combo
   unsatisfiable; first-person echo again). Tanya **fallback** (`get up from
   chair` — bare infinitive, no subject; 1st of 2). Dana **applied with role
   drift** (`'Tanya, can I ask for your help with the test case?'` — recruiter
   doing QA work).
8. Pure speech from machine: coffee praise + test-plan request → user **PARTIAL
   with honest marker** (`Anton greets the office. (partial) [partial:
   [speech.question_dropped] …]` — 4th stub, but the validator *says so*).
   Tanya **fallback** (same `get up from chair`, 2nd). Dana **fallback**
   (papers-shifting, 1st of 3 variants).
9. Walk to lounge sofa, look around → user **applied** ((2,2)→(2,8), exact 6-cell
   capped step, cup kept — but narrative stub 5th time and `state: near Anton's
   chair` while far from it). Tanya **stub-contaminated** (`Tanya greets the office` —
   the attractor jumps actors). Dana **fallback** (mug-shifting micro-intent).
10. Pure speech thanks + laptop setup (mirrors Exp-5 move 10) → user **applied
    but invented** ((2,8)→(4,10) toward desk, cup kept, `state: at Anton's desk`
    — yet speech replaced: `Anton says, "Can I borrow your pen?"` — my thanks
    dropped, a pen question invented from nowhere). Tanya **applied, reasonable**
    (`'Hey, Anton, can I ask you a question about the onboarding process?'` —
    right direction for a newcomer). Dana **fallback** (papers-shifting, 3rd).

Net world mutation after 30 turns: Anton
(16,2)→(11,5)→(7,7)→(3,3)→(2,2)→(2,8)→(4,10) — crossed the room in capped steps,
reached the machine, kept the cup to the end; Tanya (8,7)→(8,6) at tick 10 and
froze, `prop:laptop`→`cup` at tick 13, `state` reads `at Tanya's chair` while
*not* on the chair cell (8,7); Dana never moved (15,11) all 30 turns, `prop:null`
→`laptop` at tick 11; **2 scene-object description changes** (first non-zero
object mutation in six runs: `tanya_mug` → `Tanya is holding her mug` — true;
`tanya_papers` → `Tanya's papers now have a coffee stain from Anton's cup` —
**phantom**: Anton never touched those papers); memories compound (Anton 8,
Tanya 9, Dana 8) including 5× `greets the office` stubs and the `stranger` line;
emotions moved for two (Anton `nervous`→`happy`, Tanya `focused`→`anxious`;
Dana `stressed` × 30); goals untouched.

NPC reasonableness: Tanya never answered three direct questions (report offer,
morning, test plan); Dana never answered the hiring question either and spent
the run on test cases (recruiter doing QA ×3); the `stranger` label, the pen
invention, and the phantom stain all entered canonical history. Bright spots —
the best locomotion discipline yet (**zero teleports**, every step ≤6 cells),
Dana stayed at his desk all run (no Exp-5-style abandonment), two grounded
pickups, cup/prop continuity for 15 ticks, zero invented people, and no S4-type
false positive.

## Turn statistics (from `logs/exp6_laya_qwen.jsonl`, history cross-checked)

| outcome | ticks (history) | count | Exp-5 | Exp-3 |
|---|---|---|---|---|
| applied (narrative kept, no marker) | 0, 5, 13, 14, 15, 17, 24, 25, 27 | 9/30 (30%) | 9/30 (30%) | 5/30 (17%) |
| partial-applied | 1, 2, 3, 6, 8, 10, 11, 12, 16, 20, 21, 28 | 12/30 (40%) | 2/30 (7%) | 12/30 (40%) |
| fallback `tried: … (not done)` | 4, 7, 9, 18, 19, 22, 23, 26, 29 | 9/30 (30%) | 19/30 (63%) | 13/30 (43%) |

Totals: 79 `validation_failed` records (**222** coded gate hits — vs Exp-5's
664, i.e. fewer attempts per turn but each slower), 54 `retry_started`
(13 `retry_aborted`), 84 `consequence_completed` vs 25 `consequence_failed`,
15 `consequence_lenient_repair`, 4 `movement_repaired` + 1
`movement_repair_resteered` (**0 vetoed** — the veto path never fired),
21 `salvage_evaluated` / 21 `salvage_best_attempt` (3 `salvage_prose_synthesized`),
`proposal_failed` **53** (see S7), `semantic_completed` (chat judge) **0**
(84 `semantic_resolved` via Laya judge + 84 disagreements), `intent_banned` 1 +
`selection_substituted` 1 (tick 25 — the ban path *works*), `repair_target_
disagreement` 8. User turns: 4 applied / 4 partial / 2 fallback (moves 1, 6, 9,
10 applied; moves 4 and 7 fell back — both multi-verb combos).

Top failure codes (222 hits): `movement.no_position_change` 39,
`movement.declared_without_patch` 22, `narrative.observer_as_subject` 22,
`object.unknown_id` 19, `turn_discipline.observer_moved` 12,
`movement.narrated_without_patch` 12, `turn_discipline.observer_state_change`
11, `turn_discipline.acting_actor_not_patched` 11, `speech.question_dropped` 11,
`state.prop_state_mismatch` 8, `speech.invented_dialogue` 7,
`state.moved_while_sitting` 6, `pose.sit_no_chair` 5,
`movement.not_closer_object` 5, `action.sit_no_pose` 4.

### Laya metrics

| metric | Exp-6 (qwen3:14b) | Exp-5 (stheno 8B) |
|---|---|---|
| fallback rate | 30% (9/30) | 63% (19/30) |
| applied rate | 30% (9/30) | 30% (9/30) |
| partial rate | **40% (12/30)** | 7% (2/30) |
| judge chat-LLM calls | **0** | 0 |
| `intent_decided` | 20/20 NPC turns | 20/20 |
| `planner_diagram_resolved` | 20/20 | 20/20 |
| `plausibility_scored` | 75 events | 80 |
| `salience_scored` / `triage_applied` | 21 / 16 | 11 / 7 |
| `intent_banned` + substituted | **1 (tick 25, `get up from chair` — ban+substitute fired end-to-end)** | 1 (ban only) |
| `liveness_applied` | **0** | 2 |
| `accept_gate_rejected` | **0 (S4 not repeated)** | 1 (false +) |
| `movement_repaired` / `resteered` / vetoed | **4 / 1 / 0** | 5 / 6 / 8 |
| `proposal_failed` | **53** (repetition-guard majority) | 4 |
| engine span | **~181 min (~6.0 min/turn)** | ~411 s (~13.7 s/turn) |

## A. Model issues (small-model hallucination and misses, not engine bugs)

- **M1 — The `greets the office` stub attractor (new worst tic).** Five of ten
  user turns (ticks 0, 6, 12, 21, 24) rendered as `Anton greets the office.`
  regardless of input (intro, morning questions, pour request, coffee praise,
  lounge walk), then jumped actors (`Tanya greets the office`, tick 25). It is
  movement-compatible filler: whenever speech grounding fails but a step
  applies, qwen emits the generic greeting instead of the typed words. Six runs'
  first cross-actor phrase virus. (`question_dropped` 11, `no_speech_rendered`
  3; 409 trace mentions.)
- **M2 — Quote dropping + invention.** My report/morning/test-plan/thanks quotes
  never survived; tick 27 replaced thanks+setup with `Can I borrow your pen?`
  (`invented_dialogue` 7) — a stranger interaction invented from nothing while
  the typed utterance vanished. Quotes survive only when short and simple
  (Tanya's borrow-laptop / onboarding lines).
- **M3 — Observer-as-subject persists (45 hits).** Tick-0 attempt-1 implants
  `tanya`/`dana` thoughts on Anton's turn (`Why is he using my desk?`,
  `probably a power play`); `observer_moved` 12 + `observer_state_change` 11
  across retries. The model still treats the viewpoint character as writable.
- **M4 — Role/social incoherence (densest yet).** `approach the stranger` for a
  referred ex-coworker (tick 10); recruiter Dana on test cases ×3 (ticks 8, 20,
  23); Tanya asking the day-one newcomer for report help (tick 1); Anton's own
  thoughts read `Annoyed but polite — need to finish the report` / `Need to
  review her work` — the newcomer inherits QA homework (identity bleed).
- **M5 — Object grounding: first successes, same ceiling.** Two real pickups
  applied (Tanya's mug tick 13, coffee mug tick 15, props tracked 15+ ticks) —
  but pour/sip/sit/type all still die (`pour_no_patch`/`pour_too_far`,
  `sit_no_pose` 4+3, `prop_state_mismatch` 8: Dana typing at `prop:null` tick 2,
  phantom laptop tick 11), plus a phantom effect (`coffee stain from Anton's
  cup` on papers he never touched). The tier can now *hold* things, not *use*
  them.
- **M6 — Locomotion: best run yet.** Every applied step ≤6 cells and toward the
  named target ((7,7)→(3,3) 5.7, (2,2)→(2,8) exactly 6, (2,8)→(4,10) 2.8);
  **zero teleports** (Exp-5 had two 5–6-cell jumps). `not_closer_*` only 6,
  `blocked_position` 3, `unexpected_move` 2. Qwen respects the grid; it just
  can't narrate the walk honestly (M1 covers every arrival).
- **M7 — Repetition loops the guard must catch.** Identical mug-sip fallbacks
  ×2, `get up from chair` ×2 (banned on the 3rd — the one ban that worked),
  Dana papers ×3 near-identical variants that evade string-match banning;
  ~30 `proposal_failed` rejections are `repeats recent action … (same intent)`.
  The model re-offers dead intents verbatim until banned.
- **M8 — First-person echoes on user-turn fallbacks.** Ticks 9, 18 canonicalize
  the raw user text (`Anton tried: I turn…`, `I take a sip…`) — the user's `I`
  leaks into third-person history. NPC-voice failure, user-turn flavor.
- **M9 — Memory compounding preserves fiction.** 5× stub greetings, the
  `stranger` line, and the phantom stain are now permanent "memories" (8/9/8
  entries). Deterministic append is faithful to corrupt canonicals.
- **M10 — Roster discipline: fourth clean run.** Zero invented people;
  `unknown_actor` 3 / `object.unknown_id` 19 all rejected at patch level.

What the model did *well*: grid-scale movement, prop continuity once grounded,
short-quote fidelity, Dana's desk discipline (never drifted), in-character
thoughts, no roster invention.

## B. Simulation issues (engine/validator/repair bugs — model-independent)

- **S1 — Throughput collapse: 14B local costs 26× (NEW).** ~6 min/turn vs 13.7 s
  (Exp-5); the 60 s default `LLM_TIMEOUT_MS` timed out a 10-min first attempt
  before recording; each turn burns ~3–4 chat calls × minutes (partial VRAM
  offload + per-call thinking overhead). The engine has no model-aware timeout
  or slowness signal — operators discover it by burning a turn. Fix: scale
  default timeouts / warn when a model responds slower than its budget, and
  record per-model latency in diagnose.
- **S2 — Token budget ignores thinking models (NEW, worst silent killer).**
  One sampled `proposal_failed` shows `completionTokens: 1500` = exactly
  `LLM_MAX_TOKENS`: qwen's reasoning + JSON overflowed the flat 1500 budget
  (`empty response (finish_reason=length)` ×5, `truncated or unbalanced JSON`
  ×2). The flat cap counts reasoning against the response. Fix: strip/ignore
  `<think>`/reasoning tokens from the budget (or send `think:false` / raise
  per-task caps for thinking models — Exp-6 item 6 only tunes by task, not by
  model).
- **S3 — User-turn speech still the weakest class (Exp-5 S1, still open).**
  4/10 applied, but all four applied user turns (moves 1, 6, 9, 10) kept the
  movement and dropped or replaced the speech (stub ×3, pen invention ×1);
  move 8's question survived only as a labeled partial, moves 3–4 died outright.
  User turns bypass Laya narrowing *and* the capable tier is a no-op here
  (single local tier). Partial-marking (tick 21's honest `[partial:
  question_dropped]`) is progress — the failure is now *visible* — but
  visibility isn't grounding.
- **S4 — Phantom/corrupt canonicals still pass (Exp-2 S2 / Exp-5 S3, still
  open, new receipts).** `the stranger` (tick 10), the pen invention (tick 27),
  the coffee stain (papers), the thin-air laptop (tick 11) — all applied with
  patches intact. The good news: the Exp-5 S4 *false positive* did NOT repeat
  (0 `accept_gate_rejected`); the bad news is symmetric — the accept path still
  doesn't re-check observer-as-subject / stale-label / invented-contact after
  salvage. Still needs the three regression tests.
- **S5 — State/pose labels still weak (Exp-1 S8 / Exp-5 S5, still open).**
  `at Tanya's chair` for (8,6) vs chair (8,7); `near Anton's chair` at (2,8)
  vs chair (4,7); `pose:sit` on non-chair cell (`sit_no_chair` 5,
  `moved_while_sitting` 6). Template labels from nearest *owned* landmark
  without cell verification.
- **S6 — Object patches NONZERO for the first time (Exp-5 S6 → measure
  moved).** 2 description patches + 2 prop pickups applied (vs 0 in five
  runs). The honest update: grasp verbs now ground; *use* verbs (pour/sip/sit/
  type) still never do. Next step stays: deterministic prop stubs for use-verbs
  or stop selecting them.
- **S7 — Repetition-guard carries the proposal layer (Exp-5 S8 → half-closed).**
  ~30/53 `proposal_failed` are same-intent repetition rejections — the guard
  earns its keep — and tick 25 banned `get up from chair` + substituted live
  (close the Exp-4 S3 item once a second case lands: Dana's papers ×3 evaded it
  via paraphrase). Normalize keys by cluster (verb-form/object-strip), not
  string.
- **S8 — Retry cost without divergence payoff (Exp-1 S7, still open).** 54
  retries / 13 aborts; attempt-1 systematically best; at ~2–6 min a call the
  4×-latency tax is now hours, not seconds. Early-abort on growing hard-error
  counts is now urgent, not nice-to-have.
- **S9 — `.env` default FIXED this run (close Exp-5 S9).** `qwen3:14b` pulled
  (9.3 GB, `ollama list` verified), default in README + `.env.example` + `.env`
  (+ provider/setup/diagnose alignment); `diagnose:ai:live` 19 passed / 0
  failed with the configured model present. Remaining: `setup-ollama.sh`
  default now pulls ~16 GB (three models) — document the disk cost.
- **S10 — Salience/triage still unvalidated (Exp-5 S10, still open).** 21
  salience / 16 triage / 75 plausibility events, yet memories still bank stubs
  and fiction; emotions moved 2/3 with no attribution (gate vs lenient-repair
  writes). Measure memory-precision before tuning thresholds.

What the simulation did *well*: validator held roster discipline at patch level
(19 unknown-id rejections); movement repair committed capped steps instead of
vetoing (4 + 1 resteer, **0 vetoes** — Exp-5 S2's freeze is gone: Anton moved on
4/5 walk turns); partial-marking tells the truth (12 partials with reasons);
intent-ban+substitution fired end-to-end; no accept-gate false positive;
fastest *honest* locomotion run (zero teleports).

## C. Action items

Model-side (prompts/routing, no validator changes):
1. Break the greeting-stub attractor: add a negative `Anton greets the office`
   example to consequence prompts (fully-spoken actions must quote verbatim,
   never substitute a generic greeting) — M1 is 5/10 user turns.
2. Route *user-turn* consequence through a genuinely capable tier when available
   (S3; 0/10 user turns preserved their typed speech and bypass every Laya
   gain — even the 4 "applied" ones kept only the movement).
3. Thinking-model budget: send `think:false` (verified: works on the OpenAI
   endpoint, 5.3 s vs 7.7 s on a toy prompt, fewer completion tokens) or raise
   `LLM_MAX_TOKENS_{PROPOSAL,CONSEQUENCE}` for `qwen3*` so reasoning doesn't
   eat the JSON budget (S2; 1500-token truncation).
4. Renderability-matched proposals: contact/use verbs must carry grounding
   (distance ≤2, roster object id) or not be suggested (M5/S6).

Simulation-side (ordered by impact):
5. **S2 first (cheapest, kills the most failures):** per-model token budgets /
   thinking-aware caps; add the tick-4 tick-shape regression (proposal output
   hitting exactly `maxTokens` must not truncate JSON — raise, don't retry).
6. **S1:** model-aware timeouts + slowness signal (default 60 s is unusable for
   14B local; the 300 s override should be derived, not tribal knowledge) and
   per-model latency in `diagnose:ai:live`.
7. **S4:** full gate-suite re-check after any patch-stripping/salvage accept;
   add the three regression tests (stay→teleport, stale `enters`, plus the two
   new receipts: `stranger`-label for a known coworker, invented-contact stain).
8. **Voice gate (Exp-4 S4, still open):** fail fast on first-person echoes in
   *user-turn* fallbacks too (M8 — `Anton tried: I …` must never be canonical).
9. **S7:** cluster-normalized intent-ban keys (verb-form/object-strip) so
   papers-shifts ×3 ban like chair-stands ×2 did.
10. **S5:** verify `state`/`pose` against cells on every x/y change (chair-cell
    check for `sit`, landmark-cell check for `at`).
11. **S8:** early-abort retries when hard-error count grows two attempts in a
    row (at 6 min/turn, divergence costs hours).
12. **S6:** deterministic prop stubs for use-verbs (sip→keep `cup` + sip
    narrative; typing→require `laptop`) — pickups now work, uses don't.
13. **S9/S10 leftovers:** document the ~16 GB full-pull disk cost in README;
    measure memory-precision and bind the salience gate.

## D. Laya verdict

*Does utilizing the decision model more give better quality for local small LLMs?*
**Decisions: yes, saturated (third time). Rendering: the binding constraint is
now the generator's size-speed trade, not the decider.**

- The decision layer stayed fully utilized and *more* effective: 20/20 intents,
  20/20 planner diagrams, 0 chat-judge calls, and the first end-to-end
  intent-ban→substitution (tick 25). Fallback rate *halved* vs Exp-5 (30% vs
  63%) — but the gains moved into partials (40% vs 7%), i.e. Laya + validator
  honesty now *label* failures instead of passing or killing them.
- The bigger model bought locomotion honesty (zero teleports, capped steps,
  first grounded pickups) and paid for it in speech (the stub attractor) and
  time (26× slower). Generation-tier properties still dominate end-to-end
  quality; no further decision delegation will fix greeting-stubs or pen
  inventions.
- Practical consequence: stop pushing decisions onto Laya; the next quality
  dollar is (a) thinking-aware token budgets (S2), (b) model-aware timeouts
  (S1), (c) accept-path gates for corrupt canonicals (S4) — plus the
  task-completion eval harness, since fallback-rate alone now hides stub
  "successes": by task completion Anton reached the machine, held the cup,
  neared his desk — but asked 5 questions and got 0 answers.

Repro: `saves/exp6-laya-anton-qwen.json`, `logs/exp6_laya_qwen.jsonl`, driver
`exp6-round.ts` (per round: `LLM_BACKEND=ollama LLM_SIMPLE_BACKEND=ollama
OLLAMA_MODEL=qwen3:14b LLM_SIMPLE_MODEL=huihui_ai/llama3.2-abliterate:3b
LAYA_MODE=dynamic LAYA_SELECTION=1 LAYA_JUDGE=1 LAYA_TRIAGE=1 LAYA_SALIENCE=1
LAYA_PLANNER=1 LAYA_PLAUSIBILITY=1 LAYA_URL=http://127.0.0.1:8000
NPC_LOG_PROMPTS=1 LLM_JSON_MODE=1 LLM_USER_CAPABLE_TIER=1 LLM_TIMEOUT_MS=300000
npx tsx ./exp6-round.ts '<action>' saves/exp6-laya-anton-qwen.json
exp6_laya_qwen`). Laya: `laya-serve` on CPU/CUDA, live during the run. User
texts (10, in order): greet + walk to Tanya; closer + report-help offer; stay +
morning/test-plan questions; turn to Dana + hiring question; coffee-machine
walk + pour; machine step + mug pickup + pour; sip + ANTON-desk walk + sit;
loud coffee praise + test-plan request; lounge-sofa walk + look; thanks +
laptop setup. Config defaults: `qwen3:14b` in `README.md`, `.env.example`,
`.env` (+ `src/llm/provider.ts`, `scripts/setup-ollama.sh`,
`scripts/diagnose-ai.ts`); model verified via `ollama list` + `diagnose:ai:live`
(19 passed / 0 failed).
