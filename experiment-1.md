# Experiment 1 — office-anton.json, text UI, local model, debug on

## 1. Command used

```bash
# sidecar (default stack piece from scripts/start.sh): laya-serve was started first
.laya-venv/bin/laya-serve > /tmp/laya-serve-exp1.log 2>&1 &

# the actual simulation (text mode, default local model, debug mode, no autosave)
npm run start:text -- scenarios/office-anton.json \
  --provider ollama --model fluffy/l3-8b-stheno-v3.2 \
  --debug --no-autosave < /tmp/exp1_inputs.txt > /tmp/exp1_full.log 2>&1
```

Notes:
- `npm start` (`scripts/start.sh`) launches the graphic console, so the text-mode
  equivalent of its defaults (scenario `office-anton.json`, local Ollama model
  `fluffy/l3-8b-stheno-v3.2`, `--debug`, Ollama + laya sidecars) is the
  `npm run start:text ...` command above.
- `laya-serve` came up healthy on `http://127.0.0.1:8000` (uvicorn startup complete).
  The run itself used `--provider ollama`, so all Proposal/Selection/Consequence
  calls went to `ollama/fluffy/l3-8b-stheno-v3.2`; laya was up but not in the path.
- 7 scripted Anton actions were piped in (greet → approach Tanya → go to desk →
  approach Dana → coffee machine → ask Tanya for first task → sit at desk and open
  laptop), then `quit`. One `action:` line advances the user turn plus the two
  following NPC turns, so 7 inputs produced **ticks 0–20 (21 turns)**.
- Full transcript with debug blocks: `/tmp/exp1_full.log`.
  Session JSONL: `logs/text_muxd1tl0.jsonl` (21 turns, 0 fallbacks).

## 2. Scenario idea (after persona enhancement)

First day in the office. **Anton** (28, backend developer, user-controlled) joins
on **Tanya**'s referral — they worked together at Sixt on booking APIs. He is
polite, nervous, wants a good first impression, to find his desk, set up his
laptop and learn his first task. **Tanya** (early 30s, QA engineer, married, dry
humor, friendly) feels responsible for him and wants to finish a small test plan
before lunch while helping him settle. **Dana** (late 20s, tech recruiter,
outgoing but irritable when interrupted) never met Anton and is heads-down
screening candidates for an urgent backend req due Friday. Turn order:
`anton → tanya → dana`. Expected arc: greetings → Tanya shows Anton his desk →
Dana gives a brief welcome but guards his focus → Anton gets coffee, asks for a
first task, sits down to set up.

Persona work also cleaned up the old file: removed an inappropriate planted
"secret" in Tanya's beliefs, fixed the "wokred" typo, and fixed Dana (persona
said *recruiter* but his goal/memories said *design draft* — now consistently a
recruiter with a hiring deadline). `scenarios/office-anton.json` is gitignored,
so the enriched file lives on disk only.

## 3. Did the engine work? (yes, with caveats)

- All 21 turns completed, one per actor in rotation, no crashes, no
  `fallback_used` ("Nothing changes."). The validator caught 9 bad consequence
  outputs (missing x/y on movement, inside-furniture coordinates, dropped
  dialogue, observer movement) and every one was repaired or retried to a pass.
- Turn discipline mostly held: user turns skip proposal/selection, NPC turns run
  proposal → selection → consequence, history appended every tick.
- Early scenario development was logical: tick 0 greeting → tick 1 Tanya gets up
  to welcome Anton → tick 2 Dana glances over while staying focused. Dana's
  ticks 2/5/17 correctly protect his hiring focus; Tanya's proposal reasoning
  repeatedly references the Sixt referral, so personas do steer behavior.
- Raw debug totals for the run: 14 proposals, 14 selections, 25 consequence
  completions (4 ticks needed a second attempt), 9 validation failures, 5
  deterministic movement repairs, 3 proposal JSON parse retries (tick 10),
  6 consequence schema retries — all recovered without fallback.

## 4. Observations / issues (all from the debug blocks)

### Critical — behavior-breaking

1. **Hallucinated destination + teleport (tick 6).** Anton's action: walk to *his
   west-side desk*, put bag down, look at laptop/mug. Consequence narrative:
   *"Anton takes a seat at the conference table across from Dana"* — there is no
   conference table in the scene — and moves him to **(18,10)** (east side),
   with thoughts about "this meeting". Validation passed. Instruction ignored,
   object invented, teleport across the office.
