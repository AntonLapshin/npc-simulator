# Experiment 4 — office-anton.json, 7 adaptive user turns, local 8B, Longevity Phases 1–5 applied

## 1. Command used

```bash
npm run start:text -- scenarios/office-anton.json \
  --provider ollama --model fluffy/l3-8b-stheno-v3.2 \
  --debug --no-autosave
```

Interactive via `tmux` session (`exp4`): one `action:` line typed per user turn
**after reading the two NPC turns** that followed the previous action.
Same 7-turn protocol as Exp-3 (turn 5 adapted: no handshake-from-9-cells;
walk toward Dana + ask instead), 7 user turns → **ticks 0–20 (21 turns)** in
`anton → tanya → dana` rotation. `quit` at the end.

- Full terminal transcript (debug blocks): `/tmp/exp4_full.log`.
- Session JSONL: `logs/text_muy4gf34.jsonl` — 21 `turn_completed`,
  68 `consequence_completed`, **69 `validation_failed` /
  41 `consequence_failed`**, **16 `fallback_used`** (ticks 0, 1, 3, 4, 5, 6,
  7, 9, 11, 12, 13, 15, 17, 18, 19, 20 = **76% fallback rate**),
  **5 `validation_passed`** (ticks 2, 8, 10, 14, 16),
  **0 partial/salvage applies**, 2 `movement_repaired` (ticks 10, 16),
  72 `judge_vs_effects_disagreement` (Phase 1 log event — fires every turn).
- Applied `objectPatches` empty on **all 21 ticks**; pose changed **0×**;
  `prop` changed **0×** (once attempted: `prop=laptop` on a rejected
  wall-embedded move, tick 18).
- All tick-by-tick claims below cross-checked against JSONL
  (`validation_failed` inputs/errors, `judge_vs_effects_disagreement`,
  `turn_completed` world positions), not just the debug story text.

World positions after each applied turn (from `turn_completed`):

