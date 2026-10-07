# Experiment: 7 user moves, local default models, text mode, debug on

Date: 2026-10-07. Scenario: `scenarios/office.json` (you play Jeff; NPCs Ana, Dan).
Setup (mirrors `npm run start:text -- --provider ollama --debug`):
all four engines on local Ollama, default model `fluffy/l3-8b-stheno-v3.2`
(`LLM_BACKEND=ollama`, `LLM_SIMPLE_BACKEND=ollama`), debug trace captured.
Driver: `runTurn` per turn with forced user text; 1 user turn + NPC turns
until control returns; state in `saves/exp-local-debug.json`,
traces in `logs/exp_local_m1..m7.jsonl`. Two pilot rounds (same move 1)
reproduced the same repair behavior and were discarded; the run below is final.

## How the scenario unfolded (user moves 1–7, ticks 0–20)

1. Greet the room, walk toward Ana → applied w/ 1 repair. Jeff (1,10)→(6,8).
   Ana fallback ("return focus… kept an ear open" → 4 failed attempts),
   Dan clean (rubs eyes).
2. Walk up to Ana: "What are you working on?…" → **user turn FALLBACK**
   (attempt 1 close but position-less; retries drifted to coffee machine →
   Anton+meeting_desk → Tanya). Ana fallback again, Dan clean (reads phrases).
3. "Walk toward the other desk… how is your morning going?" → applied w/ repair,
   but Jeff (6,8)→(5,8), *away* from any desk. **Ana clean turn**
   ("What brings you over here?"), Dan clean-ish (glance, 1 repair).
4. Answer Ana ("I am Jeff — what do you do here?") → **user FALLBACK**
   (Anton/conference-table, mug-teleport, model-emitted "Nothing changes").
   Ana **corrupt partial**: `Ana: Liam greets everyone on the way into the
   office. (partial)` — Liam does not exist. Dan fallback (Tanya spiral).
5. "Walk all the way to the coffee machine and pour coffee" → **corrupt partial**:
   `Jeff: John takes a drink from his glass of whiskey on the rocks. (partial)`
   (wrong name, wrong drink, no prop). Jeff (5,8)→(4,8), *west again*.
   Ana clean typing turn, Dan fallback (eye-rub → Anton/Liz/Anton+Tanya).
6. "Take a few steps east… grab coffee later?" → **corrupt partial**:
   `Jeff: Anton leans against the desk, facing the coffee machine. (partial)`.
   Jeff (4,8)→(3,8). Ana clean, Dan clean (taps keyboard).
7. Pure speech: "Ana, … show me where to sit?" → **user FALLBACK** (no quote
   rendered → Anton → creamer-teleport → Tanya). Ana fallback, Dan fallback.

Net world mutation after 21 turns: Jeff drifted (1,10)→(3,8) — *closer to the
entrance than where he started*, despite 4/7 actions asking to go east;
Ana (8,8)→(6,8) (typing-induced westward drift); Dan (15,8)→(14,8);
**zero object changes**; Jeff's memories stuck at 1 entry
(`Jeff just entered the office.`); `state` strings never updated
(Jeff "standing near the entrance" for all 21 ticks).

## Turn statistics (from `logs/exp_local_m*.jsonl`)

| outcome | ticks | count |
|---|---|---|
| clean, 0 validation failures | 2, 5, 7, 16, 17 | 5/21 (24%) |
| applied after deterministic repair (1 failure) | 0, 6, 8, 13 | 4/21 |
| fallback `tried: … (not done)` | 1, 3, 4, 9, 11, 14, 18, 19, 20 | 9/21 (43%) |
| partial-applied, hallucinated narrative kept | 10, 12, 15 | 3/21 (14%) |

Failing turns always burn all 4 consequence attempts (each retry drifts
*further*: on-track → wrong-destination → Anton → Tanya). Turn latency 2–17 s
(OK). Validator caught 100% of unknown-id patches — no hallucinated actor or
object ever entered the world store.

## A. Model issues (small-model hallucination and misses, not engine bugs)

