# Stage 1 report — renderer-architecture shakedown: mechanics battery

Date: 2026-10-09. Scenario: `scenarios/office-anton.json` (Anton/Tanya/Dana).
Battery script: `scripts/stage1-mechanics.ts` (re-runnable: `npx tsx scripts/stage1-mechanics.ts`).
Live log: `logs/text_mv0zhlg9.jsonl`. Live save: `saves/office-anton_tick6.json`.

## Preflight (`npm run diagnose:ai`, offline)

17 passed, 2 warnings, 1 failure. The failure is `joingonka config`
(no API key) — irrelevant: both legs of this stage run local-only
(mock engines for the deterministic battery, `--provider ollama` for the
live leg). Ollama reachable with all three recommended models present;
no model loaded (idle); `ollama ps` mid-run showed
`huihui_ai/llama3.2-abliterate:3b` at **100% GPU** — the protocol's
GPU-offload gate is met. VRAM squatters: only negligible desktop processes
(voxtype-osd ~6 MB, brave gpu-process ~314 MB); no laya-serve resident.

## Leg A — deterministic scripted battery (mock engines, full pipeline)

11 scripted actions through proposal → selection → engine execute → mock
render, ordered to match the `anton/tanya/dana` rotation and to establish
preconditions (pick up while adjacent, approach before hand-over, clear the
recipient's hands before hand-over). Each step asserts: correct actor moved
(and only that actor), props/holders + scene-object relocation, history
quote byte-identical, no `(not done)` sentinel. Whole battery run **twice**;
final snapshots compared for determinism.

Result: **PASS** — 11/11 steps, 0 fallbacks, quotes exact, deterministic
across passes (22 turns total, 11 ticks per pass — under the 20-tick limit).

### Timing (wall-clock per step)

| Step | Name | Actor | Pass 1 | Pass 2 |
|---|---|---|---|---|
| 1 | walk-to-object (Anton walks to his desk) | anton | 76.9 ms | 6.2 ms |
| 2 | stationary-control | tanya | 11.2 ms | 3.9 ms |
| 3 | pick-up-laptop | dana | 8.6 ms | 5.0 ms |
| 4 | walk-toward-actor | anton | 8.6 ms | 5.5 ms |
| 5 | exact-quote-1 | tanya | 24.7 ms | 4.9 ms |
| 6 | walk-while-holding (carry retention) | dana | 9.0 ms | 5.5 ms |
| 7 | exact-quote-2 | anton | 6.6 ms | 3.9 ms |
| 8 | clear-hands put-down (places laptop on desk) | tanya | 5.4 ms | 4.7 ms |
| 9 | hand-over laptop Dana→Tanya | dana | 6.1 ms | 3.9 ms |
| 10 | exact-quote-3 | anton | 4.7 ms | 4.6 ms |
| 11 | hand-back laptop Tanya→Dana | tanya | 5.3 ms | 4.1 ms |
| | **Total** | | **0.17 s** | **0.06 s** |

Mechanics cost ~nothing (pass-1 step 1 includes scenario load/first-turn
warmup). The cost center is entirely the LLM calls measured in Leg B.

## Leg B — live smoke, text mode, local 3B (`--auto --limit-turns 6`)

`npm run start:auto -- scenarios/office-anton.json --provider ollama
--model huihui_ai/llama3.2-abliterate:3b --limit-turns 6`
(all decisions + render on the 3B model, Laya off). Generated economics via
`npm run report:turns -- logs/text_mv0zhlg9.jsonl` (table below is generated,
not hand-computed).

| Turn | Tick | Actor | Wall | Calls P/S/R | Outcome |
|---|---|---|---|---|---|
| 1 | 0 | anton | 5 s | 3 (1/1/1) | clean |
| 2 | 1 | tanya | 2 s | 4 (1/1/2) | fallback |
| 3 | 2 | dana | 3 s | 3 (1/1/1) | clean |
| 4 | 3 | anton | 3 s | 3 (1/1/1) | clean |
| 5 | 4 | tanya | 2 s | 4 (1/1/2) | fallback |
| 6 | 5 | dana | 4 s | 4 (1/1/2) | clean |

Summary: 6 turns, mean turn 3 s (~30 s wall including harness overhead),
3.5 provider calls/turn, **0 `budget_exceeded`**, 4/6 clean (67%).
Stage split: proposal 13 s / selection+execute 3 s / render 4 s of 20 s
telemetry wall — proposal dominates on the 3B model.

## Findings

**F1 — Hand-over guard is correct; battery setup was wrong (resolved).**
The first battery version handed Tanya a laptop while the scenario starts
her holding one. The engine (`src/core/objects.ts`: "the recipient's hands
must be free — the engine never stacks props") correctly rejected it.
Battery now clears her hands first. No engine change needed.

**F2 — Repetition-screen false positive: `other|desk` collision (action item).**
`validateSelectionForActor` rejected "Tanya places the laptop on the desk"
as a repeat of "Tanya stays at her desk and keeps working": both core to
`other|desk` because (a) `CORE_VERBS` has no put-down/place stem
(`pick up/grab/hold` → `take` exists; `place/put/set/lay` do not), and
(b) `CORE_NOUNS` first-match-wins puts location `desk` ahead of the
manipulated object `laptop`. Two semantically unrelated actions share one
core. The battery works around it by wording; live runs cannot.

**F3 — Put-down verb-ontology gaps (action item).** Third-person forms are
unmapped: "puts/sets X down" and "puts X aside" never plan (only imperative
"put/set X down", adjacent "puts down X", "places X on Y", imperative "set
aside"). Live turn 5's "puts laptop aside" executed no manipulation. This is
an executor-coverage hole of the exact kind Stage 1 hunts — currently
masked because render hallucinations fail those turns first.

**F4 — Carried scene-object orphan + identity swap (action item).**
Movement does not carry the linked scene object: after Dana walked across
the room holding the laptop, `dana_laptop` stayed orphaned at the pick-up
site, and the later hand-back re-linked the nearest laptop-kind object
(`tanya_laptop`) instead. Props (authoritative for prose) stay exact;
scene-object identity scrambles — user-visible in graphic mode (orphaned /
duplicated meshes). Fix: carry the linked object on movement (or store
`heldObjectId` on the actor) instead of proximity re-linking per turn.

**F5 — Live 3B render hallucinations caught by validators (Stage-2 preview).**
Both live fallbacks (2/6, 33%) are `movement.narrated_without_move`: the
render narrated walks the engine correctly did not execute — turn 2
invented "walks toward the desk and picks up the pen" for a wave; turn 5
invented "walks toward Dana" for an already-adjacent greet (engine
no-move was correct: Tanya (8,7) vs Anton (7,7)). Retry → same → graceful
liveness fallback, no state corruption, budget intact. The safety net
works; the 3B render miss rate is the number to beat in Stage 2 (14B).

**F6 — "Clean" turns with unfaithful prose pass validation (Stage-2 preview).**
Prose validators do not check render-vs-action grounding: turn 1 narrated
"walks toward Dana" while action and engine said Tanya; turn 6 narrated
door-gazing for a type-on-laptop action. Side effect observed: turn 1's
mis-rendered history core (`move|dana`) let Anton's turn-4 verbatim intro
repeat slip past the repetition screen. Decide before Stage 2 whether a
grounding/relevance check is in scope or an explicit non-goal.

**F7 — Decision-quality notes for Stage 3 baseline.** Turn-1 walk target
(Dana) mismatched addressee (Tanya); Anton repeated his intro verbatim at
turn 4. Nothing to fix here — this is the LLM-decision behavior the
cascade must beat 3× before fallback removal.

## Verdict against the falsifiers

- *Simple actions going `(not done)` at any real rate (executor holes)?*
  **Not falsified.** Deterministic leg: 0/22 fallbacks. Live leg: 2/6
  fallbacks, both traced to render hallucinations (F5) and one stacked
  verb-ontology gap (F3) — no executor failure on a well-formed simple
  action. F3 is a real but bounded coverage hole (put-down phrasings).
- *Frequent render retries (cost center moved, not died)?* **Watch item.**
  2/6 turns burned one render retry on 3B; retries stayed rare-or-absent
  everywhere else (0–1 extra call, never near budget). Stage 2 (14B) is
  the real test.
- *Cascade losing to LLM loop?* **Not yet tested** — Stage 3 pending.

Stage 1 passes on its architectural claims (deterministic execution, zero
unexplained `(not done)`, byte-identical quotes, correct props/holders),
with F2–F4 as bounded engine follow-ups that do not block Stage 2.

## Action items

- [ ] **A1 (engine):** add put-down/transfer verb stems (`place/put/set/lay`,
  incl. third-person) to `CORE_VERBS` and prioritize manipulated-object
  nouns over location nouns in `suggestionCore` (fixes F2; regression tests
  for the `other|desk` collision pair).
- [ ] **A2 (engine):** extend the put-down ontology to third-person
  "puts/sets X down" and "puts X aside" (fixes F3; tests per phrasing).
- [ ] **A3 (engine):** carry the linked scene object with the holder on
  movement, or record `heldObjectId` (fixes F4 orphan/identity-swap; assert
  in battery).
- [ ] **A4 (decision before Stage 2):** scope render-vs-action grounding
  check vs explicit non-goal (F6).
- [ ] **A5 (process):** re-run this battery after A1–A3, then proceed to
  Stage 2 (14B 5-turn smoke) and Stage 3 (`--compare` cascade-vs-LLM).
