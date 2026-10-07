# Experiment 5 — office-anton.json, 7 adaptive user turns, local 8B, post-Exp-4 fixes

## 1. Command used

```bash
npm run start:text -- scenarios/office-anton.json \
  --provider ollama --model fluffy/l3-8b-stheno-v3.2 \
  --debug --no-autosave
```

Interactive via `tmux` session (`exp5`): one `action:` line typed per user turn
**after reading the NPC turns** that followed the previous action.
Same 7-turn protocol as Exp-4 (turn 5 adapted: walk toward Dana + ask, no
handshake-from-afar), 7 user turns → **ticks 0–20 (21 turns)** in
`anton → tanya → dana` rotation. `quit` at the end.

- Full terminal transcript (debug blocks): `/tmp/exp5_full.log` (797 lines).
- Session JSONL: `logs/text_muy6s0zv.jsonl` — 21 `turn_completed`,
  79 `consequence_completed`, **82 `validation_failed` /
  45 `consequence_failed`**, **19 `fallback_used`** (every tick except 3 and
  15), **1 `partial_applied`** (tick 3), **1 `validation_passed`** (tick 15),
  **1 `movement_repaired`** (tick 15), **20 `salvage_evaluated`** (new log
  event — Exp-4 item 8 implemented), 82 `judge_vs_effects_disagreement`.
- Applied `objectPatches` empty on **all 21 ticks**; pose changed **1×**
  (Anton stand→sit tick 15); `prop` changed **0×**.
- All tick-by-tick claims below cross-checked against JSONL
  (`validation_failed`, `salvage_evaluated`, `partial_applied`,
  `turn_completed` world positions), not just the debug story text.

World positions after each applied turn (from `turn_completed`):