| tick | actor | Anton | Tanya | Dana | applied? |
|---|---|---|---|---|---|
| 1 | anton | (16,2) | (8,7) | (15,11) | FALLBACK |
| 2 | tanya | (16,2) | (8,7) | (15,11) | FALLBACK |
| 3 | dana | (16,2) | (8,7) | (15,11) | ok (hollow, see §3) |
| 4 | anton | (16,2) | (8,7) | (15,11) | FALLBACK |
| 5 | tanya | (16,2) | (8,7) | (15,11) | FALLBACK |
| 6 | dana | (16,2) | (8,7) | (15,11) | FALLBACK |
| 7 | anton | (16,2) | (8,7) | (15,11) | FALLBACK |
| 8 | tanya | (16,2) | (8,7) | (15,11) | FALLBACK |
| 9 | dana | (16,2) | (8,7) | (15,11) | ok (identity-swapped, see §3) |
| 10 | anton | (16,2) | (8,7) | (15,11) | FALLBACK |
| 11 | tanya | (16,2) | **(4,10)** | (15,11) | ok (repaired, near Anton's desk) |
| 12 | dana | (16,2) | (4,10) | (15,11) | FALLBACK |
| 13 | anton | (16,2) | (4,10) | (15,11) | FALLBACK |
| 14 | tanya | (16,2) | (4,10) | (15,11) | FALLBACK |
| 15 | dana | (16,2) | (4,10) | (15,11) | ok (hollow, see §3) |
| 16 | anton | (16,2) | (4,10) | (15,11) | FALLBACK |
| 17 | tanya | (16,2) | **(9,7)** | (15,11) | ok (repaired, but wrong direction in prose) |
| 18 | dana | (16,2) | (9,7) | (15,11) | FALLBACK |
| 19 | anton | (16,2) | (9,7) | (15,11) | FALLBACK |
| 20 | tanya | (16,2) | (9,7) | (15,11) | FALLBACK |
| 21 | dana | (16,2) | (9,7) | (15,11) | FALLBACK |

Headline: **Anton never moved a single cell in 21 turns. Dana never moved.
Nobody sat, stood, picked up, or touched any object.** The only two position
changes in the run are Tanya's deterministic repairs. Zero teleports —
but also zero legitimate locomotion.

## 2. The 7 user turns (adaptive play as Anton)

| # | tick | Anton's action | Why this action |
|---|---|---|---|
| 1 | 0 | Smile/wave from entrance, "Hi Tanya! Great to see you again after Sixt. And hello Dana, I'm Anton, the new backend dev!" | Same as Exp-3: audibility + per-addressee patches |
| 2 | 3 | Walk over to Tanya and ask "Tanya, could you show me where my desk is?" | Same as Exp-3: movement + direct-question answering |
| 3 | 6 | "Thanks Tanya!", walk to west-side desk, sit, "Is this my spot?" | Same as Exp-3: landmark + sit pose + speech triple |
| 4 | 9 | Walk to NW coffee machine, pour coffee, "I need caffeine after that trip." | Same as Exp-3: long walk + object + quote |
| 5 | 12 | Walk toward Dana's desk, wave, "Dana, what should my first backend task be?" | Adapted (Exp-3 shook his hand; here 9 cells apart, so walk + ask) |
| 6 | 15 | Walk to desk with ANTON sign, sit, open laptop to set up | Same as Exp-3 + sign disambiguation (wrong-desk retest) |
| 7 | 18 | Thank both, walk toward west-side desks to set up laptop | Same as Exp-3, phrased as partial progress (no arrival claimed) |

## 3. What happened per tick (ground truth)

- **0 (user, FALLBACK):** greeting from entrance (no movement asked) →
  consequence invents a walk to Tanya's desk + "booting up his laptop" +
  6 invented quotes ("Well, Dana said we'd start with the brief…") +
  unknown `mark`. Correct fallback. Residual Exp-3 tick-0 poison is gone
  *as a requirement* (disagreement log: "dropped ungrounded quote…",
  "dropped unknown destinationActorId mark"), but the consequence still
  generates it — grounding now filters, it doesn't teach.
- **1 (Tanya, FALLBACK):** "Stand up and wave at Anton" → consequence never
  sets pose, moves Anton (observer), "Hi, I'm Tanya! What brings you here?"
  (stranger framing). All 4 attempts fail the Phase-3 stand gate. Correct
  fallback — but note the failure is now *total*: 4/4 attempts make the
  identical pose omission, retry feedback ("set pose") never lands.
- **2 (Dana, ok but HOLLOW):** "scan candidates, compose email" (in-place) →
  "Dana finishes screening, **stands up, walks to the kitchen for a coffee
  break**", `effects.moved=true`, **no position change**, passes attempt 1.
  Reverse verb-drop: the narrative *adds* stand+walk with zero patches and
  the validator accepts `moved=true` with no coordinates. Thoughts declare
  the deadline pressure over ("huge weight off my shoulders… unwind").
  This is the mirror hole of the Phase-3 verb gates: they check
  action→patch, never narrative→patch.
- **3 (user, FALLBACK):** desk question → "antton", "Consequence" as actor,
  Jeff, and final attempt "Anton shakes hands with Tanya" (handshake #1 of
  6) with no walk and no question. Correct fallback.
- **4 (Tanya, FALLBACK):** "walk over to Anton… lead him to his new desk" →
  "Tanya smiles and greets Anton", no movement ×4. The new action-side
  movement gate fires all 4 times ("action implies movement but acting…").
  Phase 3 working as designed; model never repairs. Stranger framing again
  ("Another new colleague").
- **5 (Dana, FALLBACK):** break/coffee question → "Anton asks Tanya, 'Do
  you like it here?', standing next to her desk" (observer-as-subject +
  Anton teleported inside `anton_desk` at (5,8)) + Jesse. Correctly
  rejected ×4. New gates firing (question-preservation, observer-move,
  inside-desk).
