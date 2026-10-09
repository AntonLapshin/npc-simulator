# Stage 3 report — cascade-vs-LLM decision comparison

Date: 2026-10-09. Scenario: `scenarios/office-anton.json` (Anton/Tanya/Dana).
Question: does the Laya decision cascade lose to the LLM decision path?
Same render model, same engine, same turn count (10) on both legs; only
proposal+selection differs. Render is identical, so the B2 faithfulness gap
applies equally to both legs and does not confound the comparison.

- Leg 1 (cascade): `logs/text_mv15s9wp.jsonl`, save
  `saves/office-anton-cascade_tick10.json` (copied aside before Leg 2 ran;
  both legs write `saves/office-anton_tick10.json`).
  Env: `LAYA_MODE=static LAYA_SELECTION=1 LAYA_LOCOMOTION=1
  LAYA_RENDERABILITY=1 LAYA_JUDGE=0 LAYA_TRIAGE=0 LAYA_SALIENCE=0`
  (`LLM_DECISION_FALLBACK` unset = default 1, safety net available).
- Leg 2 (LLM): `logs/text_mv16adni.jsonl`, save
  `saves/office-anton_tick10.json` (+ per-tick `saves/office-anton_tick1..9.json`).
  Env: `LAYA_MODE=off`.
- Both legs: `npm run start:auto -- scenarios/office-anton.json --provider
  ollama --model npc-qwen3-14b --limit-turns 10`.
- Compare (re-runnable):
  `npx tsx scripts/eval-run-quality.ts --compare
  saves/office-anton-cascade_tick10.json logs/text_mv15s9wp.jsonl
  saves/office-anton_tick10.json logs/text_mv16adni.jsonl`
  plus `npm run report:turns -- logs/<each-session>.jsonl` (tables below
  are generated, not hand-computed).

## Step 0 — Laya server

`laya-serve` was not running (curl refused). The typed-decisions checkpoint
was already in the HF cache (`snapshots/7b928d…` contains `typed-decisions`),
so no `setup:laya -- --all` reinstall was needed. Started
`npm run serve:laya` (background; `LAYA_DEVICE=cpu`, `LAYA_PRELOAD=1` from
`.env`). Operational note: this build's `--help` probe (used by
`serve-laya.sh` to detect `--device`) binds `:8000` and serves while it
preloads, so the wrapper script blocks at the probe while the server is
already live — harmless here, but the script never gets to `exec` the real
flags. `nvidia-smi` never listed the laya python process: **0 MB VRAM**
before, during, and after both legs (only `llama-server` ~9.6 GB + negligible
desktop processes resident).

Sanity `npm run diagnose:ai -- --live`: **20 passed, 3 warnings, 1 failure**
— same shape as Stages 1–2 (failure is `joingonka config`, no API key,
irrelevant: both legs run `--provider ollama`). **`laya live` PASS**:
choice probe `winner="diagnostics ping" p=0.99`. The comparison is meaningful:
without a live server the cascade would silently fall back and the legs
would be identical.

## Step 1 — preflight (protocol)

Offline `npm run diagnose:ai`: 17 passed, 2 warnings, 1 failure (joingonka) —
same shape as Stage 1. `ollama ps` at idle: no model loaded. Pre-warmed
`npc-qwen3-14b` with one tiny `think:false` probe, then verified
**100% GPU, 9.8 GB, ctx 4096** before Leg 1. Re-polled `ollama ps` 4–5×
through each leg: **100% GPU continuously on both legs** — the
GPU-offload gate is met throughout, not just at idle. Pre-warming also
removes a cold-start confound (Leg 1 would otherwise pay the model-load
cost and Leg 2 would not).

Env gotcha (protocol-relevant): the code default IS cascade-on
(`readLayaRuntimeConfig`: `LAYA_MODE=static`, selection/locomotion/
renderability on), but **`.env` pins `LAYA_MODE=off` and every `LAYA_*`
toggle to 0**, and the `.env` loader fills only unset vars. So bare
`npm run start:auto` runs the LLM path, and `LAYA_MODE=static` alone would
run a half-cascade (Laya proposal, chat-LLM selection). Leg 1 therefore
sets the three decision toggles explicitly — full default cascade, no
judge/triage/salience/planner.