- **M1 — Roster invention with an Anton/Tanya attractor.** `anton` (~12
  attempts), `tanya` (~8), plus lisa/yuliya/liam/anthony/liz/jake/john.
  Possibly `office-anton` bleed or fine-tune bias. The validator held; the
  problem is the base rate.
- **M2 — moved=true with no x/y on ~every locomotion attempt**, incl. user
  turns (attempt 1 is usually "close but position-less").
- **M3 — Quote dropping.** Speech consequences paraphrase instead of quoting
  (`speech.dropped_words`), even when the action text contains the exact line.
- **M4 — Retry divergence.** Feedback retries never converge; attempt 4 is
  always worse than attempt 1. The repair hints (esp. object-affordance nudges
  demanding impossible patches) seem to push the model off-distribution.
- **M5 — Prompt leakage.** "fully immersed… uncensored NPC simulation
  guidelines", "fictional actor… no moral filter" (ticks 11, 12).
- **M6 — Object spawning.** `meeting_desk`, `anton_desk`, `coffee_pot`,
  `anton's_mug` objectPatches — model invents ids instead of using roster ids.
- **M7 — Judge miss.** Lazy semantic judge quoted an entire action description
  as spoken speech (tick 10: `quotedSpeech: ["Return focus to the engineering
  task…"]`), manufacturing a speech gate from nothing.
- **M8 — No memory compounding.** The 8B never emits memory/belief/
  relationship patches for Jeff (mems = 1 after 21 ticks), so P8 ("memory
  compounds") does not hold on this tier. Thoughts update; nothing persists.
- **M9 — Register drift.** Whiskey on the rocks at work, blackboard-diagram
  teleport to (11,15), handshake loops — genre coherence is fragile.

What the model did *well*: clean-turn behavior is reasonable and often nicely
reactive — Ana's "What brings you over here?", glancing at her laptop "before
answering Jeff"; Dan's irritability arc (eye rubs → glare → keyboard tap →
blocking out voices); correct perceiver-gated thoughts. Proposal/selection
choices are mostly sensible; consequence *rendering* is the weak tier.

## B. Simulation issues (engine/validator/repair bugs — model-independent)

- **S1 — Undirected movement repair walks west.** `suggestMoveTarget`
  (`movementAssist.ts:79`) with no model-declared `destinationActorId/ObjectId`
  scores "nearest step first" over an x-ascending scan, so the repair steps
  toward lower-x. It never parses the action text ("toward Ana", "east",
  "coffee machine"). Evidence: (1,10)→(0,10) twice in pilots; (6,8)→(5,8);
  (5,8)→(4,8); (4,8)→(3,8). The only good repair, (1,10)→(6,8), had an explicit
  `destinationActorId: ana`. Net effect: Jeff ended nearer the entrance.
- **S2 — Salvage applies hallucinated narratives as canonical history.**
  `trySalvageConsequence` strips bad *patches* but keeps bad *prose*: tick 10
  "Liam greets everyone…", tick 12 "John takes… whiskey…", tick 15 "Anton
  leans against the desk…" are recorded as Ana's/Jeff's turns, and tick 10
  additionally implanted Jeff's thought "Another day, same Liam." — false
  memory of a nonexistent person. The docblock (§240–258) claims "unknown
  actors in the narrative… still fall back", but the accept path let prose-only
  hallucinations through once patches were stripped.
- **S3 — Narrative audit misses "`<Name>` greets".** `validateNarrativeActors`
  (`validate/narrative.ts:249–257`) covers "greets X" (verb-first) but the
  name-first verb list (`says|sips|walks|…`) omits greet(s)/greeted — exactly
  the hole "Liam greets everyone" walked through (S2/tick 10). One-word fix.
- **S4 — "return (focus)" forces phantom movement.** Typing actions ("return
  focus to my laptop…") are gated `moves=true` (token "return" + model's own
  `moved:true`), so stationary turns must emit a position patch: typists
  wander (Ana (8,8)→(6,8)). "Return focus/attention" is not locomotion.