- **6 (user, FALLBACK):** thanks + desk + sit + quote → attempt 4 shows the
  Phase-3 fuzzy repair WORKING ("unknown object id: anton_table — did you
  mean anton_lamp, anton_chair, anton_desk?") but on attempt 4 of 4, so the
  suggestion dies with the fallback. Attempt-4 movement (3,5) was plausible
  progress, erased whole by the object nit + quote nit — the exact Phase-4
  salvage case, unsalvaged.
- **7 (Tanya, FALLBACK):** "Head to the lounge to grab leftover coffee" →
  "Anton shakes hands with Tanya" (handshake #2) + moves Anton inside desk.
  Movement + pick-up/hold + contact-distance gates all fire. Correct
  fallback. Note the deterministic resolver mapped "leftover coffee" to
  `destinationObjectId=coffee_machine` — wrong landmark (should be
  `lounge_mug`); keyword match without ownership/proximity ranking (§4.4).
- **8 (Dana, ok but IDENTITY-SWAPPED):** proposals are written as Anton
  ("walk over and introduce himself to Dana", why: "Anton wants to
  familiarize himself…"), selection "take a few deep breaths to calm his
  nerves, it's only his first day" (Anton's nerves, not Dana's deadline
  stress). Passes only because nothing moves and nothing is quoted.
  Thoughts: Anton "Guess he didn't know I was starting today" (false —
  he was announced), Tanya "Another newbie. I hope they're not taking
  **Tanya's** old spot" (third-person self-reference + stranger framing).
  No gate checks *whose* psychology this is.
- **9 (user, FALLBACK):** coffee run → attempt 2 **trips the Phase-2
  displacement cap** ("moves 13.0 cells in one turn… at most 6") — first
  confirmed cap trigger. Final attempt handshake #3 ("Nice to finally meet
  a developer here" — stranger framing). Correct fallback.
- **10 (Tanya, ok VIA REPAIR):** "Head to Anton's desk and help him set up
  his laptop" → repair (8,7)→(4,10), genuinely near `anton_desk`. Best
  applied movement of the run. But narrative "Tanya greets Anton as he
  approaches **her** desk" describes the opposite direction, the laptop
  help vanishes (no prop/object), thoughts "Another new hire". And the
  disagreement log shows `destination conflict: effects=tanya judge=anton
  (kept effects)` — the kept destination (herself) contradicts the repair
  target. Movement salvaged, content hollow.
- **11 (Dana, FALLBACK):** "click Send on email" → "Tanya greets Dana
  enthusiastically, 'Welcome to the office!'" (observer-as-subject, Dana's
  turn spoken by Tanya) + moves Anton inside desk. Correct ×4. Attempt-2
  error reveals the flip side of leniency: "action describes no movement
  ('He clicks Send'…)" — the action-side movement gate misfires on
  in-place actions when the consequence *does* move someone (message
  truncated, but the turn correctly falls back).
- **12 (user, FALLBACK):** walk-to-Dana + task question → handshake #4
  **with Tanya** (wrong addressee entirely), patches Tanya instead of Dana,
  attempt 2 walks into `tanya_desk` + Jeff. Correct fallback. Model
  landmark confusion: asked Dana's desk, walked to Tanya's.
- **13 (Tanya, FALLBACK):** "pick up mug, sip tea, type" (in-place) →
  5th greeting "Welcome! So nice to meet you", drops the mug. Pick-up/hold
  gate fires ×4 (correct), contact-distance gate fires on attempt 3
  ("implies physical contact with anton but ends at (4,10), 14.4 cells
  from anton"). Both new gates working. Greeting loop unbroken by the
  repetition guard.
- **14 (Dana, ok but HOLLOW):** the question queue visibly works at
  proposal level ("start explaining Anton's first task" selected *because*
  Anton asked) — then consequence "Dana looks up from his monitor, seeing
  Anton walk in" explains nothing. Passes because the deterministic
  semantics says `moves=false, speaks=false` for "Nod and start
  explaining…" — **unquoted speech is not detected as speech** (§4.5), so
  dropping the explanation is free. History records "start explaining…"
  as if it happened.
- **15 (user, FALLBACK):** desk + sit + open laptop → attempts 3–4 both
  trip the cap (10.8 and 13.0 cells). Attempt 4 narrative "walks to his
  desk and sits down" is exactly right in prose but the coordinates jump
  the whole 14-cell gap in one turn — correctly failed, but **not clamped
  to a 6-cell step either** (§4.2): the Phase-2 "clamp repair by the cap"
  task did not materialize; over-long walks fail whole instead of
  degrading to partial progress. Open-laptop verb gate also fires.
- **16 (Tanya, ok VIA REPAIR):** "Lean over to show Anton apps on his
  laptop" → consequence "finishes the small test plan… looks up", repair
  (4,10)→(9,7) back toward her own desk (away from Anton's). Laptop help
  erased again; Dana thoughts "I should probably introduce Anton to Tanya
  after lunch" (they have interacted for 16 ticks). Hollow pass #3 with
  movement attached.
- **17 (Dana, FALLBACK):** "Leave desk for coffee refill" → "Anton enters
  the office and approaches the coffee machine" (observer-as-subject #3,
  "enters" on tick 17!) + observer-move + Jeff + "Consequence" actor.
  Correct ×4.
- **18 (user, FALLBACK):** thanks + west-desks walk (deliberately no
  arrival claim) → attempt 1 "strides toward workstation" with **no
  position change** (failed by the good "movement but no position change"
  gate) + drops thanks ("renders no speech (no quote and no speech
  verb)" — the lenient speech-verb alternative working); attempt 2 sits
  at (10,8) by Tanya's desk ("rest before the meeting" — meeting
  hallucination + wrong desk); attempt 3 **walks to the coffee machine
  unprompted** ("pours a coffee mug"), embeds Anton in the north wall
  (4,0), patches a **jeff observer**, and overwrites the coffee machine's
  description to "coffee mug" + moves the machine to (?,1) — object
  corruption + teleport attempts, all correctly rejected; cap fires twice
  (8.5, 12.2 cells). Also note the resolver mapped "set up the laptop" to
  `destinationObjectId=tanya_laptop` — wrong desk's laptop (§4.4).
- **19 (Tanya, FALLBACK):** proposals written as Anton again ("Anton is
  eager to settle in…", "Tanya knows the best way for Anton…"), selection
  "Open the laptop and explore the backend codebase" (QA engineer doing
  backend onboarding) → consequence 6th greeting + "Anton walks toward
  Tanya" — and attempt 3 trips the **observer-as-subject gate**
  ("narrative casts roster observer 'anton' as the acting subject") —
  first confirmed trigger of the Phase-3 prose check. Correct fallback.
- **20 (Dana, FALLBACK):** "Grab coffee and head to Anton's desk to discuss
  first task" → "**Jeff** welcomes Anton by shaking his hand" (handshake
  #6) with a full patch set on non-existent **jeff** (emotion+thoughts).
  Movement + pick-up + Jeff gates all fire. Correct fallback. Best
  onboarding arc of the run (ticks 12→14→20 task thread) dies unanswered.

Totals: 16/21 fallbacks; 0/21 applied turns touch objects; sit/stand/pour/
open/pick-up requested 8×, applied 0×; "where is my desk?" asked 1×,
answered 0×; "first task?" asked 2×, explained 0× (proposal twice selected
an explanation, consequence dropped it twice).

## 4. Verdict: engine vs. small-model attribution

**Phase 1 (deterministic grounding) mostly works — and is now measurable.**
The `judge_vs_effects_disagreement` log fires 72 times and reads like a
catalogue of neutralized poison: "dropped ungrounded quote … (not in
action text)" on nearly every turn, "dropped unknown destinationActorId
jeff/mark/marias", "dropped moves=true (no displacement verb…)" for
sip/glance/click/type (ticks 2, 11, 13, 19). No fallback in this run was
*caused* by an invented-quote requirement — Exp-3 §6.1's mechanism is
fixed at the semantics level. Residual holes:

1. **Merged-OR still keeps the weak judge's `moves/speaks=true` over the
   effects' `false`** (e.g. ticks 3, 7, 15, 17: "moves conflict:
   effects=false judge=true (kept OR)"). The deterministic layer drops
   *ungrounded* claims, but a judge-hallucinated `moves=true` with any
   displacement token still becomes a requirement. The OR should prefer
   the deterministic parse, not the union.
2. **Destination conflicts resolve to `effects`** (tick 10:
   "destination conflict: effects=tanya judge=anton (kept effects)"),
   letting the consequence's wrong landmark override the grounded one.

**Phase 2 (movement) is half-working: the cap catches, nothing degrades.**


- Cap triggers confirmed (ticks 9, 15 ×2, 18 ×2; "at most 6 cells").
  Zero teleports vs 2 in Exp-3. Glance/sip/click locomotion gone at the
  semantics level.
- But **no capped walk is ever clamped to a partial step** — the "clamp
  repair by the same cap" task did not survive implementation: tick 15
  attempt 4 keeps the full 13-cell jump and fails whole; tick 18 attempt 1
  (no position change for a "walk toward" action) fails whole instead of
  stepping ≤6 cells toward the target. Anton's 5 walk requests produce 0
  cells of progress. The speed limit reads as a wall, not a pace.
- Named-landmark progress ("halve the distance") never visibly fires;
  all far walks die at the cap first.

**Phase 3 (verb gates) fires constantly — 69 `validation_failed` with the
right taxonomy** (movement 42, quote-drop 26, pick-up/hold 16, question 14,
inside-desk 13+, observer-move 13+, observer-subject 10, pour/open 9,
addressee 10+, contact-distance 7, stand/sit 5, sip/type/prop 3, fuzzy-id
repair 1). Confirmed first-triggers: observer-as-subject prose check
(tick 19), contact-distance (tick 13), fuzzy object suggestion
(`anton_table` → `anton_lamp|anton_chair|anton_desk`, tick 6).
Gaps found (all engine-side, all with repro ticks):

3. **Reverse verb-drop: narrative adds movement/pose with no patches and
   passes** (tick 2: "stands up… walks to the kitchen", `moved=true`, no
   coords, PASSED; tick 16-repair moves Tanya while the narrative says she
   "looks up from her desk"). Gates check action→patch only. Require:
   `effects.moved` ⇒ position patch present and within cap;
   narrative locomotion/pose verbs (walk/stand/sit) ⇒ matching patch.
4. **Deterministic destination resolution picks wrong landmarks**
   (tick 4: `tanya_desk` for "his new desk"; tick 7: `coffee_machine`
   for "leftover coffee"; tick 15: `anton_sign` for "walk to the desk";
   tick 18: `tanya_laptop` for "set up the laptop"). Keyword-first-match
   with no ownership ("his"→actor's), proximity, or container ranking
   (walk-target should prefer furniture over props/signs; "coffee" as
   object should prefer `lounge_mug` when the action says "grab").
5. **Quote parser truncates at apostrophes**: tick 5 grounded
   `quotedSpeech=["Why don"]` for "Why don't we take a 10-minute break…".
   A corrupted quote becomes ground truth the speech gate must demand.
6. **Unquoted speech is invisible to both judges**: "Nod and start
   explaining Anton's first task" → `speaks=false` (tick 14, agreement!),
   so the hollow look-up passes; same class lets tick 2's "composing an
   email" pass any prose. Speech verbs (explain/tell/describe/ask/nod…)
   without quote marks need `speaks=true` (with lenient rendering, strict
   content preservation).
7. **History records attempts as facts.** Every fallback appends the raw
   action text ("Anton: …sit on the chair…", "Tanya: …help him set up his
   laptop…", "Dana: …start explaining…") indistinguishably from applied
   turns — so proposals later assume Anton sits at his desk (tick 8),
   the laptop is being set up (tick 16), the task was explained (tick 20
   "discuss his first task in more detail"). 16 of 21 history lines assert
   things that never happened. Mark fallback entries (or log them
   separately) so proposal/selection ground on the world, not the wish.

**Phase 4 (partial-apply) never fired — 0 salvaged turns in 21.**
Entry criteria (valid movement + nit-failure) arguably occurred twice
(tick 6 attempt 4: plausible (3,5) step + object/quote nits; tick 15
attempt 4: correct prose + over-cap coords that *could* clamp), but both
died whole. Either the salvage path's entry conditions are narrower than
the failures the model actually produces (4-axis garbage every attempt —
nothing clean to keep), or it only runs in a slot this model never
reaches. Either way the flagship longevity fix contributed nothing
measurable this run, and fallback *rose* 57% → 76%.

**Phase 5 (memory/budget): no compounding visible.** Stranger/candidate
frames persist at the same rate as Exp-3 (ticks 1, 4, 8, 9, 10, 12, 16,
19: "What brings you here?", "Another new colleague/new hire/newbie",
   "Nice to finally meet a developer here", "engineer-or-manager" class
   thoughts). Memories are byte-identical to scenario init (2/3/1) after
   21 turns; no summarization event fired; per-actor refresh lines do not
   bind the 8B (same conclusion as Exp-3 item 13, now with data: the line
   exists, the frames persist). Dana's closing thought ("introduce Anton
   to Tanya after lunch") proves no interaction memory accumulated.
   Identity leakage is new/worse: two full proposal sets written from the
   wrong actor's POV (tick 8 Dana-as-Anton, tick 19 Tanya-as-Anton) plus a
   third-person self-reference ("Tanya's old spot", tick 8).

**Model-side (small-model noise, not engine regressions):** handshake
attractor ×6 (ticks 3, 6, 7, 9, 12 + Jeff-handshake tick 20 — vs 0
handshakes requested); greeting loop ×6 (5 of them post-introduction);
Jeff in 202/718 events with a full jeff patch set once (tick 20);
"Consequence" as actor ×4; invented roster (Mark, Maria, Jesse, Sarah,
Karen, dan, antton); object corruption attempt (coffee_machine desc→
"coffee mug", machine moved to (?,1), tick 18); "enters the office" on
tick 17; meeting hallucinations; pronoun use actually clean this run
(no she/her for Dana). Error-message quality deserves credit: capped,
inside-desk, and fuzzy-id feedback lines are specific and actionable —
the retries just never converge (same omission 4/4 attempts is the modal
pattern, e.g. ticks 1, 4, 13, 19).

## 5. Exp-3 → Exp-4 comparison (same protocol, same model)

| metric | Exp-3 (pre-fix) | Exp-4 (Phases 1–5) |
|---|---|---|
| fallback rate | 12/21 (57%) | **16/21 (76%)** |
| teleports >cap | 2 (9, 13 cells) | **0** |
| wrong-desk arrivals passing | 1 (tick 15) | **0** |
| object touches applied | 0/21 | 0/21 |
| pose/prop changes applied | 3 pose / 0 prop | **0 / 0** |
| desk question answered | 0/2 | 0/1 |
| first-task explained | 0/2 | 0/2 (selected 2×, dropped 2×) |
| Anton displacement (21 turns) | ~15 cells | **0 cells** |
| judge-poisoned fallbacks | yes (0/3/6/9) | **none** |
| salvaged/partial turns | n/a | **0** |
| stranger-frames | 7+ | 8+ |
| Jeff events | ~38 invents | 202 log mentions, 6 unknown-id rejects |

Physics got *tighter* (no teleports, no wrong-desk passes, poison
neutralized) and *deader* (nothing moves, nothing is touched, fallback
up). The gates now reject everything the 8B produces, the salvage path
that was supposed to convert rejections into degraded progress never
engages, and the passes that slip through are the hollow ones (ticks 2,
8, 14, 16) — the exact turns where narrative contradicts action without
tripping a gate. Tighter validation without working degradation is a
freezer, not a backstop.

## 6. Action items (ordered, each with repro tick)

Engine (correctness):

1. **Clamp over-cap walks to a partial step instead of failing whole**
   (ticks 15, 18). Deterministic repair should project the claimed
   destination onto the ≤6-cell reachable set and continue next turn —
   the missing half of the Phase-2 task. Without this, any spawn layout
   with >6-cell gaps (this one: entrance→desk ≈ 14) can never be walked
   by anyone, and fallback stays structural, not model-caused.
2. **Close the reverse verb-drop: narrative locomotion/pose ⇒ patch**
   (ticks 2, 16). `effects.moved=true` with no position patch must fail;
   "stand/walk/sit" in narrative with no pose/move patch must fail.
   Mirror of the Phase-3 action-side gates.
3. **Detect unquoted speech** (tick 14). Explaining/telling/asking/nodding
   verbs ⇒ `speaks=true` even with no quote marks; keep rendering
   lenient, content strict. Else every explanation is droppable.
4. **Fix quote parsing at apostrophes** (tick 5: "Why don"). Ground truth
   must not be corrupted before the gate demands it.
5. **Rank destination resolution** (ticks 4, 7, 15, 18): ownership
   ("his"→actor's objects), proximity, furniture-over-prop for walk
   targets, object-over-fixture for grab targets. First-keyword-match is
   the new Jeff (wrong, but deterministic).
6. **Mark fallback history as un-applied** (ticks 8, 16, 20): record the
   attempt separately from the world (e.g. "Anton tried… (not done)"), or
   proposals will keep grounding on fiction. This is Phase-5-adjacent and
   probably cheaper than summarization.
7. **Narrow merged-OR**: deterministic parse wins over LLM judge on
   moves/speaks conflicts (ticks 3, 7, 15, 17); grounded destination wins
   over effects (tick 10). The disagreement log already computes both —
   act on it.
8. **Find out why salvage never fires** (whole run): log salvage *entry*
   evaluations (eligible/ineligible + reason) per failed turn. If the
   criteria need valid-movement-plus-nit and the model never produces
   exactly that, widen to clampable-movement (item 1) or speech-nit-only.

Prompting/context (small-model load-bearing):

9. **Identity anchor still doesn't stick** (ticks 8, 19: full POV swaps;
   tick 8 third-person self-reference). Per-actor refresh lines (Phase 5)
   had no measurable effect — consider structural: proposal prompt leads
   with "You are <DECIDING actor>, not <others>" restated per call, or
   reject-and-retry proposals whose why-line names the wrong actor's
   goals ("Anton wants…" on Dana's turn is machine-detectable).
10. **Handshake/greeting attractors** (6+6): repetition guard lists prior
    actions but the model re-emits them anyway. Proposal-level dedup
    (reject options whose verb+noun core matches a prior turn's) would
    beat another prompt line.

Long-run outlook: the Exp-3 §6 conditional stands, with one amendment —
Phase 4 is now the critical path, not a nice-to-have. Grounding (1),
movement caps (2), and verb gates (3) demonstrably work; without
degradation (clamp + salvage + honest history) they freeze the scene
faster than the old loopholes broke it. Re-run the soak (Phase 6) only
after items 1–3 above: success = Anton reaches his desk in 3–4 turns of
capped steps with the question thread intact.
