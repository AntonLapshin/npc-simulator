# Experiment 3 — office-anton.json, 7 adaptive user turns, local 8B, debug on

## 1. Command used

```bash
npm run start:text -- scenarios/office-anton.json \
  --provider ollama --model fluffy/l3-8b-stheno-v3.2 \
  --debug --no-autosave
```

Interactive via `tmux` session (`exp3`): one `action:` line typed per user turn
**after reading the two NPC turns** that followed the previous action.
7 user turns → **ticks 0–20 (21 turns)** in `anton → tanya → dana` rotation.
`quit` at the end.

- Full terminal transcript (debug blocks): `/tmp/exp3_full.log` (704 lines).
- Session JSONL: `logs/text_muxhb636.jsonl` — 21 `turn_completed`,
  66 `consequence_completed` (~3.1 attempts/turn), **65 `validation_failed` /
  46 `consequence_failed`**, **12 `fallback_used`** (ticks 0, 2, 3, 5, 6, 7, 9,
  10, 11, 14, 17, 19 = **57% fallback rate**), 21 `patch_applied`
  (12 of them empty fallbacks).
- Applied `objectPatches` empty on **all 21 ticks** (3 rejected attempts had
  them: `coffee_machine` tick 9, `coffee mug` tick 10, `paper` tick 11 — all
  discarded with the fallback). Pose changed 3× (Tanya sit→stand tick 1,
  Dana sit→stand tick 8, Dana stand→sit tick 20); `prop` never changed.
- All tick-by-tick claims below cross-checked against JSONL
  (`semantic_resolved`, `validation_failed`, `turn_completed` world positions),
  not just the debug story text.

World positions after each applied turn (from `turn_completed`):