## Leg 1 — cascade, 10 turns (11 m 32 s wall, mean 1 m 9 s/turn)

`npm run report:turns -- logs/text_mv15s9wp.jsonl` (generated):

| Turn | Tick | Actor | Wall | Calls P/S/R | Outcome |
|---|---|---|---|---|---|
| 1 | 0 | anton | 48 s | 1 (0/0/1) | clean |
| 2 | 1 | tanya | 39 s | 1 (0/0/1) | clean |
| 3 | 2 | dana | 1 m 13 s | 2 (0/0/2) | fallback |
| 4 | 3 | anton | 1 m 45 s | 2 (0/0/2) | clean |
| 5 | 4 | tanya | 1 m 12 s | 2 (0/0/2) | fallback |
| 6 | 5 | dana | 1 m 14 s | 2 (0/0/2) | fallback |
| 7 | 6 | anton | 1 m 22 s | 1 (0/0/1) | clean |
| 8 | 7 | tanya | 1 m 12 s | 2 (0/0/2) | clean |
| 9 | 8 | dana | 1 m 13 s | 2 (0/0/2) | fallback |
| 10 | 9 | anton | 54 s | 1 (0/0/1) | clean |

Summary: 6/10 clean, 4/10 fallback, **0 `budget_exceeded`**. Stage split:
proposal 4 m 14 s (mean 25 s) / selection+execute 2 m 14 s / render 5 m 4 s.
Turn 4 (1 m 45 s) is over the 90 s gate — render-side (two render attempts,
60 s render stage on consequence schema retries), same machinery as every
Stage-2 retry; written explanation, not a shrug. **The P/S columns read
0/0 on every turn and that is a lie** (see F2): proposal burned 13–48 s of
LLM latency per turn while reporting zero calls.

Decision events (the honest signal): `intent_decided` 10/10, but
`proposal_completed` 9, `selection_completed` 14, `proposal_failed` 11,
`selection_failed` 3, `selection_substituted` 4, `fallback_used` 4.
**Zero of 10 turns completed on the cascade path** — every turn's final
proposal and selection came from the LLM fallback (tick 6, the one turn
with no `proposal_completed`, ended on LLM `selection_completed("none")`
after 5 proposal + 3 selection failures).

Cascade intents (`intent_decided`): 9× `interact/object` (examine or
"move it aside"), 1× `speak/none/casually` (tick 6). In a dialogue-dominant
office scene the static cascade classified nearly every turn as object
interaction — the first failure point (see F1).

### Per-turn audit (action → render verdict)

- **Tick 0 (anton, clean).** Intent `interact/object/move-it-aside` →
  fallback. LLM: ask Tanya where his desk is. Render accepted attempt 1.
- **Tick 1 (tanya, clean).** Intent `interact/object/examine` → fallback.
  LLM: desk is "with the lamp", offer setup help. Quote reinserted
  deterministically (`render_quote_reinserted`).
- **Tick 2 (dana, fallback).** Fallback action names the desk "with the
  name plate". Render failed twice (consequence schema mismatches) →
  graceful sentinel, props untouched.
- **Tick 3 (anton, clean, >90 s gate).** Fallback: approach Tanya's desk +
  ask for help. Render 1 invented a pick-up, retry narrated walk+speech
  honestly. The 1 m 45 s is two ~30 s render attempts, not decisions.
- **Tick 4 (tanya, fallback).** Fallback: walk to Anton's desk to help.
  Render failed twice (`finish_reason=length` empties) → sentinel.
- **Tick 5 (dana, fallback).** Fallback: deflect Anton to Tanya. Same
  render-empty failure shape → sentinel.