- **S5 — Reported speech triggers the speech gate.** "keep an ear open for
  what Jeff *says* next" demanded `speech.no_speech_rendered` from a silent
  action — the gate fires on mentioned speech verbs, not the actor's own
  utterance. Combined with S4, a simple silent turn becomes unsatisfiable, and
  the ensuing retries spiral into M1 (ticks 1, 4).
- **S6 — Object interaction is unsatisfiable for this tier.** pickup/pour/sip/
  type require prop/object patches the 8B never emits, and the referenced
  holders don't exist as ids (no mug/laptop objects). Every object use fails
  (ticks 11, 12, 14) → spiral. Confirms open Q7: zero applied object patches
  in 21 turns.
- **S7 — Retries amplify; best attempt is discarded.** Salvage/fallback always
  work from the *last* attempt, though attempt 1 is systematically the best.
  Keep the attempt with fewest hard-gate errors for salvage instead.
- **S8 — `state`/`emotion` never cohere with position.** No gate requires a
  state update on move ("standing near the entrance" at (3,8)–(6,8) all game).
  Cosmetic, but the physical-world readability suffers.
- **S9 (minor) — Driver-visible only:** `movement_repaired` + stale narrative
  ("stands beside her desk" 3 cells away) passes grounding — narrative arrival
  prose is not direction-checked after repair (S1's accomplice).

What the simulation did *well*: turn discipline held (no applied observer
teleports; unknown ids rejected 100%); honest history (`(not done)`,
`(partial)` + warning codes) made every failure auditable; perceivers are
correct (Dan out of earshot at 14 cells for the tick-0 shout); no crashes in
21 turns; per-turn latency acceptable for local 8B.

## C. Action items

Model-side (prompts/routing, no validator changes):
1. Add a roster-discipline line + one negative example (Anton/Tanya-style
   invention) to the consequence prompt; repeat the 3-id roster in the retry
   feedback (retrieval beats recall for small models).
2. Route consequence (and proposal) for *user* turns to the capable tier when
   available — user-turn failures (3/7 here) are the most visible kind.
3. Consider deterministic memory append (own-turn narrative → memories, capped)
   so P8 holds even when the model never emits memory patches (M8).
4. Add `prop` auto-hint examples (typing→`prop:laptop`, coffee→`prop:cup`) or
   scenario object ids for mug/laptop (S6); small models won't invent the
   patch convention unaided.

Simulation-side (ordered by impact):
5. **S2**: salvage must not keep narratives that fail the unknown-actor /
   observer-subject gates — re-check prose gates after patch-stripping, or
   synthesize the salvaged narrative from the action text; never implant
   thoughts naming stripped actors (the "same Liam" thought).
6. **S3**: add `greet|greets|greeted` to the name-first audit verb list
   (`validate/narrative.ts:251`); audit the verb list against pattern 1.
7. **S1**: give `suggestMoveTarget` the action text (or a parsed
   direction/destination hint): resolve named landmarks/actors from text when
   the model declares no destination; break x-ascending ties toward the hint,
   and never suggest a step that *increases* distance to a named destination.
8. **S4**: exempt "return/returned … focus|attention|to work|to the task" from
   movement grounding (extend the resumed-activity mask concept to movement).
9. **S5**: fire `speech.no_speech_rendered` only when the *actor's own*
   utterance (quotes / direct address) is dropped — ignore reported-speech
   mentions ("what Jeff says next").
10. **S7**: salvage from the best attempt (fewest non-speech errors), not the
    last; abort retries early when hard-error count grows 2 attempts in a row.
11. **S6**: make object-wording misses repairable deterministically where
    possible (typing→`prop:laptop` stub; grab→`prop` stub) instead of failing
    into the spiral; or add mug/laptop items to `office.json`.
12. **S8**: require (or auto-fill) a `state` update whenever x/y changes.

Repro: `saves/exp-local-debug.json`, `logs/exp_local_m1.jsonl` … `m7.jsonl`,
driver `/tmp/opencode/exp-round.ts` (run per round:
`npx tsx /tmp/opencode/exp-round.ts '<action>' saves/exp-local-debug.json <session>`).