2. **NPC contradicts its own action with invented dialogue (tick 17).** Dana's
   decided action: *"Turn back to my work on candidate screening…"*. Consequence
   narrative: *"Dana gestures toward the coffee machine and says, 'Want a
   cup?'"* — speech that is nowhere in the action text. Validation passed.
   Direct violation of the narrative rule that is enforced on other ticks
   (8, 14).
3. **Identity/persona hijack (tick 20).** Dana the recruiter proposes and picks
   *"Open the laptop and start setting up my development environment…"* with
   reasoning *"As the new backend developer, I want to start integrating…"* —
   Anton's role leaked into Dana. Consequence: *"Dana … setting up her
   development environment"* (also wrong laptop, wrong pronoun).

### Major — movement/physics

4. **Movement discussed but not applied, or applied wrong.** Tick 3 ("walk over
   toward Tanya") first proposed (5,8) — inside Anton's own desk rect, correctly
   rejected — but the accepted retry dropped movement entirely while the
   narrative still says he walks over. Tick 9 ("walk toward Dana") moved Anton
   from (18,10) to **(7,12), away from Dana at (15,11)**. Tick 12 (walk to
   NW-corner coffee machine) ended with no position change at all. Tick 18
   ("sit at my desk") landed on (6,12)/(5,12) — open floor, not the chair at
   (4,7). Tick 11 handshake and tick 8 handshake happen across ~8 cells with no
   movement.
5. **Repair coordinates are token shuffles, not real walking.** The 5
   `movement_repaired` cases (ticks 1, 8, 12, 18, 20) inject a nearby reachable
   cell (e.g. Tanya (8,7)→(7,7) for "walk over to greet Anton" who stands at
   (16,2)). It satisfies the validator but the debug narrative still claims a
   cross-room walk. Readers of the debug trace see movement that never happened.
6. **Turn-discipline violation (tick 19).** Tanya's consequence moved observer
   Anton to (5,12) alongside her own move — correctly flagged (*"only the
   acting actor may move"*), retried to Tanya (4,12). Good catch, but the debug
   story block still renders the **rejected first attempt** (see §5).

### Major — social/logic coherence

7. **Direct addressees get no reaction patch.** Anton speaks *to Tanya* (tick 3:
   "where is my desk?") → patched: Anton + Dana, **not Tanya**. Dana welcomes
   Anton (tick 5) → only Dana patched. Dana explains culture to the room
   (tick 14) → only Dana patched. Anton asks Tanya for his first task
   (tick 15) → only Anton patched. The "affected / not affected" lists routinely
   omit the person spoken to, while bystanders get thoughts.
8. **NPCs don't answer direct questions.** Tanya never answers "where is my
   desk?" (tick 3 → tick 4 repeats a generic greeting) and never answers "what
   should be my first task?" (tick 15 → tick 16 *"Walk back to her chair and
   continue working…, leaving Anton to settle in"*). No information transfer
   across 21 ticks: Anton still doesn't know his desk or his task.
9. **Repetition loops.** Tanya picks near-identical *"walk over to greet Anton
   warmly"* at ticks 1, 4, 7 (options differ, choice doesn't). Dana picks
   *"Welcome to the team!"* at ticks 5, 8, 11 (tick 11's action text even
   carries a broken trailing `}`: `…team!}`). Selection never notices it already
   did this; "verbatim vs new wording" only compares against current options,
   not history.
10. **Role/goal drift.** Tanya (QA) goes to "help with candidate screening"
    (tick 13) and abandons her test plan; Dana (recruiter) gives a culture
    speech (tick 14) then "configures the toolchain and IDE" (tick 20). Nobody
    pursues a goal across turns; goals never update in any patch.

### Minor — language/decorum

11. **Pronoun drift for Dana (he/him in scenario).** "extends *her* hand"
    (tick 8), "ask if *she* needs help" (tick 10), "setting up *her*
    development environment" (tick 20), "which *she* responds to" (tick 9).
    The scenario consistently says he/his; the model flips it.
12. **Speech truncation.** Tick 9 keeps only "Hi, I'm Anton." from a longer
    intro + hiring question; tick 12+ drops "where is my desk?" style content
    from quotedSpeech while claiming `spoke: true`. The exact-words rule fires
    for NPC turns (ticks 8, 14) but seemingly not for user-turn consequences.
13. **Stale proposals.** Tick 1 option "grab tea *before Anton arrives*"
    (he already arrived); tick 2 calls hired Anton a "candidate"; tick 17
    proposal returned a single suggestion while all other NPC turns got 9–12.
14. **Zero object/pose/prop/state updates in 21 turns.** Coffee poured, mugs,
    laptops opened, bags put down, chairs sat on — `objectPatches` is empty
    every tick, and no patch touches `pose` (sit/stand), `prop` (cup/laptop) or
    `state` except one emotion flag. Sitting, carrying coffee, and setup leave
    no trace, so the world can't reflect them later. Thoughts occasionally empty
    (Tanya, tick 19 retry).

## 5. Debug-trace rendering issue (worth fixing first — it misleads analysis)

`renderTurnStory` shows the **first** `consequence_completed` per tick, but on
retried ticks (3, 8, 14, 19) the applied result was a *later* attempt. E.g. tick
3's debug block shows Anton moving to (5,8) — the coordinates the validator
rejected as inside the desk — while the accepted retry actually dropped the
move. Tick 19's block shows the illegal observer-move of Anton that was
rejected. Anyone "looking only at debug statements" (as this experiment did)
will misread what the world applied. The story renderer should pick the
**last** consequence completion (or the post-repair result) per tick.

## 6. Verdict

The engine loop is sound (turn order, validation gates, repair, retry,
logging all functioned; scenario develops in the intended direction for the
first ~6 ticks), but the 8B local model frequently ignores action specifics,
teleports or shuffles instead of walking, drops dialogue wording, repeats
greetings, leaves addressees unpatched, never touches objects/pose/props, and
once hijacked another persona. Roughly half the 21 debug blocks contain at
least one such defect; validation catches shape errors well but not semantic
ones (wrong destination, handshake at distance, unanswered questions).

## 7. Action items

1. **Story trace:** render the accepted (last / post-repair) consequence per
   tick instead of the first; include final x/y and a retry marker.
2. **Contact adjacency:** reject physical contact (handshake, handing coffee)
   beyond adjacent cells, same as inside-furniture rejection (ticks 8, 11).
3. **Destination fidelity:** when action names a target ("my desk", "coffee
   machine", "toward Dana"), require the new position to be closer to the named
   landmark/actor than the old one; reject teleports to unrelated areas
   (tick 6) and wrong-direction moves (tick 9).
4. **Speech preservation for user turns:** apply the exact-words narrative rule
   to user-turn consequences too (ticks 9, 15); keep quotedSpeech complete.
5. **Addressee patching:** nudge consequence prompts so actors spoken to (or
   named as destination) always get at least a thoughts/memory patch; empty
   "not affected" for a direct addressee should be a validation warning
   (ticks 3, 5, 9, 14, 15).
6. **Question answering:** give NPCs access to salient pending questions (or add
   a "questionsAskedOfMe" cue) so direct questions get answered next turn
   instead of looped greetings (ticks 4, 16).
7. **Repetition guard:** include recent own actions in the selection prompt with
   "don't repeat an action you already took unless the situation changed",
   and/or penalize verbatim cross-turn repeats (Tanya ×3, Dana ×3).
8. **Object/pose/prop updates:** prompt and validate that sitting, holding,
   opening, pouring produce `pose`/`prop`/`state`/object patches; 21 ticks
   with zero object changes suggests the "minimalism" instruction overshoots.
9. **Pronoun anchoring:** inject each actor's pronouns (or he/him + his desk
   style reminders) into consequence context; Dana flipped to she/her 4+ times.
10. **Persona anchoring for NPCs:** restate role + goal + "you are NOT
    <other actors>" in selection/consequence context; Dana adopted Anton's
    backend-developer identity (tick 20).
11. **Movement repair honesty:** when repair injects only a shuffle, either walk
    multi-step toward the real destination or downgrade the narrative
    ("shifts in place") so the debug story doesn't claim cross-room walks.
12. **Proposal robustness:** tick 10 needed 3 parse retries and tick 17
    returned 1 suggestion — add retry/fill to guarantee a full option set.