- **Tick 6 (anton, clean).** The one `speak` intent — cascade still failed
  (no candidates path), then the LLM fallback ITSELF collapsed (5 proposal
  failures incl. repetition-screen rejections + `max retries exceeded`, 3
  selection failures) → degraded to action `none`, which the render
  narrated as adjusting the monitor. Salvaged by render, not by decisions.
- **Tick 7 (tanya, clean).** Fallback: ask if Anton needs laptop/lamp help.
  Render retry then accept.
- **Tick 8 (dana, fallback).** Fallback chain bottomed out at action
  `none` → `(not done)` sentinel. Degenerate but graceful.
- **Tick 9 (anton, clean).** Fallback: ask Dana about the name plate.
  Accepted attempt 1.

Final state: anton (16,2) prop null — **never moved all run**; tanya (8,7)
holds laptop; dana (15,11) prop null. Props/holders coherent, no phantom
transfers.

## Leg 2 — LLM (`LAYA_MODE=off`), 10 turns (9 m 53 s wall, mean 59 s/turn)

`npm run report:turns -- logs/text_mv16adni.jsonl` (generated):

| Turn | Tick | Actor | Wall | Calls P/S/R | Outcome |
|---|---|---|---|---|---|
| 1 | 0 | anton | 1 m 32 s | 4 (1/1/2) | fallback |
| 2 | 1 | tanya | 52 s | 4 (1/1/2) | fallback |
| 3 | 2 | dana | 1 m 21 s | 4 (1/1/2) | fallback |
| 4 | 3 | anton | 53 s | 4 (1/1/2) | clean |
| 5 | 4 | tanya | 51 s | 4 (1/1/2) | fallback |
| 6 | 5 | dana | 47 s | 3 (1/1/1) | clean |
| 7 | 6 | anton | 45 s | 3 (1/1/1) | clean |
| 8 | 7 | tanya | 29 s | 3 (1/1/1) | clean |
| 9 | 8 | dana | 1 m 1 s | 3 (1/1/1) | clean |
| 10 | 9 | anton | 1 m 23 s | 3 (1/1/1) | clean |

Summary: 6/10 clean, 4/10 fallback, **0 `budget_exceeded`**, 35 provider
calls (3.5/turn — honestly counted: 1/1/1–2). Stage split: proposal
3 m 32 s (mean 21 s) / selection+execute 1 m 48 s / render 4 m 33 s. Turn 1
(1 m 32 s) is 2 s over the 90 s gate — render-side (67 s render stage over
two attempts), same explanation class as Leg 1 turn 4.

Decision events: `proposal_completed` 9, `selection_completed` 10,
`proposal_failed` 10, `selection_failed` 7, `fallback_used` 4,
`intent_decided` 0 (cascade correctly absent). Quality warts exist here
too — tick 8's chosen action was the degenerate literal `example action`
(a proposal-screen miss), rendered as borrowing a notebook → clean by
telemetry. The B2 faithfulness gap fires on both legs equally, as predicted.

Final state: anton (3,3) holds cup / tanya (3,4) holds laptop / dana
(15,11) holds laptop. Anton actually crossed the room and ended adjacent
to Tanya — on task-ish grounds (meet/reach) the LLM leg weakly dominates;
no formal tasks were defined, so this stays observational.

## The `--compare` verdict (metric 7)

```
turns                        cascade=10  llm=10
LLM proposal calls           cascade=9   llm=9
LLM selection calls          cascade=14  llm=10
laya intent decisions        cascade=10  llm=0
usage payloads               cascade=64  llm=61
fallback rate                cascade=40% llm=40%
applied/partial/fallback     cascade=6/0/4  llm=6/0/4
memory precision             cascade=94% llm=93%
selection rejections         cascade=0   llm=0
intent bans                  cascade=0   llm=0

NO DECISION: the cascade path still made LLM proposal/selection calls
(23 vs 19 on the LLM path) — investigate before any gate talk.
```

