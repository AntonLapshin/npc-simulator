# Stage 2 report — renderer-architecture shakedown: render honesty

Date: 2026-10-09. Scenario: `scenarios/office-anton.json` (Anton/Tanya/Dana).
Battery script: `scripts/stage2-render.ts` (re-runnable: `npx tsx scripts/stage2-render.ts`).
Live log: `logs/text_mv136s86.jsonl`. Live save: `saves/office-anton_tick5.json`.

## Preflight (`npm run diagnose:ai`, offline)

17 passed, 2 warnings, 1 failure — same shape as Stage 1. The failure is
`joingonka config` (no API key) — irrelevant: both legs of this stage run
local-only (mock/stub engines for the deterministic battery, `--provider
ollama` for the live leg). `laya-serve reachable` warns (refused) —
irrelevant, Laya stays off for Stage 2. `vram contention` warns on
negligible desktop processes only (voxtype-osd ~6 MB, brave gpu-process
~314 MB); no laya-serve resident.

Preflight addition: built the tuned `npc-qwen3-14b` variant (`num_gpu 999`,
`num_ctx 4096` — zero extra disk, shares base weights). `ollama ps`
polled every 30 s through the whole live run: **`npc-qwen3-14b` at 100%
GPU, 9.8 GB, ctx 4096, from first turn to last** — the protocol's
GPU-offload gate is met continuously, not just at idle.

## Leg A — deterministic render-honesty battery (scripted renders, full pipeline)

7 cases through proposal → selection → engine execute → scripted render →
prose validation on fresh `office-anton` worlds (Anton at tick 0). Each
case scripts the render per attempt (honest, or lie-then-honest, or
lie-then-lie) and asserts: accept attempt, grounding-code rejection,
history content, positions/props, call counts.

Result: **PASS** — 7/7, 0 fallbacks except the deliberate unrecoverable case.

| Case | Calls | Accepted@ | Failed | Outcome |
|---|---|---|---|---|
| honest-stationary | 1 | 1 | 0 | clean |
| hallucinated-walk (Stage-1 F5 repro) | 2 | 2 | 1 (`movement.narrated_without_move`) | clean, history honest, actor unmoved |
| wrong-destination (Stage-1 turn-1 repro) | 2 | 2 | 1 (`movement.destination_mismatch`) | clean, history names Tanya |
| altered-quote | 1 | 1 | 0 (`render_quote_reinserted`, no retry burned) | clean, quote byte-identical |
| honest-quote | 1 | 1 | 0 | clean |
| phantom-manipulation | 2 | 2 | 1 (`object.phantom_manipulation`) | clean, `anton.prop` still null |
| unrecoverable-fallback | 2 | — | 2 | fallback, sentinel marked, state untouched, in budget |

Every grounding gate fires on the exact code, the honest retry always
wins, the quote backstop burns no call, and the floor case degrades
gracefully (2 calls max by construction — `RENDER_MAX_ATTEMPTS`).

## Leg B — live smoke, text mode, local 14B (`--auto --limit-turns 5`)

`npm run start:auto -- scenarios/office-anton.json --provider ollama
--model npc-qwen3-14b --limit-turns 5`
(all decisions + render on the tuned 14B, Laya off). Economics generated
via `npm run report:turns -- logs/text_mv136s86.jsonl` (table below is
generated, not hand-computed).

| Turn | Tick | Actor | Wall | Calls P/S/R | Outcome |
|---|---|---|---|---|---|
| 1 | 0 | anton | 57 s | 4 (1/1/2) | clean |
| 2 | 1 | tanya | 38 s | 3 (1/1/1) | clean |
| 3 | 2 | dana | 1 m 3 s | 4 (1/1/2) | clean |
| 4 | 3 | anton | 57 s | 4 (1/1/2) | fallback |
| 5 | 4 | tanya | 1 m 13 s | 4 (1/1/2) | clean |

Summary: 5 turns, mean turn 58 s (~5 min wall), 3.8 provider calls/turn,
**0 `budget_exceeded`**, 0 liveness, 4/5 clean (80%). Stage split:
proposal 1 m 10 s / selection+execute 55 s / render 2 m 44 s of 4 m 49 s
telemetry wall — render dominates, as the architecture predicts.

### Per-turn audit (action → render verdicts)

- **Tick 0 (anton, clean, 1 retry).** Action: walk to Tanya's desk + ask
  for help finding his desk. Engine moved (16,2)→(11,5) toward Tanya.
  Render 1 kept no question → `speech.question_dropped` → retry narrated
  the walk and the question honestly. Retry legitimate.
- **Tick 1 (tanya, clean, 0 retries).** Quote action. Render altered the
  quote → deterministic `render_quote_reinserted` → accepted attempt 1.
  History carries the quote verbatim. The Phase-2 backstop working as
  designed on live 14B output.