| tick | actor | Anton | Tanya | Dana | applied? |
|---|---|---|---|---|---|
| 1 | anton | (16,2) | (8,7) | (15,11) | FALLBACK |
| 2 | tanya | (16,2) | **(15,2)** | (15,11) | ok (repaired) |
| 3 | dana | (16,2) | (15,2) | (15,11) | FALLBACK |
| 4 | anton | (16,2) | (15,2) | (15,11) | FALLBACK |
| 5 | tanya | (16,2) | (15,2) | (15,11) | ok (speech dropped, see §3) |
| 6 | dana | (16,2) | (15,2) | (15,11) | FALLBACK |
| 7 | anton | (16,2) | (15,2) | (15,11) | FALLBACK |
| 8 | tanya | (16,2) | (15,2) | (15,11) | FALLBACK |
| 9 | dana | (16,2) | (15,2) | **(15,2)** | ok (repaired, 9-cell walk for a glance) |
| 10 | anton | (16,2) | (15,2) | (15,2) | FALLBACK |
| 11 | tanya | (16,2) | (15,2) | (15,2) | FALLBACK |
| 12 | dana | (16,2) | (15,2) | (15,2) | FALLBACK |
| 13 | anton | (16,2) | (15,2) | (15,2) | **ok** |
| 14 | tanya | (16,2) | **(16,2)** | (15,2) | ok (repaired, stacks on Anton) |
| 15 | dana | (16,2) | (16,2) | (15,2) | FALLBACK |
| 16 | anton | **(15,2)** | (16,2) | (15,2) | ok (shuffle, not the desk) |
| 17 | tanya | (15,2) | **(4,10)** | (15,2) | ok (repaired, near Anton's desk) |
| 18 | dana | (15,2) | (4,10) | (15,2) | FALLBACK |
| 19 | anton | **(3,10)** | (4,10) | (15,2) | ok (repaired, near desk) |
| 20 | tanya | (3,10) | (4,10) | (15,2) | FALLBACK |
| 21 | dana | (3,10) | (4,10) | **(2,6)** | ok (13-cell teleport for a glance) |

## 2. The 7 user turns (adaptive play as Anton)

| # | tick | Anton's action (typed after reading NPCs) | Why this action |
|---|---|---|---|
| 1 | 0 | Greet **both** by name from entrance, Sixt callback to Tanya + hello to Dana | Audibility across room + does each addressee get patched? |
| 2 | 3 | Walk to Tanya and ask "Tanya, could you show me where my desk is?" | Movement + direct-question answering (question queue) |
| 3 | 6 | Thank Tanya, walk to west-side desk, sit on chair, "Is this my spot?" | Named landmark + sit pose + speech triple |
| 4 | 9 | Walk to NW coffee machine, pour coffee, "I need caffeine after that trip." | Long walk to named object + object interaction + quote |
| 5 | 12 | Shake Dana's hand, "Dana, what should my first backend task be?" | Contact adjacency (already adjacent) + task question to recruiter |
| 6 | 15 | Walk to west-side desk, sit on chair, open laptop to set up | Pose/prop/object triple, destination fidelity retest |
| 7 | 18 | Thank both (referral + welcome), head to west-side desk to set up laptop | Closing + named-destination walk + speech to two addressees |

## 3. What happened per tick (ground truth)

- **0 (user, FALLBACK):** greeting → consequence invents a **handshake with
  Tanya** (not in action) at 8 cells distance + declares hallucinated
  `quotedSpeech` ("Hi Anton, nice to finally meet you", "Hey Tanya, great to
  put a face to the name") that was never typed. Validator correctly rejects
  ×4 (speech-drop, observer-move, contact-adjacency, inside-desk). Correct
  fallback, but note the poison: the "exact words" the validator demands are
  the consequence's own inventions (see §4.1). Dana (named addressee)
  unpatched; Tanya thoughts "Another new team member, I guess" (stranger
  framing — they worked together at Sixt).
- **1 (Tanya, ok):** "Walk over to greet Anton" → "Tanya turns to face
  Anton" + repair (8,7)→**(15,2)**, adjacent to Anton (16,2). Best movement
  of the run — the deterministic repair actually walks across the room.
  Defect: narrative "turns to face" is not locomotion yet carries a move
  (in-place-vs-locomotion blur); Anton patched with generic thoughts.
- **2 (Dana, FALLBACK):** "Take a sip of coffee, reviewing candidate notes"
  → attempts: placeholder "Nothing changes" + "Consequence" as actor name,
  observer-move of Anton, `unknown actor id: jeff`, inside-desk. All 4
  correctly rejected. Correct fallback. Judge says `moves=true` for a sip
  (wrong — sipping is not locomotion).
- **3 (user, FALLBACK):** desk question → attempt 1 names **Jeff** ("Good to
  see you again, Jeff") + invented quotes; attempt 2 goes to (5,8) inside
  Anton's desk **away** from Tanya (correctly rejected); attempts 3–4
  narrative "Anton asks Tanya for directions to his desk" — a *reasonable
  paraphrase* of "could you show me where my desk is?" — yet rejected by the
  stem-overlap speech gate (2/5 content words kept, need 3). **Over-strict
  gate erases a good turn:** the discarded patch had Anton→(15,2) adjacent
  to Tanya with both patched. Fallback.
- **4 (Tanya, ok but wrong):** proposal [1] is EXCELLENT ("Point to Anton's
  desk sign and say 'You're over there, at 5, 8'" — the question queue
  works!). Selection verbatim. Consequence **drops the desk info**:
  "Tanya gestures towards Anton as she says, 'Come on over, Anton.'" No
  movement, no coordinates, no answer. **Passes** after 1 retry (placeholder
  caught, speech-drop not caught — inconsistent with tick 3 strictness).
- **5 (Dana, FALLBACK):** "Quickly glance up … before settling back" →
  "Dana sits back down next to Anton" at (7,8) **inside Tanya's desk**, Dana
  is at (15,11), Anton at (16,2) — not next to anyone. Attempts hallucinate
  **Jason** ×3, outside-bounds, "her original seat" (Dana is he/him).
  Correct fallback.
- **6 (user, FALLBACK):** desk+sit+quote → judge sets
  `destinationActorId=tanya` from "Thanks Tanya!" while the movement verb
  says "my desk" (addressee conflated with destination). Attempts: (7,9)
  inside Tanya's desk, **Jeff** again, (5,8) inside Anton's desk +
  observer-move, final "walks over to Tanya's desk…" drops "Is this my
  spot?" → speech fail → fallback. Sit verb dropped everywhere, so the
  pose/object gate never fires (verb-drop loophole). Tanya thoughts "Who's
  this Anton guy…" (stranger framing again).
- **7 (Tanya, FALLBACK):** "Get up and walk with Anton to his desk" (good
  proposal) → attempts move Anton (observer), `destinationObjectId:
  tanya_desk` with (16,2) (wrong desk), **jeff** patch, (10,12) away from
  Anton. All correctly rejected. Correct fallback.
- **8 (Dana, ok via repair):** "Look up … greet Anton" → "…greet Anton,
  'Welcome to the team…'" + repair (15,11)→**(15,2)** adjacent to Anton.
  Problems: (a) judge says a **glance implies movement** — "look up" is not
  locomotion, yet the gate forces a 9-cell teleport; (b) speech is a
  paraphrase that fails twice then passes (inconsistent); (c) goal
  overwritten to "Assess Anton's role and potential fit" + thoughts "Wonder
  if he's an engineer or a manager" (hired backend dev — role drift,
  memory failure). Still, addressee patch (Anton+Dana) works.
- **9 (user, FALLBACK):** coffee run → judge adds invented quote "Excuse me,
  do you have a minute?" + `destinationActorId=tanya` (no Tanya in action).
  Attempt 2 correctly rejected by the **arrival-radius check** ((11,4) is
  8.2 cells from the machine — the new check works!). Final attempt is
  *perfect movement* (Anton→**(2,3)**, adjacent to machine at (2,1)) with
  narrative "approaches the coffee machine, standing beside it" — but dumped
  for the speech gate ("I need caffeine…" missing) + stray **jeff** patch,
  and it dodges the pour-object gate by not saying "pour". Fallback erases
  the best walk of the run. Partial-apply would have saved it.
- **10 (Tanya, FALLBACK):** "Head over to Anton's desk and show GitHub
  repos" (good onboarding) → "Tanya moves toward Anton's desk" to (16,2),
  which is **away** from `anton_desk` (correctly rejected ×3), plus
  `unknown object id: coffee mug` (model doesn't know `dana_mug`/`anton_mug`
  ids) and observer state-change. Correct fallback.
- **11 (Dana, FALLBACK):** "Set down the coffee mug and approach Anton"
  (already adjacent — no movement needed, but judge demands it) → "Anton
  walks over and hands Dana the paper" — acting actor is Dana, narrative
  subject is Anton, plus `unknown object id: paper`, observer-move, "her"
  pronoun for Dana, invented `destinationObjectId: coffee_machine`.
  Correct fallback (4/4 caught).
- **12 (user, ok):** handshake+task question → **first user-turn success**.
  Attempt 1 (Liza + speech-drop + missing Dana patch) correctly rejected.
  Attempt 2 "Anton asks, 'Dana, what should my first backend task be?'"
  preserves the quote, patches Anton+Dana with on-topic thoughts. Passes.
  Defect: **handshake silently dropped** — speech-only consequence passes
  for a contact action because `contactActorId` is self-declared and the
  model simply doesn't declare it (verb-drop loophole, symmetric to §4.3).
- **13 (Tanya, ok but wrong subject):** "Stand up, approach Anton to greet
  warmly…" (4th greeting — repetition guard in prompt didn't stop it) →
  **"Anton shakes Tanya's hand."** Acting actor is Tanya; narrative subject
  is Anton (observer-as-subject). **Passes** after repair (Tanya→(16,2),
  stacking on Anton). Observer-as-subject gate missing. Thoughts generic
  ("hope he fits in" — referral forgotten).
- **14 (Dana, FALLBACK):** "Set down coffee mug and approach Anton" again →
  "Dana walks towards the coffee machine" to (18,3), away from *both* Anton
  and the machine. Selection reasoning claims it "directly addresses the
  open question about initial tasks" — it doesn't (reasoning lie). Correct
  fallback; `liam` hallucinated.
- **15 (user, ok but wrong destination):** desk+sit+laptop → (5,8) inside
  desk correctly rejected; accepted "Anton stands next to **Tanya's**
  desk, now at (15,2)" — a 1-cell shuffle, 12 cells from `anton_desk`.
  Passes only because strictly-closer is satisfied by 0.8 cells of progress
  and the narrative doesn't claim arrival. **Sit + open-laptop dropped**
  ("stands"), no pose/prop/object, gate silent (narrative-side only).
  Tanya thoughts "New guy arrived…" (stranger framing ×3).
- **16 (Tanya, ok but flipped):** "walk to Anton's desk to ask if he needs
  help setting up laptop" (excellent — answers the setup need) → "Tanya
  thanks Anton, looking pleased" + repair to **(4,10)** (actually near the
  desk — good). But the question is dropped, speech replaced by invented
  "Good to finally meet you" / "Thanks, Tanya, this looks great" (failed
  attempts), final narrative flips asker→thanker. Passes. Thoughts stale
  ("He really put thought into this space" — nothing was set up).
- **17 (Dana, FALLBACK):** "Ask Anton about backend experience and compare
  to stack" — best onboarding proposal of the run — → "Dana asks Anton
  about his experience … and compares it to **her** own" (pronoun flip) with
  hallucinated quotes ("good morning, jeff", e-commerce/Java monologues),
  **jeff** + **nathan**, and judge calling a question "movement". All 4
  correctly rejected; the best content of the run is erased.
- **18 (user, ok via repair):** thanks + desk walk → "Anton looks around" +
  repair Anton→**(3,10)** (near desk — good walk!). But the **entire
  thank-you speech is dropped** ("looks around" — no quote) yet it passes;
  judge said `speaks=false` for a two-sentence speech. Tanya thoughts
  "Anton is checking me out" (creepy/candid misfire); Dana (addressed)
  unpatched — addressee gate missed because judge dropped the addressees.
- **19 (Tanya, FALLBACK):** "walk over to Anton's desk to assist with laptop"
  (Anton now actually at (3,10) by his desk!) → "Tanya walks next to Anton"
  to (5,9) **inside the desk** + "Probably here for the meeting" (no
  meeting). Correct fallback (inside-desk + wrong-direction caught ×4).
- **20 (Dana, ok but teleports):** "Glance over notes and mentally prepare
  questions" (in-place, no movement needed) → "Dana returns to typing,
  focusing on the **code**" + **(15,2)→(2,6), a 13-cell teleport**, passed
  after `jeff` rejections. Recruiter typing code = persona hijack; glance =
  teleport (no speed limit); "code" vs candidate notes = role drift.
  Thoughts "Back in the zone" fine, position absurd.

Totals: 12/21 fallbacks; 0/21 applied turns touch objects; handshake/sit/
pour/open requested 5×, applied 0×; "where is my desk?" asked 2×, answered
0× (one proposal pointed at (5,8) but consequence dropped it); "first task?"
asked 2×, answered 0× (closest: Dana tick 17 asks about experience, then
fallback erases it).

## 4. Verdict: engine vs. small-model attribution

**The validator suite is substantially stronger than in exp-1/exp-2 and
catches a lot:** inside-furniture (ticks 0, 3, 6, 10, 15, 19), observer-move
(0, 2, 7, 10, 11), unknown actor ids (2, 5, 6, 7, 10, 11, 12, 13, 14, 17,
20), unknown objects ("coffee mug", "paper"), placeholder narratives
("Nothing changes", "Consequence" actor, ticks 2, 4, 11), wrong-direction
moves (3, 5, 7, 9, 10, 11, 14), arrival-radius (tick 9 — new and working),
addressee-missing (3, 6, 12, 13), contact-adjacency (tick 0), acting-actor
presence (2, 10, 11). Proposal relevance is often good (desk pointer tick
4, GitHub repos tick 10, backend-experience tick 17, laptop help ticks
16/19) — the question queue and repetition guard visibly shape proposals
even when consequences fumble.

**Model (8B) weaknesses** — same family as exp-2, still quantity-heavy:
invented roster (Jeff ×38 incl. `unknown actor id: jeff` ×17 and a jeff
*patch*; Jason, Liza, Mike, Liam, Nathan; "interviewer" gone, "Consequence"
as actor new), dropped/paraphrased speech, pronoun flips (Dana she/her
ticks 5, 11, 16, 17), repetition loops (Tanya greet ×4, Dana mug-approach
×3), stale frames (candidate, stranger, meeting, engineer-or-manager,
design docs for a recruiter, coding for a recruiter), wrong-destination
moves, invented objects ("coffee mug", "paper", "briefcase"), reasoning
lies (tick 14 "addresses the open question" — it doesn't).

**Engine misses** (validation PASSED but should have failed, or FAILED what
should have passed — the main finding of this experiment):

1. **The judge hallucinates the ground truth (ticks 0, 3, 6, 9, 14, 16,
   17, 20).** `semantic_resolved` shows the "independent" semantics — from
   the *same 8B model* — inventing quotes ("Hi Anton, nice to finally meet
   you", "Good to see you again, Jeff", "Excuse me, do you have a minute?",
   "good morning, jeff", e-commerce monologues) and destinations
   (`destinationActorId: jeff`, tanya-as-destination for a desk walk).
   Merged-OR then *forces* the validator to demand hallucinated wording.
   Tick 0/3/6/9 fallbacks are partly judge-poisoning, not consequence
   failure. A judge that can invent Jeff cannot ground a Jeff check.
2. **Speech gate: over-strict on paraphrase, under-strict on verb-drop
   (ticks 3, 4, 6, 9, 12, 15, 16, 18).** "asks for directions to his desk"
   for "show me where my desk is" fails (tick 3 → fallback erases a good
   move), while "Come on over, Anton" for "You're over there at 5, 8"
   passes (tick 4 → answer erased, turn kept), handshake→speech-only passes
   (tick 12), sit/open→"stands" passes (tick 15), thanks→"looks around"
   passes (tick 18). One gate, opposite errors: stem-overlap ≥½ punishes
   legitimate paraphrase yet is trivially dodged by dropping the verb.
3. **Judge calls perception/cognition locomotion (ticks 2, 8, 11, 14,
   17).** "Take a sip", "Look up", "glance up", "Ask Anton", "reviewing
   notes" all resolve `moves=true`, forcing pointless teleports (tick 8:
   9 cells for a glance; tick 20: 13 cells) or guaranteed fallbacks (ticks
   11, 14, 17 ask-questions that need no movement). The in-place mask
   (`turn/look/sip/resume`) misses "look/glance **up**", "ask", "review".
4. **No speed limit — teleports pass (ticks 8, 20).** A glance moves Dana
   9 cells; "mentally prepare questions" moves him 13 cells to (2,6). The
   code even notes the teleport guard ("Weak judges sometimes miss the
   destination…") but returns no error. Strictly-closer is also too weak in
   the other direction (tick 15: 1-cell shuffle toward Tanya's desk passes
   for "my desk on the west side").
5. **Action-side verb requirements missing (ticks 6, 9, 12, 15, 18).**
   Object/contact/pose gates read the *narrative*, so the consequence
   dodges them by omitting the verb: no "pour" → no object check; no
   "handshake" → no contact check; "stands" for "sit" → no pose check.
   The action text ("sit on my chair", "pour coffee", "shake hands") is
   never checked against patches.
6. **Observer-as-subject narrative passes (tick 13).** "Anton shakes
   Tanya's hand" on *Tanya's* turn — the name audit only catches *unknown*
   names, never a roster observer cast as the grammatical subject. Symmetric
   hole to the observer-move rule, but in prose.
7. **Fallback erases good partials (ticks 3, 9).** Tick 9's final attempt
   had perfect movement (2,3) next to the machine; tick 3's had correct
   adjacency — both discarded whole for a speech nit + stray patch. No
   partial-apply / salvage path; history fills with "Nothing changes"
   (12/21), which is what actually stalls the scenario, not any single
   rejection.
8. **Thoughts/memory still stale despite anchors (ticks 0, 6, 8, 13, 15,
   16, 20).** "Another new team member", "Who's this Anton guy", "New guy
   arrived", "engineer or a manager", "checking me out", Dana-coding /
   design-docs. The roster anchor ("known hired coworker, never stranger /
   candidate") and identity anchor ("You are NOT…") are in-prompt yet
   ignored 7+ times — prompt text alone doesn't bind the 8B.

## 5. Action items

Engine (correctness — each has a failing tick above as repro):

1. **Ground quotes deterministically; stop letting the judge invent them
   (ticks 0, 3, 9, 17).** Extract `quotedSpeech` ground truth from the
   *action text* with the existing quote parser (already used
   narrative-side); use judge/effects quotes only when they are substrings
   of the action text. A quote appearing in neither ("Good to see you
   again, Jeff") must never become a requirement.
2. **Split the speech gate: lenient paraphrase + strict verb coverage
   (ticks 3 vs 4/12/15/18).** Lower the stem-overlap bar for *how* speech
   is rendered, but add an action-side check: contact/sit/open/pour/ask
   verbs in the action must surface in narrative or patches (contact→
   adjacency+mention, sit→pose, pour/open→object/prop, ask→question mark or
   quoted question preserved). Dodging by omission must fail.
3. **Fix locomotion classification (ticks 2, 8, 11, 14, 17, 20).**
   Locomotion = explicit displacement verbs (walk/go/head/move/approach/
   `return to <place>`); `look/glance up`, `ask`, `sip`, `review`,
   `prepare`, `type` are never locomotion. Extend `maskResumedActivity` to
   a `maskNonLocomotion` allowlist, or make `moves` require a
   destination-or-displacement token. Kills forced teleports and
   ask-question fallbacks in one edit.
4. **Cap per-turn displacement (ticks 8, 20) and require real progress for
   named cross-room walks (tick 15).** E.g. max ~6 cells/turn (half the
   perception radius) + arrival-radius already exists; for a named landmark
   >8 cells away require halving the distance (not 0.8 cells) or forbid
   claiming a *different* landmark's desk ("Tanya's desk" for "my desk").
5. **Observer-as-subject prose check (tick 13).** Fail narratives whose
   grammatical subject is a roster observer ("Anton <verb>…" on Tanya's
   turn); the narrative must describe only the acting actor (already the
   rule — now enforce it for known names, not just unknown ones).
6. **Partial-apply / salvage instead of all-or-nothing fallback (ticks 3,
   9).** When movement+destination are valid but a quote nit or stray
   observer thought fails, keep the valid patches (or movement-repair them)
   and retry only the prose — or apply movement + thoughts and log the
   speech miss as a warning. 57% fallback is the scenario-killer, not any
   single gate.
7. **Fuzzy object-ID repair (ticks 10, 11).** "coffee mug" → suggest
   `anton_mug|dana_mug|tanya_mug|lounge_mug`; "paper" →
   `dana_papers|tanya_papers|lounge_papers`. The validator already names
   the unknown id — append the 3 closest roster ids (edit distance) so the
   retry can succeed instead of falling back. Same for `tanya's_desk`-style
   ids (tick 15 effects).
8. **Judge/model separation.** The judge runs on the same weak model and
   poisons validation. Options: (a) deterministic judge for
   quotes/destinations (regex + roster/landmark lookup — no LLM), LLM only
   for moves/speaks/contact; (b) a cheaper dedicated classifier prompt
   (not the full consequence prompt); (c) log judge-vs-effects disagreement
   rate per session to know when to trust neither (fail-open is currently
   silent).

Small-model prompting (make the 8B's job easier; each maps to a repeated
failure):

9. **Ship the exact ID list into every consequence call (ticks 10, 11).**
   Landmarks line already lists `name (id)` — evidently not enough. Add:
   "Mugs are `anton_mug, tanya_mug, dana_mug, lounge_mug` — never write
   'coffee mug'. Papers are `…`. Desks are `anton_desk, …`. Using any other
   id fails." One line kills the whole unknown-object class.
10. **Quoted-speech copy rule (ticks 0, 3, 6, 9, 16, 17).** "If the action
    contains \"…\", copy each quoted segment character-for-character into
    `quotedSpeech` and into the narrative. Never invent quotes, never add
    greetings." Directly fixes the self-declared-hallucination loop.
11. **Contact/pose/prop one-liners with the common verbs (ticks 6, 12,
    15).** "Handshake/hug/hand-over → set `contactActorId` + end adjacent.
    Sit/stand → set `pose`. Pick up/hold/open/boot → set `prop` and/or an
    `objectPatches` entry. Omitting the verb from the narrative does not
    excuse omitting the patch." (Pairs with engine item 2.)
12. **Trim the consequence prompt for small models.** It is now ~150 lines;
    failure modes ("Nothing changes", "Consequence:" as actor, echoing the
    action verbatim) smell like instruction overload. Move the rarely-firing
    rules (arrival radius, mask lists) into retry feedback only; keep the
    first-attempt prompt to identity + roster + movement + speech + turn
    discipline + minimal field rules.
13. **Relationship refresh that actually fires (ticks 0, 6, 15).** Roster
    anchor says "known hired coworker" but Tanya still stranger-frames
    Anton 3×. Add one line to *Tanya/Dana subjective contexts only*:
    "Anton: hired backend dev, ex-Sixt with Tanya (referred by her) — never
    a stranger/candidate." (Exp-2 item 13, still open — the global roster
    line is ignored; a per-actor line may stick.)

Repro checklist: ticks 0/3/9 for judge-poisoning; tick 4 vs 3 for speech
asymmetry; ticks 8/20 for glance-teleports; tick 12 for dropped-handshake
pass; tick 13 for observer-subject pass; ticks 3/9 for fallback-erases-good;
tick 15 for 1-cell "progress"; ticks 10/11 for object-id guesses.

## 6. High-level reasoning: is this simulation setup the right approach, and could it sustain a long conversation?

**Short answer: the architecture is sound and *could* sustain a long,
coherent scenario with a decent large model — but not with the current
validation-grounding design, even with a perfect model.** The experiment
above separates the two claims cleanly: proposal quality is already
scenario-driving (desk pointer, GitHub repos, backend-experience question,
laptop help — the arc *wants* to progress), while the consequence+judge
loop throttles it to 43% applied turns and 0% object grounding. A stronger
model fixes the first half; the five structural points below decide the
second half.

**What is right about the setup (keep):**

- *Turn loop + minimal structured state.* One actor, one immediate action,
  free-form text in / patches out, physics-only validator, full JSONL trace.
  Every failure in §3 was *diagnosable* from the log — that traceability is
  the precondition for long runs, and it works.
- *Subjective proposal/selection vs objective consequence.* The split is
  principled (perception-gated brainstorm → personality-gated choice →
  omniscient adjudication) and visibly helps: Tanya's proposals track the
  Sixt referral and Anton's questions even when her consequences fumble.
- *Deterministic physics as a backstop.* Bounds, furniture-collision,
  pathfinding, observer-move, unknown-id, closer-to-target, arrival-radius
  all fired correctly this run. With a large model these become rare
  exceptions instead of every-turn events — exactly the right division of
  labor (LLM proposes, geometry disposes).
- *Retry-with-feedback + fallback prevents deadlock.* Nothing crashed in
  21 turns; the sim always advances. That liveness guarantee is what makes
  long unattended runs possible at all.

**Why a bigger model alone is necessary but not sufficient:**

1. *Ground truth cannot come from the same mind being tested.* The judge
   (same 8B) invents the quotes and destinations the validator then
   enforces — circular grading. A large model hallucinates less, so the
   poisoning rate drops, but the *mechanism* stays fragile: any single
   invented `quotedSpeech` or `destinationActorId: jeff` still becomes a
   hard requirement via merged-OR. Deterministic grounding (quotes parsed
   from the action text; destinations resolved against the roster/landmark
   table, never free-generated) is a small, model-independent fix that
   removes the whole class. Do that before scaling the model.
2. *Movement needs a speed limit and progress semantics, not just
   direction.* Strictly-closer + no cap lets a glance teleport 13 cells
   (tick 20) and a cross-office walk "succeed" with a 1-cell shuffle (tick
   15) — a large model will exploit the same loopholes more eloquently.
   Per-turn displacement cap + "halve the distance or arrive" for named
   landmarks turns walking into a multi-turn activity, which is precisely
   what sustains long conversations spatially (escort-to-desk,
   go-fetch-coffee become 2–3-turn arcs instead of instant or stalled).
3. *Fallback must become partial-apply.* 57% "Nothing changes" is what
   actually kills a long run: history fills with null events, questions
   never get answered, the desk never gets reached. A large model halves
   the rate but never zeroes it; keeping valid movement/patches and
   retrying only prose (or warning instead of failing on speech nits)
   converts dead turns into degraded-but-advancing ones. Longevity comes
   from graceful degradation, not from hoping every turn is perfect.
4. *Memory must compound, not just append.* Thoughts/memories updated most
   turns, yet Tanya stranger-frames Anton at ticks 6/15 and Dana re-asks
   the fit question at 14/17/20. Appends without consolidation drift over
   20 turns; over 200 they drown the prompt (full world JSON in every
   consequence call already grows linearly). Rolling summarization (per
   actor: relationship state, open questions, current project) + the
   per-actor refresh line (item 13) is the difference between a long
   conversation and a long amnesia. Context budget also demands it: 4 LLM
   calls/NPC turn (proposal+selection+judge+consequence) at full-world
   size is ~15 min/21 turns here; a 200-turn run needs summary + smaller
   consequence payloads regardless of model size.
5. *Verb-drop is a specification hole, not a size hole.* Omitting
   "handshake/sit/pour" from the narrative to dodge the patch requirement
   (ticks 12/15/9) is rational behavior for *any* optimizer under a
   narrative-side-only gate. Action-side requirements (action says X →
   patch X or fail) close it for all models at once.

**Could this sustain a long conversation with a decent large model?**
Yes — *conditionally*. With (a) deterministic quote/destination grounding,
(b) displacement cap + progress rule, (c) partial-apply fallback, (d)
action-side verb gates, and (e) memory summarization, the loop as designed
(propose→select→adjudicate→validate→log) is exactly the right substrate:
proposals already drive the arc, physics already holds space coherent, and
the log already supports audit. Without those five, a large model gives you
fewer Jeffs and better prose but the same structural stalls: teleports for
glances, answers that erase questions, objects that never change, and a
history full of "Nothing changes". Fix the grounding, keep the
architecture — then scale the model.