Metric 7 (did the cascade eliminate decision LLM calls at quality
parity-or-better?): **No.** Decision LLM invocations: 23 cascade vs 19
LLM. Quality: identical histograms (6/0/4, 40% fallback), memory 94% vs
93% (noise). Wall clock: cascade slower (11 m 32 s vs 9 m 53 s; proposal
stage mean 25 s vs 21 s — the cascade pays Laya latency then full fallback
latency and saves nothing). The cascade leg ran 4 EXTRA selection
invocations (`selection_substituted` ×4 vs ×0) — the intent-first path
costs more, not less.

## Verdict against the falsifier

- *The cascade leg burns as many LLM proposal/selection calls as the LLM
  leg (i.e. it keeps falling back)?* **CONFIRMED — and worse.** 9/9
  proposal parity, 14/10 selection against. `intent_decided` fires 10/10
  but converts 0/10 times. This is the phase-gate doing its job: **no
  win #1 of 3, no Stage 4, re-scope instead of force-merge.**

## Findings (fallback causes, for the re-scope)

**F1 — Intent-kind calibration is the first failure point.** 9/10 cascade
intents were `interact/object` in a scene where every natural action is
speak/move. The slim-state → kind mapping misclassifies office dialogue;
everything downstream (target resolution → candidate rendering →
confidence) then fails on a wrong-typed intent. Fix the kind classifier
before touching anything else; a cascade that opens `speak` on dialogue
turns would convert some turns without any other change.

**F2 — Telemetry is blind to fallback cost (measurement bug, action
item).** `ProviderCallCounter.note` counts only engines declaring
`providerBacked === true`. The LLM engines declare it; the Laya wrappers
do not — so delegated fallback calls vanish: Leg 1 reports P/S = 0/0
while burning 23 real LLM invocations (and 4 m 14 s of proposal latency).
The per-turn table and the 4-call budget cannot see fallback spend. Fix:
the Laya engines should report provider-backed-ness dynamically (or the
counter should observe the fallback invocation), otherwise the budget
gate is decorative on the cascade path.

**F3 — Laya fail reasons are dropped from the log (observability gap).**
`LayaProposalEngine.fail()` prefixes reasoning with `laya proposal:
<cause>; fallback: …`, but the only persisted `proposal_completed` event
comes from the inner LLM engine (pure-LLM reasoning) — zero `laya
proposal:` strings in the whole Leg-1 log. The exact per-turn cause (no
candidates vs low confidence vs target-resolution failure) is
unrecoverable post-hoc; this report infers it from intents + downstream
events. Persist the wrapper result (or a `cascade_delegated` event with
the cause) so the next comparison can attribute precisely.

**F4 — Selection-side cost goes the wrong way.** 14 vs 10 selection
invocations: the intent-first substitution/re-selection loop (`selection_
substituted` ×4, renderability re-selection) adds LLM calls the pure path
never makes. Even a calibrated cascade must beat this overhead, not just
reach parity on proposal.

**F5 — The fallback LLM path itself is load-bearing and flaky.**
Leg-1 tick 6 shows the end of the degradation chain: cascade fails →
LLM proposal fails 5× (schema + repetition-screen) → `max retries
exceeded` → LLM selection fails 3× → action `none` → render salvages a
clean turn. A cascade that merely "fails safe" still pays the full flaky
chain on every turn.

## Action items

- [ ] **C1 (decision):** recalibrate the static intent-kind mapping on
  dialogue scenes (F1); prove a single end-to-end cascade turn in smoke
  before any re-run of this comparison.
- [ ] **C2 (telemetry):** make fallback-delegated LLM calls visible to
  `ProviderCallCounter`/budget (F2); the P/S columns must not read 0
  while the fallback burns calls.
- [ ] **C3 (observability):** persist the cascade delegation cause per
  turn (`cascade_delegated` event or wrapper reasoning in the log) (F3).
- [ ] **C4 (decision):** audit the intent-first selection loop cost —
  substitution + renderability re-selection must not exceed the chat path
  (F4).
- [ ] **C5 (process):** re-run this exact comparison (10 turns, same
  commands) only after C1 shows a converting smoke; scale to 20 only if
  the verdict is ambiguous. Do not proceed to Stage 4 on this result.