- **Tick 2 (dana, clean, 1 retry).** Stationary mutter-to-self action;
  engine correctly planned no move. Render 1 invented "walks toward the
  desk … picks up the pen" → `movement.narrated_without_move` → retry
  accepted. **But the accepted retry narrates a bar scene** ("Staggered
  into the bar, shirt soaked, eyes bloodshot…") — fiction that passes
  every prose gate (see F3).
- **Tick 3 (anton, fallback, 2 retries exhausted).** Action text carries
  **model-emitted coordinates** "my desk at (3, 8)" (see F4). Engine
  planned a real move (11,5)→(9,10) but the render invented a pick-up
  (attempt 1) then a hand-over + dropped speech (attempt 2) →
  `fallback_used`. Graceful: sentinel-marked history, Anton stayed at
  (11,5), props untouched, 4 calls within budget, no liveness (threshold
  3 correctly not tripped on a first failure).
- **Tick 4 (tanya, clean, 1 retry).** Render 1 first-person ("I backed
  away from the mirror") + phantom hand-over → `narrative.first_person`
  + `object.phantom_manipulation` → retry accepted, third-person,
  correctly quoting "I need to reset the system…" inside dialogue.

Final state: anton (11,5) prop null / tanya (10,5) holds laptop / dana
(15,11) holds laptop — props/holders coherent, no phantom transfers
anywhere. Model coordinates (3,8) never materialized (Phase 1 holds).

## Findings

**F1 — Validator overreach: the `hand` noun trips manipulation + contact
gates (battery workaround, action item).** "Anton raises a hand in a
friendly wave" fails with `object.phantom_manipulation` (hand-over) AND
`contact.too_far` — a body-part noun collides with the transfer/contact
ontology, same family as Stage-1 F2/F3. The battery words around it
("waves a greeting"). Live impact: any 14B "raises a hand / takes her
hand" prose burns a retry it should not. Scope the detectors to transfer
verbs / exclude body-part nouns.

**F2 — Every grounding gate fired correctly on live 14B output.**
`narrated_without_move` (tick 2), `phantom_manipulation` (ticks 3, 4),
`first_person` (tick 4), `question_dropped` (tick 0),
`no_speech_rendered` (tick 3), quote reinsertion (tick 1). The
`destination_mismatch` gate did not occur live (no wrong-destination
render was emitted) but Leg A proves it rejects-then-recovers. No
invented coordinates, dialogue, or props survived into any history.

**F3 — Stage-1 F6 confirmed on 14B: unfaithful-but-valid prose passes
(A4 decision still open).** Tick 2's accepted bar-scene narrative is
"clean" by telemetry and fiction by content — no render-vs-action
grounding check exists, by current design. It also pollutes downstream
history cores. Before the Stage-4 20-turn run, decide explicitly:
render-vs-action relevance check, or declared non-goal (with history
hygiene accepted as-is).

**F4 — Model-emitted coordinates reached the action text (tick 3).**
"Walk west toward my desk at (3, 8)" — proposal/selection still let the
model write coordinates into prose. The engine ignored them (nothing
near (3,8) moved), so Phase 1 holds where it counts; but the prompt's
"do not emit coordinates" is advisory only. Consider a selection-screen
strip of coordinate patterns, or accept as harmless.

**F5 — Cross-cutting observation (not Stage-2 blocking): engine moved
Tanya on a quote-heavy non-locomotion turn.** Tick 1 "Pause my test plan
and say, 'Sure, let's go…'" planned `moves:true` ((8,7)→(8,10)) — the
"let's go" inside the *quote* likely parsed as locomotion intent.
Movement parsing should mask quoted spans (it already does for render
grounding). Filed for the movement owner, no action here.

**F6 — Retry rate: prose passed attempt 1 on only 1/5 live turns.**
4/5 turns burned exactly one retry. Three caught real dishonesty (ticks
2, 3, 4); tick 0's `question_dropped` is strictness-debatable (render 1
was sane prose that kept no question mark). The bound held — never more
than 1 extra call, 0 `budget_exceeded` — so the cost center did **not**
move (max 2 attempts by construction), but attempt-1 pass rate is the
number to watch in Stage 4. F1's fix buys back part of it.

## Verdict against the falsifiers

- *Simple actions going `(not done)` at any real rate (executor holes)?*
  **Not falsified.** 1/5 fallback, traced to a double-phantom render
  (both attempts invented transfers), not an executor failure. Engine
  execution was correct on all 5 turns (including the correctly-planned
  tick-3 move the fallback discarded by design).
- *Frequent render retries (cost center moved, not died)?* **Watch item,
  bounded.** 4/5 turns used one retry; total 19 calls / 5 turns (3.8,
  within budget). The 2-attempt cap means retries cannot become the old
  5.3-terminals-per-turn loop — but 20% attempt-1 pass is thin margin,
  and F1 is a known false-positive contributor.
- *Cascade losing to LLM loop?* **Not yet tested** — Stage 3 pending.

Stage 2 passes on its architectural claims (single render call narrates
executed facts honestly; invention is rejected with exact codes; quotes
verbatim by construction; failures degrade gracefully), with F1 as the
one bounded validator follow-up and F3 (A4) as the open scoping decision
that should be settled before Stage 4.

## Action items

- [ ] **B1 (validator):** scope manipulation/contact detectors past the
  `hand` body-part noun (fixes F1; regression tests for "raises a hand"
  / "takes her hand" wave prose).
- [ ] **B2 (decision, carries Stage-1 A4):** declare render-vs-action
  grounding in-scope or explicit non-goal before Stage 4 (F3 — the
  tick-2 bar scene is the exhibit).
- [ ] **B3 (selection/prompt):** strip or screen coordinate patterns
  from action text (F4 — harmless today, engine ignores them).
- [ ] **B4 (movement, cross-cutting):** mask quoted spans in locomotion
  parsing (F5 — "let's go" inside dialogue moved Tanya).
- [ ] **B5 (process):** re-run this battery after B1, then proceed to
  Stage 3 (`--compare` cascade-vs-LLM).
