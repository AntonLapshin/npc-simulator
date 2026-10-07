# Experiment 2 — office-anton.json, 10 adaptive user turns, local 8B, debug on

## 1. Command used

```bash
npm run start:text -- scenarios/office-anton.json \
  --provider ollama --model fluffy/l3-8b-stheno-v3.2 \
  --debug --no-autosave
```

Interactive, not piped: the run lived in a `tmux` session (`exp2`), one `action:`
line was typed per user turn **after reading the two NPC turns** that followed
the previous action. 10 user turns → **ticks 0–29 (30 turns)** in
`anton → tanya → dana` rotation. `quit` at the end.

- Full terminal transcript (debug blocks): `/tmp/exp2_full.log` (copy of the
  `tee`'d session output, 864 lines).
- Session JSONL: `logs/text_muxe590w.jsonl` — 662 entries, 30 `turn_completed`,
  30 `patch_applied`, **2 `fallback_used` (ticks 5, 15)**, 41 `validation_failed`
  / 41 `consequence_failed` (all retried), 3 `movement_repaired`.
- All tick-by-tick claims below were cross-checked against `patch_applied`
  entries in that JSONL (narrative / `effects` / `actorPatches` /
  `objectPatches`), not just the debug story text.

## 2. The 10 user turns (adaptive play as Anton)

| # | tick | Anton's action (typed after reading NPCs) | Why this action |
|---|------|-------------------------------------------|-----------------|
| 1 | 0 | Greet **both** by name from entrance, Sixt callback to Tanya + hello to Dana | Audibility across room + does each addressee get patched? |
| 2 | 3 | Walk toward Tanya: "where is my desk?" | Destination fidelity + direct-question answering |
| 3 | 6 | Sit on chair at my new desk + ask both about desk/setup | Pose change + still-unanswered desk question |
| 4 | 9 | Turn to nearby Tanya, repeat desk question explicitly | 3rd attempt at same info — persistence test |
| 5 | 12 | Walk to Dana's desk, handshake + thanks for hiring work | Long walk toward an actor + adjacency |
| 6 | 15 | Walk to NW coffee machine, pour coffee + remark | Long walk to named object + object interaction |
| 7 | 18 | Walk toward Dana, ask "what should my first backend task be?" | Direct task question to the recruiter |
| 8 | 21 | Walk to west-side desk, sit, open laptop, set up | Pose/prop/object triple instruction |
| 9 | 24 | Smile at adjacent Tanya, accept help, ask laptop setup + first task | Adjacent Q&A — easiest possible case |
| 10 | 27 | Thank both, announce heading to west desk to set up laptop | Closing + named-destination walk |

## 3. What happened per tick (ground truth from JSONL)

- **0 (user):** narrative *"Anton walks to the coffee machine and starts brewing"* —
  user greeting ignored, teleport (16,2)→(11,10), `spoke:false`, Dana (named
  addressee) unpatched, no object patch for brewing.
- **1 (Tanya):** action greet/invite to desk → narrative *"Anton and Tanya shake
  hands in the office hallway"* — no hallway exists, no movement applied,
  handshake at ~4-cell distance. Proposal [2] misgenders Dana ("if **she**
  needs").
- **2 (Dana):** 3 validation failures → accepted *"Dana turns toward the
  **interviewer**"* + thoughts *"What's next in this **interview**?"* Move
  (15,11)→(14,11) shuffle. Anton/Tanya unpatched. Role confusion
  (recruiter-screening → interview).
- **3 (user):** *"Anton walks toward the **water cooler**"* — asked Tanya/desk,
  got cooler + (3,7), speech dropped, Tanya unpatched. Rejected attempts named
  **Jeff, Samantha, "Morning! How everyone doing today?"**.
- **4 (Tanya):** action "walk to Anton at the **entrance**" (Anton is at (3,7) —
  stale) → narrative literally **`"string"`**, zero patches, **validation
  PASSED**.
- **5 (Dana):** action handshake/orientation → all 4 attempts *"pats **Jeff**"* /
  *"Hey **Jeff**…"* → **`FALLBACK "Nothing changes."`** (correct fallback, model
  obsessed with Jeff).
- **6 (user):** sit-at-own-desk asked → *"Anton approaches Tanya, saying 'Hi
  Tanya, nice to meet you'"* — sit dropped, generic greeting replaces two real
  questions, (7,7) instead of own chair (4,7), goal overwritten to "get
  acquainted with Tanya".
- **7 (Tanya):** handshake action → *"Tanya approaches the **whiteboard**"* (no
  whiteboard in scene) + (2,7), away from Anton (7,7). Speech dropped. Passed.
- **8 (Dana):** handshake narrative ok but Dana (13,11)→(13,11)+1 shuffle while
  Anton at (7,7) — handshake at ~7 cells. *"her desk"* (Dana is he/him).
- **9 (user):** desk question repeated → *"Anton types on his laptop"* — no
  movement, no speech, Tanya/Dana unpatched. (Structured patch did set
  `pose=sit, prop=laptop` — narrative/position still wrong.)
- **10 (Tanya):** FIRST relevant proposal ("walk Anton to his desk, gesture,
  return to testing") → consequence generic handshake greeting + (9,5), thoughts
  *"Nice to **finally meet him**"* (they worked together at Sixt!). 3
  observer-move rejections — validator worked, semantics still lost.
- **11 (Dana):** action handshake → narrative ***"Tanya sips her coffee"***,
  patches **only Tanya**, acting actor Dana unpatched — turn-discipline
  violation, **validation PASSED**.
- **12 (user):** walk-to-Dana done right: Anton→(12,11), adjacent to Dana
  (13,11), Dana patched (validator forced the retry — good). Defects: *"her
  desk"*, *"**junior** developer"* (scenario: backend developer), paraphrased
  speech ("contribute to **your projects**" — Dana has none).
- **13 (Tanya):** selection invents *"pick up his mug, fill it at the machine"*
  → consequence *"Tanya finishes typing and **sips** coffee"* — no mug, no
  Anton, (10,8) is neither machine (2,1) nor Anton (12,11). `unknown object id:
  coffee machine` (model doesn't know `coffee_machine`). Anton unpatched.
- **14 (Dana):** action orientation at Anton's desk → *"Dana walks closer to
  **Jeff**"* + *"Hope **he's okay after that fall**"* (no fall ever happened) +
  (9,15). Narrative names Jeff with no Jeff patch — passes because validator
  checks patch IDs, not narrative names.
- **15 (user):** coffee-machine walk → attempts hallucinate **Julie, Lisa, Bob,
  Jeff** → **`FALLBACK`**. Intent erased, Anton frozen at (12,11).
- **16 (Tanya):** comforting-arm action → *"nice to **meet** you!"* (not a first
  meeting), no movement, touch at ~3.6 cells.
- **17 (Dana):** action "explain urgent backend requirements/deadlines" (the
  onboarding answer Anton needs!) → *"Dana approaches the coffee machine, fills
  **her** mug"* + (7,4), ~6 cells from machine, no Anton patch. Proposals keep
  *"after his recent **fall**"* and *"Anton's **application**"* (he's hired).
- **18 (user):** walk-to-Dana + task question → *"Anton **adjusts his tie**"*
  (no tie in `look`) — no movement, no question, Dana unpatched, **passed**
  (same error classes failed on ticks 12/27 — inconsistent).
- **19 (Tanya):** proposal context is Anton's (*"Anton wants to get
  comfortable…"*), selection *"**Turn to Tanya** and ask…"* while actor IS
  Tanya — perspective flip. Consequence *"stands up"*, no movement, Anton
  unpatched.
- **20 (Dana):** full identity hijack (reproduces exp-1 tick 20): all proposals
  are Anton's (*"I think **I'm going to like it here!** … anything **QA
  related**"*), reasoning *"**As the new backend developer**…"* — Dana is the
  recruiter. New hallucinated name **Tyrone**. Ends *"stands up"* + repaired
  shuffle (6,4), no laptop boot, no object patch.
- **21 (user):** desk+sit+laptop triple instruction → *"Anton asks Tanya about
  her **weekend plans**"* — total invention, no movement/sit/laptop. Passed.
- **22 (Tanya):** *"Offer to help Anton set up his desk…"* — narrative finally
  matches action; Tanya→(11,11) adjacent to Anton (12,11). Validator's
  closer-to-target check fired twice (good). But direct addressee Anton
  unpatched, no object/pose work.
- **23 (Dana):** breath/focus action matches narrative, but pointless shuffle
  (6,4)→(5,4) for breathing; reasoning mentions moving *"closer to **Jeff**"*;
  first attempt put Anton **outside scene bounds** (caught). Anton/Tanya
  unpatched.
- **24 (user):** smile at adjacent Tanya + laptop/task questions → *"Anton walks
  into the office, **holding a laptop bag**, approaches Tanya's desk"* (already
  inside, no bag) + *"Hope she likes my **resume**"* / Tanya *"looks like a
  **candidate**"* (hired colleague framed as applicant — stale). Closer-check
  correctly rejected (3,5) first attempt. Questions dropped again.
- **25 (Tanya):** repeats tick-22 setup offer verbatim (3rd time incl. tick 28);
  consequence matches + patches **both** actors with on-topic thoughts (best Q&A
  moment of the run) — yet still no concrete task info, no movement, no
  object/pose. 3 retries (inside-desk, observer-move, speech-drop,
  closer-check) all correctly caught.
- **26 (Dana):** sigh action (good stressed-focus behavior) → *"Dana walks
  towards the desk, **her** eyes scanning"* + (4,5), *"I can see the **script**"*.
  Attempts hallucinate **Mia** + greetings. Movement contradicts internal
  action; accepted anyway.
- **27 (user):** thank-both + head-west-to-desk → *"walks to his desk on the
  **north side** and begins typing"* + (3,14) (lounge area, not desk (3,8));
  `pose=sit, prop=laptop` set (good) but Tanya/Dana (both addressed) unpatched
  — validator forced one retry then accepted the unpatched retry.
- **28 (Tanya):** setup/first-task offer → *"Tanya turns toward Anton as **he
  enters**"* (nobody entered) + *"**Who's that guy?**"* (referred him, worked
  with him at Sixt!). Anton unpatched. Passed.
- **29 (Dana):** *"Remind Anton of code conventions/style guides"* (first
  concrete task-adjacent content, role-plausible) → *"Dana moves toward the
  empty chair, **picks up the laptop**, and sits down"* + `pose=sit,
  prop=laptop, state=seated` at (8,4) — whose laptop? No object patch, Anton
  unpatched despite reminder addressed to him. Passed.

Totals: `objectPatches` empty on **all 30 ticks** (brewing, pouring, sipping,
mug pickup, laptop open/boot/pickup, sitting never touch objects). Pose/prop/
state changed on 8 ticks (9, 10, 13, 17–20, 27, 29) — better than exp-1's
zero, but never paired with the object it implies.

## 4. Verdict: engine vs. small-model attribution

**Engine loop is sound, semantic validation is not.** Turn order, proposal skip
for users, proposal→selection→consequence for NPCs, history, retry/fallback,
inside-furniture and observer-move rejection, unknown-ID rejection, and the
*new* closer-to-target check (ticks 22/24/25 — absent in exp-1) all demonstrably
work. Scenario arc stays roughly on track (greetings → desk hunt → handshake
attempts → coffee attempts → task requests → setup offers) because proposals
are usually relevant even when consequences are not.

**Model (8B) weaknesses** — hallucinated actors (Jeff ×5+, Samantha, Julie,
Lisa, Bob, Mia, Tyrone, "interviewer"), dropped/paraphrased speech, persona
hijack (Dana→Anton twice), pronoun flips (Dana she/her ×6), repetition loops
(Dana handshake ×3, Tanya setup offer ×3), stale frames (candidate, entrance,
fall, meeting, tie, resume, weekend), wrong destinations, invented objects
(whiteboard, script, tie, bag). These are quantity-heavy but
*mechanically* catchable.

**Engine misses** (validation PASSED but should have failed — the main
finding): placeholder narrative `"string"` (tick 4); acting actor unpatched
while observer patched (tick 11); narrative naming a non-existent actor with
no corresponding patch (tick 14); implied-movement-without-position-change and
direct-address-without-addressee-patch enforced on some ticks (12, 22, 25, 27)
but waved through on others (18, 21, 24-narrative, 28, 29); contact at
distance with no adjacency rule (ticks 1, 7, 8, 16); wrong-destination moves
accepted (ticks 7, 17, 27); 30/30 empty `objectPatches` despite constant object
talk. Consequence ignores the decided/user action's core verb on ~1/3 of ticks
(0, 3, 9, 18, 21 + 7, 13, 17) with no penalty beyond the wording check.

Note (exp-1 §5 fixed?): the debug story now shows the **last** attempt
*("attempt N of N shown; earlier attempts rejected")*, and a deterministic
`[movement repaired …]` marker appears (ticks 20, 22, 24). The misleading
first-attempt rendering from exp-1 is gone.

## 5. Action items

Engine (correctness — each has a failing tick above as repro):

1. **Placeholder/schema leak:** reject narratives in `{"string", "(none)", "",
   action-text echo}` and consequence with zero patches *and* zero movement for
   a movement/social action (tick 4). Cheap regex + patch-emptiness rule.
2. **Acting-actor patch required:** if the only patches are observers, fail
   (tick 11). Symmetric to the existing observer-move rule.
3. **Narrative name audit:** scan `narrative`/`reasoning` for actor names/IDs
   with no matching patch or roster entry — fail "unknown actor **Jeff** in
   narrative" (ticks 2, 5, 14). Closes the patch-ID-only loophole.
4. **Consistent movement/speech/addressee checks:** ticks 18/21/28/29 pass with
   the exact error classes that fail elsewhere. Make
   movement-implies-position, exact-words, and direct-addressee-patch
   deterministic gates on **every** turn incl. user turns, not retry-feedback
   lottery.
5. **Contact adjacency:** handshakes, hand-on-arm, handing items require
   Chebyshev distance ≤ 1 after the move (ticks 1, 7, 8, 16). Same class as
   inside-furniture rejection.
6. **Destination fidelity (extend the new check):** the closer-to-target rule
   already works (22/24/25) — apply it to *user* turns with named landmarks
   ("my desk", "coffee machine", "toward Dana") and to object claims ("at the
   coffee machine" must be within N cells of `coffee_machine`), fixing ticks
   7/17/27. Needs landmark→coordinate resolver (desks, machine, actors).
7. **Object grounding:** any brew/pour/sip/type/open/pick-up/sit verb without a
   matching `objectPatches` or `pose`/`prop` entry is a warning → error after
   N retries (all 30 ticks currentlyistry empty). Ship the known ID list
   (`coffee_machine`, `anton_mug`, `anton_laptop`, `anton_chair`, …) into the
   consequence prompt — ticks 13/17 prove the model guesses display names.
8. **Question queue:** Anton asked "where is my desk?" (ticks 3, 6, 9) and
   "first task?" (ticks 6, 18, 24) with zero answers; tick 10/22/25 proposals
   show the model *can* answer when it notices. Add `pendingQuestionsAskedOfMe`
   to proposal/selection context (exp-1 item 6, still open).

Small-model prompting (make the 8B's job easier; each maps to a repeated
failure):

9. **Roster + pronoun anchor:** inject `Actors present: Anton (he/him) at …;
   Tanya (she/her) at …; Dana (he/him) at … — no one else exists. Never invent
   or address anyone else.` Kills Jeff/Samantha/Julie/Lisa/Bob/Mia/Tyrone/
   interviewer in one line (ticks 2, 3, 5, 14, 15, 20, 26).
10. **Persona footer on selection/consequence:** restate `You are <name>, the
    <role>. You are NOT <others>.` — Dana→Anton hijack (ticks 19, 20; exp-1
    tick 20) keeps recurring.
11. **User-turn verbatim rule:** consequence must quote or closely paraphrase
    the user's speech and execute its movement verb; "weekend plans / tie /
    water cooler / coffee brewing" substitutions (ticks 0, 3, 18, 21) fail
    loudly today only sometimes.
12. **History de-duplication hint:** append last-3 own actions to selection
    context with "don't repeat greetings/handshakes/setup offers unless the
    situation changed" (Dana ×3 handshakes; Tanya ×3 setup offers).
13. **Memory refresh line:** one-line "Anton: hired backend dev, ex-Sixt with
    Tanya (not a candidate, not a stranger)" in Tanya/Dana context — kills
    "candidate arriving early / nice to meet you / who's that guy" (ticks 16,
    24, 28) and "after his fall / entrance" staleness.

Repro checklist: ticks 4, 11, 14, 18, 21 for validator gaps; ticks 5, 15 for
fallback positives; ticks 12, 22, 24, 25 for checks that already work and
should be generalized.