| tick | actor | Anton | Tanya | Dana | applied? |
|---|---|---|---|---|---|
| 1 | anton | (16,2) | (8,7) | (15,11) | FALLBACK |
| 2 | tanya | (16,2) | (8,7) | (15,11) | FALLBACK |
| 3 | dana | (16,2) | (8,7) | (15,11) | FALLBACK |
| 4 | anton | **(11,5)** | (8,7) | (15,11) | **PARTIAL** (salvaged clamp-step) |
| 5 | tanya | (11,5) | (8,7) | (15,11) | FALLBACK |
| 6 | dana | (11,5) | (8,7) | (15,11) | FALLBACK |
| 7 | anton | (11,5) | (8,7) | (15,11) | FALLBACK |
| 8 | tanya | (11,5) | (8,7) | (15,11) | FALLBACK |
| 9 | dana | (11,5) | (8,7) | (15,11) | FALLBACK |
| 10 | anton | (11,5) | (8,7) | (15,11) | FALLBACK |
| 10 | tanya | (11,5) | (8,7) | (15,11) | FALLBACK |
| 12 | dana | (11,5) | (8,7) | (15,11) | FALLBACK |
| 13 | anton | (11,5) | (8,7) | (15,11) | FALLBACK |
| 14 | tanya | (11,5) | (8,7) | (15,11) | FALLBACK |
| 15 | dana | (11,5) | (8,7) | (15,11) | FALLBACK |
| 16 | anton | **(6,8) sit** | (8,7) | (15,11) | **ok via repair** (near Anton's desk) |
| 17 | tanya | (6,8) | (8,7) | (15,11) | FALLBACK |
| 18 | dana | (6,8) | (8,7) | (15,11) | FALLBACK |
| 19 | anton | (6,8) | (8,7) | (15,11) | FALLBACK |
| 20 | tanya | (6,8) | (8,7) | (15,11) | FALLBACK |
| 21 | dana | (6,8) | (8,7) | (15,11) | FALLBACK |

Headline: **Anton walks in two capped steps (16,2)→(11,5)→(6,8) and sits —
the first locomotion of any actor since Exp-3 — but everything else is
frozen: Tanya and Dana never move a cell, nothing is touched, 19/21 turns
fall back.** Physics got *mobile* (for the user actor) and *tighter*
simultaneously.

## 2. The 7 user turns (adaptive play as Anton)

| # | tick | Anton's action | Why this action |
|---|---|---|---|
| 1 | 0 | Smile/wave from entrance, "Hi Tanya! Great to see you again after Sixt. And hello Dana, I'm Anton, the new backend dev!" | Same as Exp-4: audibility + per-addressee patches |
| 2 | 3 | Walk over to Tanya and ask "Tanya, could you show me where my desk is?" | Same as Exp-4: movement + direct-question answering |
| 3 | 6 | "Thanks Tanya!", walk to west-side desk, sit, "Is this my spot?" | Same as Exp-4: landmark + sit pose + speech triple |
| 4 | 9 | Walk to NW coffee machine, pour coffee, "I need caffeine after that trip." | Same as Exp-4: long walk + object + quote |
| 5 | 12 | Walk toward Dana's desk, wave, "Dana, what should my first backend task be?" | Same as Exp-4 adapted: walk + ask |
| 6 | 15 | Walk to desk with ANTON sign, sit, open laptop to set up | Same as Exp-4 + sign disambiguation |
| 7 | 18 | Thank both, head toward west-side desks to set up laptop | Same as Exp-4, no arrival claimed (partial-progress phrasing) |

## 3. What happened per tick (ground truth)

- **0 (user, FALLBACK):** in-place greeting → consequence invents a walk to
  (12,7) + drops both quotes + patches no addressee. All 4 correctly
  rejected (reverse verb-drop "moved=true but no position change", quote-drop,
  addressee-missing). `salvage_evaluated`: ineligible (hard gates fail).
  Correct fallback.
- **1 (Tanya, FALLBACK):** "Put my test plans aside…" (in-place) →
  consequence adds phantom movement with no coords + observer-as-subject
  ("anton says hello…"). Reverse-movement and observer-subject gates fire.
  Correct fallback.
- **2 (Dana, FALLBACK):** pick-up-mug + swivel + question → consequence
  "pours coffee" + teleports Dana (15,11)→(2,4) + drops question and mug
  patch. Non-locomotion move, quote-drop, pick-up gate all fire. Correct
  fallback.
- **3 (user, PARTIAL — the run's best turn):** walk-to-Tanya + desk question
  → all 4 attempts fail validation (quote dropped, question dropped), but
  `salvage_evaluated: eligible (movement repaired with valid patches kept)`
  and `partial_applied` fires: Anton→**(11,5)** (5.8 cells, within the 6-cell
  cap, roughly halving the 9.4-cell gap to Tanya), both actors thought-patched,
  speech nit logged as **warning** instead of failing the turn. First
  confirmed salvage. Defect: narrative "Anton greets Tanya." drops the desk
  question entirely, yet history records the raw action text ("Anton: Walk
  over to Tanya and ask…") with **no (not done) marker** — the question is
  logged as asked-and-done while the world contains only a greeting (§4.4).
- **4 (Tanya, FALLBACK):** "Stand up and walk over to Anton" → consequence
  "looks at Anton and smiles", no move, no pose. Action-side movement + stand
  gates fire. Correct fallback — first of **3 identical selections** (ticks
  4, 7, 13 + variants 16, 19).
- **5 (Dana, FALLBACK):** set-mug-down + swivel + background question →
  "Jen sets the mug…" (unknown actor Jen) + observer-as-subject. Correct ×4.
- **6 (user, FALLBACK):** thanks + desk + sit + quote → "Anton shakes
  Tanya's hand" (handshake attractor), no walk/sit/quote. Attempt 3 trips the
  cap (11,5)→(4,3) = 7.3 cells — a near-miss a clamp could have saved.
  `salvage_evaluated`: "movement repaired but hard gates still fail
  (sit + question)". Correct fallback, salvage correctly refuses (hard gates).
- **7 (Tanya, FALLBACK):** repeat of tick 4 → "Anton shakes hands with
  Tanya" observer-as-subject + observer-move. Correct fallback.
- **8 (Dana, FALLBACK):** in-place sip + speech → "Tanya sees a new
  employee…" observer-as-subject. Correct fallback.
- **9 (user, FALLBACK):** coffee run → "approaches Tanya" (wrong landmark) +
  invented "Hi Tanya, how's it going?" + no pour. Attempt 2 trips the **new
  named-landmark progress rule**: "move toward Coffee machine 8.5 cells away
  but only closes 2.2 cells: make real progress (≥4.3) or arrive". Pour and
  quote gates also fire. Correct fallback; progress rule confirmed working.
- **10 (Tanya, FALLBACK):** good proposal (walk to Anton's desk, gesture to
  Dana's) → moves *Anton* inside `tanya_desk` at (9,8) + goes to (10,12),
  away from both targets. Observer-move, inside-desk, and progress gates all
  fire. Correct fallback.
- **11 (Dana, FALLBACK):** in-place typing → "Anton shakes hands with Tanya"
  observer-as-subject + quote/pick-up gates. Correct fallback.
- **12 (user, FALLBACK):** walk-to-Dana + task question → re-introduces self
  ("Hey everyone, I'm Anton…", tick-12 amnesia) + walks to (10,4), *away*
  from `dana_desk`. Quote-drop, invented dialogue, wrong-direction, and
  missing-Dana-patch all fire. Correct fallback.
- **13 (Tanya, FALLBACK):** 3rd "Stand up and walk over to Anton" → moves
  Anton inside `anton_desk` (4,9) + observer-as-subject + stand gate.
  Correct fallback.
- **14 (Dana, FALLBACK):** set-mug + background question → "Dana greets Tanya
  and begins working", moves Dana (15,11)→(6,7) for a non-locomotion action,
  drops question and Anton patch. Correct fallback.
- **15 (user, PASS via repair):** desk + sit + open laptop → "Anton sits down
  at the small table", repair fills (6,8) (5.8-cell step from (11,5),
  adjacent-east of `anton_desk`, between the two west desks — genuinely good
  placement), **pose sit applied**. `validation_passed … repaired: true`
  after 1 retry. Defects: "open my laptop" produces **no prop/object patch**
  (attempt 1 flagged pour/brew/open, the passing attempt 2 keeps the omission
  and passes anyway — §4.5); `destinationObjectId=anton_lamp` for a desk
  walk (wrong landmark, §4.3); thoughts "before the interview" (hired, not
  interviewing); narrative says "small table" (it's a desk). History records
  the full action text as done although the laptop setup never happened.
- **16 (Tanya, FALLBACK):** "walk to Anton's new desk… welcome him and explain
  the layout" → handshake + observer-as-subject, drops the explanation;
  only blocker left is a missing Anton thought-patch (movement repaired
  fine). Closest NPC near-miss of the run. Correct fallback.
- **17 (Dana, FALLBACK):** in-place typing → "Anton greets Tanya…"
  observer-as-subject + unknown actor `john`. Correct ×3.
- **18 (user, FALLBACK):** thanks + west-desks walk (no arrival claimed) →
  attempts walk to (5,7) but the resolver mapped the target to
  `anton_laptop` (a prop, not furniture) and (5,7) is not closer to the
  laptop than (6,8) — "pick x,y strictly closer to Anton's laptop". Walk to
  furniture judged against a prop target (§4.3). Correct fallback per the
  letter of the rule, wrong target per its spirit.
- **19 (Tanya, FALLBACK):** walk-to-Anton + explain layout (4th variant) →
  drops speech ("renders no speech"), moves toward `tanya_laptop` instead of
  Anton. Correct fallback.
- **20 (Dana, FALLBACK):** good question ("what are you most looking forward
  to as a backend dev?") → attempt 1 patches **only observers** (Anton +
  Tanya thoughts, Dana herself unpatched — acting-actor-presence gate fires);
  final attempt "**Jeff** responds, 'Okay, Anton… project proposal'" — Jeff
  returns with a full invented patch set. Correct fallback. The 12→14→20
  task thread dies unanswered.

Totals: 19/21 fallbacks; 0/21 applied turns touch objects; sit requested 2×,
applied 1× (tick 15); stand/pour/open/pick-up requested 8+×, applied 0×;
"where is my desk?" asked 1×, answered 0×; "first task?" asked 2×, explained
0× (Dana's tick-14 explanation attempt dropped the question; tick-20
explanation never survived).

## 4. Verdict: engine vs. small-model attribution

**Post-Exp-4 fixes confirmed working (all with first-trigger repro ticks):**

1. **Salvage fires (tick 3).** `partial_applied` + `salvage_evaluated`
   (20 evaluations with eligible/ineligible + reason) is exactly the
   observability Exp-4 item 8 asked for. The tick-3 clamp-step (16,2)→(11,5)
   is the first degraded-but-advancing turn of the series.
2. **Clamp repair (ticks 3, 15).** Both Anton steps are ≤6 cells and land on
   free, path-valid cells adjacent to their targets. Zero teleports (vs 2 in
   Exp-3), zero wrong-desk passes (vs 1 in Exp-3).
3. **Named-landmark progress rule fires (tick 9).** "only closes 2.2 of 8.5
   cells" is the Exp-4-missing "halve the distance" semantics, now visible.
4. **Reverse verb-drop gates fire constantly** (moved=true with no coords on
   ticks 0, 1, 2, 3, 6, 9, 15-attempt-1, 16…); **observer-as-subject gate
   fires** (ticks 1, 5, 7, 8, 11, 13, 16, 17, 19, 20); **stand/sit/pour/
   pick-up/question/addressee gates all fire with the right taxonomy.**
   No fallback this run was caused by invented-quote requirements —
   judge grounding (Phase 1) holds for the third run straight.
5. **Honest fallback history.** Every fallback is recorded as "X tried: …
   (not done)"; memories are no longer polluted by null events at the
   history level. Exp-4 item 6 fixed for the fallback path.

**Engine misses (all engine-side, all with repro ticks):**

1. **Salvage criteria are too narrow — 1/20 eligible, fallback 90%.**
   Ticks 6, 9, 12, 18 all read "movement repaired but hard gates still
   fail: object/contact/addressee/verb-coverage stay hard". Any turn with a
   speech nit *plus* an object nit dies whole; the model almost never
   produces the clean "valid movement + speech-nit-only" shape salvage
   wants (4-axis garbage every attempt is the modal pattern). The flagship
   longevity fix contributed one turn out of 21 while the fallback rate
   *rose* 57% → 76% → **90%**. Widen or tier it: clampable-movement-only
   salvage (position + thoughts, speech/object as warnings) would have
   advanced ticks 6-attempt-3 (7.3-cell near-miss) and 9.
2. **Fallback rate is now the scenario-killer, not the backstop.**
   19/21 with a small model means Tanya/Dana produce *zero* applied turns in
   21 tries. Tighter validation without working degradation is still a
   freezer for NPCs — Exp-4's amendment stands, with numbers worse and only
   the user-actor path (salvage + repair) showing life.
3. **Destination resolution picks wrong landmarks (ticks 3, 15, 18, 19).**
   `anton_lamp` for "walk to my desk" (twice), `anton_laptop` (a prop) as a
   *walk target* for "head toward the west-side desks", `tanya_laptop` for
   Tanya's walk to Anton. Keyword-first-match with no ranking: walk targets
   should prefer furniture over props/signs, grab targets the reverse, and
   ownership ("my/his" → actor's objects) plus proximity should break ties.
   First-keyword-match is the new Jeff: wrong, but deterministic. It has not
   yet failed a turn outright (repairs land sanely anyway), but tick 18
   shows it *can*: a good walk failed "not closer to the laptop" when the
   human target was a desk.
4. **Salvaged/applied history still records wishes as facts.** Ticks 3 and
   15 log the raw action text without "(not done)" although the consequence
   dropped the desk question (tick 3) and the laptop setup (tick 15).
   Proposals later ground on the fiction (tick 16 assumes laptop setup is
   underway; tick 20 "discuss his first task in more detail" assumes the
   task was explained). Exp-4 item 6 is half-fixed: fallbacks are honest,
   partials/passes are not. Record the *narrative* (or narrative + warnings)
   as the history line for salvaged turns, not the *action*.
5. **Verb-gate inconsistency: `open` flagged then forgiven (tick 15).**
   Attempt 1 fails on pour/brew/open with no object/prop patch; the passing
   attempt 2 has the identical omission and passes. Sit is enforced
   (pose sit applied) while open-laptop in the same action is not — 0/21
   object touches across three experiments is now a gate-coverage datum,
   not just model laziness. Either `open` needs the same strictness as
   `sit` (fail without prop/objectPatch) or the triple-verb action needs a
   defined partial semantics (sit now, laptop next turn).
6. **NPC freeze is total and repetitive.** Tanya selects "Stand up and walk
   over to Anton" (or close variants) 5× in 7 NPC turns; consequences never
   converge (same omission 4/4 attempts is still the modal pattern, e.g.
   ticks 4, 7, 13). The repetition guard lists prior actions but nothing
   rejects a re-emit at proposal/selection level. Proposal-level dedup
   (reject verb+noun cores matching prior turns — Exp-4 item 10) is still
   the cheapest unimplemented fix.
7. **Memory still appends nothing and compounds nothing.** Memories are
   byte-identical to scenario init (2/3/1) after 21 turns; no summarization
   event; per-actor refresh lines do not bind the 8B ("interview" framing
   tick 15, re-introductions ticks 12/18, candidate-frame tick 20,
   third-person/observer patches). Same conclusion as Exp-3/Exp-4: prompt
   text alone doesn't bind the small model; structural fixes (honest
   salvaged-history per item 4, POV-mismatch rejection per Exp-4 item 9)
   are the remaining levers.

**Model-side (small-model noise, not engine regressions):** handshake
attractor (ticks 6, 7, 11); greeting/re-introduction loop (ticks 12, 18);
Jeff (6 validation mentions + full jeff patch set tick 20); "Consequence"
as actor (18 events); invented roster (Joe, Sarah, Jen, John); meeting/
interview hallucinations; "small table" for desk. Pronoun use was clean
this run. Error-message quality remains high — retries just never converge.

## 5. Exp-3 → Exp-4 → Exp-5 comparison (same protocol, same model)

| metric | Exp-3 (pre-fix) | Exp-4 (Phases 1–5) | Exp-5 (post-Exp-4 fixes) |
|---|---|---|---|
| fallback rate | 12/21 (57%) | 16/21 (76%) | **19/21 (90%)** |
| teleports >cap | 2 (9, 13 cells) | 0 | **0** |
| wrong-desk arrivals passing | 1 | 0 | **0** |
| object touches applied | 0/21 | 0/21 | **0/21** |
| pose/prop changes applied | 3 pose / 0 prop | 0 / 0 | **1 pose (sit) / 0 prop** |
| desk question answered | 0/2 | 0/1 | **0/1** |
| first-task explained | 0/2 | 0/2 | **0/2** |
| Anton displacement (21 turns) | ~15 cells | 0 cells | **~11.6 cells in 2 capped steps** |
| Tanya/Dana displacement | moves | 2 Tanya repairs | **0 cells** |
| judge-poisoned fallbacks | yes | none | **none** |
| salvaged/partial turns | n/a | 0 | **1 (tick 3)** |
| salvage eligibility | n/a | unlogged | **1/20 eligible** |
| fallback history honest | no | no | **yes ("tried… (not done)")** |
| stranger/candidate frames | 7+ | 8+ | **5+ (interview, re-intros, candidate, Jeff)** |
| unknown-actor rejects | ~17 Jeff-class | Jeff + 6 more names | **Jeff + Joe/Sarah/Jen/John** |

Physics is now *sound and mobile* for the user path (two legal capped steps,
a legal sit, no teleports, no wrong-desk passes, poison neutralized) and
*sterile* everywhere else (NPCs 0 applied turns, 0 touches, questions never
answered). The Exp-3 §6 conditional survives with Exp-4's amendment
sharpened: grounding, caps, progress rules, and verb gates demonstrably
work; **degradation breadth (items 1+4) is now the entire critical path.**
Re-run the soak (Phase 6) only after: (a) tiered salvage that advances
clampable movement despite speech/object nits, (b) salvaged-history honesty,
(c) destination ranking — success = Anton reaches his desk in 3–4 capped
steps with the question thread intact *and* at least one NPC applied turn
per 3-turn cycle.

## 6. Action items (ordered, each with repro tick)

Engine (correctness):

1. **Tier salvage: advance clampable movement despite speech/object nits**
   (ticks 6, 9, 12, 18). Keep position + thoughts, downgrade quote/question/
   object misses to warnings on the salvaged path. Target: salvage
   eligibility 1/20 → majority of repaired-movement turns.
2. **Salvaged-history honesty** (ticks 3, 15): history line = narrative +
   warnings, never the raw action text, when consequence dropped content.
3. **Rank destination resolution** (ticks 3, 15, 18, 19): furniture-over-prop
   for walk targets, ownership ("my/his" → actor's), proximity tiebreak.
   Repro: `anton_lamp` ×2, `anton_laptop`-as-walk-target, `tanya_laptop`.
4. **Define triple-verb semantics** (tick 15): sit-now-laptop-next vs
   all-or-nothing for sit+open in one action; enforce `open` the same way
   `sit` is enforced (or log why it is lenient).
5. **Proposal-level repetition dedup** (ticks 4, 7, 13, 16, 19): reject
   selections whose verb+noun core matches a prior turn before burning 4
   consequence attempts on them.
6. **NPC liveness floor:** if an actor falls back N consecutive times (here:
   Tanya 7, Dana 7), force a minimal in-place applied turn (thoughts-only
   reaction with addressee patch) so threads (desk question, first task)
   can advance by dialogue even when bodies cannot.

Prompting/context (small-model load-bearing):

7. **POV-mismatch rejection at selection** (tick 20 Jeff-patch, Exp-4 items
   8/19-class swaps): reject proposals/selections whose reasoning names the
   wrong actor's goals before consequence runs.
8. **Answer-the-question pressure:** a selected "explain/describe" action
   whose consequence keeps no question and no explanation (ticks 14, 20)
   is the hollow-pass class that survives every gate — unquoted-speech
   detection (Exp-4 item 3) remains open.
