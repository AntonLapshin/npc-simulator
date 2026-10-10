# Experiments: office-anton, tuned 14B re-run (B) + 8B speed/quality (C) — 2026-10-10

Follow-up to `office-anton-14b.md` (baseline: stock `qwen3:14b`, think-flag
unset in exports). Two runs, same protocol: 5-turn smoke → 20-turn
acceptance → `report:turns`. Scenario `scenarios/office-anton.json`
autonomous text UI throughout.

## Run config (both experiments)

- git: master @ `411480b` ("Clean up"). Note: baseline ran at `b0b267f`;
  `411480b` is a later cleanup commit on the same tree (no engine changes
  affecting turn economics; logs/saves from the baseline run are gone —
  `logs/` was cleaned before these runs, so all baseline numbers below are
  quoted from `office-anton-14b.md`).
- Run env (exports, `.env` untouched):
  `LLM_BACKEND=ollama LLM_SIMPLE_BACKEND=ollama OLLAMA_MODEL=<variant>`
  `LLM_THINK=0 LAYA_MODE=on TURN_TIME_BUDGET_MS=30000`
- Ollama 0.35.1, system `ollama.service` (no sudo — daemon env untuned,
  same deviation as baseline). `npc-qwen3-14b` rebuilt idempotently from
  the exact B1 Modelfile (`num_gpu 999`, `num_ctx 4096`, `num_batch 1024`
  — all three confirmed via `ollama show`); `npc-stheno-8b` built fresh
  from the same pattern over `fluffy/l3-8b-stheno-v3.2`.
- `ollama ps` mid-run: `npc-qwen3-14b` at **100% GPU**, 9.8 GB, ctx 4096;
  `npc-stheno-8b` at **100% GPU**, 5.4 GB, ctx 4096.
- laya-serve: up on 127.0.0.1:8000, CPU mode (POST /v1/systemone answers
  400 with the validation message; stale `--help` cmdline quirk unchanged).
- `npm run diagnose:ai`: 17 pass, same 2 expected FAILs (`joingonka
  config`, `engine wiring`) + the known desktop-VRAM WARN.

## Headline: the think hypothesis is falsified on this setup

The premise for ordering B before C was "LLM_THINK unset = model default
= qwen3 thinks at ~700 extra tokens (~12 s) per call." Three measurements
say otherwise:

1. `npm run probe:think -- --model npc-qwen3-14b` (the engine's own `/v1`
   path, consequence-shaped JSON prompt): **think:false = 4661 ms, 331
   completion tokens; flag unset = 4815 ms, 359 tokens; no `<think>` leak
   either way.** Script verdict: "think:false is effective — completion
   volume is comparable."
2. Native `/api/chat`, tiny JSON prompt, flag unset: **no `<think>` leak**,
   177 eval tokens in 2.3 s. qwen3 does not emit chain-of-thought for
   "begin with `{`" JSON prompts on this Ollama build either way.
3. The game runs: B-smoke with `LLM_THINK=0` explicitly exported still
   produced 6–19 s proposal / 5–34 s render calls — the baseline band. A
   removed 12 s/call would have halved call times. Nothing halved.

Contributing config fact: `src/util/loadEnv.ts` backfills *unset* exports
from `.env`, and `.env` ships `LLM_THINK=0` (`src/llm/provider.ts`: unset
→ flag not sent; `0` → `think:false`). So the baseline run (no
`LLM_THINK` in exports) most likely *already* ran think-off — "unset"
never meant "model default" in this codebase. Per-call cost here is
~2k-token prompt ingest + generation at ~60 tok/s, not reasoning tokens.
B's result (below) confirms the bottleneck is elsewhere.

## Experiment B: tuned 14B re-run — prediction failed

- Smoke (5 turns): `logs/text_mv1ovwey.jsonl`. **4/5 clean, 1 fallback**
  (turn 1: 54 s, proposal 19 s + 34 s render stage, "moves toward Tanya
  (not done)"). Mean turn 27 s, 11 calls (2.2/turn). Prose sane-ish:
  nervous Anton, impatient Dana; one unintroduced coffee cup (turn 4).
  Verdict at the time: clean 4/5 with an ugly turn 1, go for full run.
- Acceptance (20 turns): `logs/text_mv1p0g7j.jsonl`,
  `saves/office-anton_tick20.json` (later overwritten by run C — see §C).

| Metric | Baseline | Tuned B | Prediction |
|---|---|---|---|
| Total wall | 8m 30s | 10m 39s | — |
| Mean turn | 25 s | 32 s | — |
| p50 / p90 (telemetry) | 24.6 / 37.4 s | 26.8 / 47.3 s | p90 < 30 s ✗ |
| `turn_time_exceeded` | 8 / 20 | **10 / 20** | ~0 ✗ |
| Clean turns | 20 / 20 | 19 / 20 | — |
| Fallback turns | 0 | 1 (turn 4/tick 3, 61 s) | — |
| Provider calls | 45 (2.3/turn) | 47 (2.4/turn) | — |
| proposal mean (median, max) | 14 s | 17 s (14 s, 43 s) | 6–9 s ✗ |
| render mean (median, max) | 12 s | 15 s (14 s, 36 s) | 6–9 s ✗ |
| Strict-clean (attempt-1) | 15 / 20 (75%) | ~12 / 20 (60%) | — |

Telemetry seconds (sorted): 14.0, 17.3, 19.1, 19.8, 20.2, 22.0, 23.4,
24.3, 26.3, 26.8, 28.3, 30.9, 31.6, 38.3, 39.2, 45.8, 47.2, 47.3, 56.5,
60.9. Validator: 18 `render_accepted`, 9 `render_failed`, 2
`narrate_accepted_despite_violations`, 7 `retry_started`
(25 `consequence_failed` vs 25 completed, 4 `intent_failed` — validator
retries elevated vs baseline's +0.3 calls/turn).

Every latency metric got *worse*. Baseline already ran at 100% GPU, so
`num_gpu 999` had nothing to reclaim — the tuned variant is a no-op plus
run-to-run noise, and the noise went the wrong way (p90 +10 s).

Prose notes (quality, outside the gates): **3+ full genre breaks**, worse
than baseline's one — turn 10 (Anton): "The sun set over the horizon,
casting long shadows across the desolate battlefield."; turn 11 (Tanya):
"The thief's hand trembled as they pried open the rusted lock…"; turn 13
(Anton): "The flickering candlelight cast long shadows across the damp
stone floor as the rogue whispered secrets to the ancient relic…". Same
model as baseline, so this is validator/retry variance, not a model
property — strengthens the case for a genre/character consistency check
in the validator. Dana repeats the laptop-clenching beat; Anton freezes
mid-run (no director events in scenario — as designed).

## Experiment C: 8B stheno — ~20× faster, visibly thinner

- Smoke (5 turns): `logs/text_mv1pg1vz.jsonl`. **5/5 clean**, wall 8 s,
  mean 2 s, 10 calls (2.0/turn). First quality signal: turn 2 narrate
  leaks grid-speak — "moves from (8,7) to (8,10), arriving at 0 cells from
  her desk."
- Acceptance (20 turns): `logs/text_mv1pglvc.jsonl`,
  `saves/office-anton_tick20.json` (+ per-turn autosaves tick11–19; these
  saves now hold the 8B run — last writer wins for shared stems).

| Metric | 8B (C) | 14B tuned (B) |
|---|---|---|
| Total wall (report) | 32 s | 10m 39s |
| Mean / p50 / p90 (telemetry) | 1.6 / 1.5 / 1.6 s | 32 / 26.8 / 47.3 s |
| `turn_time_exceeded` | 0 | 10 / 20 |
| Clean / fallback | 20 / 20 / 0 | 19 / 20 / 1 |
| Calls/turn | 2.1 (42 total) | 2.4 (47 total) |
| proposal / render mean | 0 s (8 s tot) / 1 s (24 s tot) | 17 s / 15 s |

Telemetry seconds (sorted): 1.2, 1.3, 1.3, 1.4, 1.4, 1.5, 1.5, 1.5, 1.5,
1.5, 1.5, 1.6, 1.6, 1.6, 1.6, 1.6, 1.6, 1.6, 2.5, 2.7. Caveat: the console
clocked ~5 s/turn while telemetry sums 1.6 s — ~3.5 s/turn lives outside
turn telemetry (laya calls / save / loop overhead). Still an order of
magnitude under the 12–18 s prediction.

Prose assessment (the tradeoff): on-genre throughout, **zero breaks**,
inner thoughts present — but movement narrates routinely leak
coordinates ("moved 6 cells toward Tanya", "stands at (11, 5)", "moves
3.5 cells", "moves six cells towards the Office printer"), Dana repeats
one monitor-screening beat across turns, Anton mostly stands/fidgets.
Functional, flat, gamey at the edges — clearly below 14B color.

## Generated tables (pasted, not hand-computed)

### B acceptance (`npm run report:turns -- logs/text_mv1p0g7j.jsonl`)

| Turn | Tick | Actor | Wall | Calls (P/S/R) | Outcome |
|---|---|---|---|---|---|
| 1 | 0 | anton | 39s | 3 (1/0/2) | clean |
| 2 | 1 | tanya | 46s | 2 (1/0/1) | clean |
| 3 | 2 | dana | 23s | 2 (1/0/1) | clean |
| 4 | 3 | anton | 1m 1s | 2 (1/0/1) | fallback |
| 5 | 4 | tanya | 22s | 2 (1/0/1) | clean |
| 6 | 5 | dana | 19s | 2 (1/0/1) | clean |
| 7 | 6 | anton | 47s | 3 (1/0/2) | clean |
| 8 | 7 | tanya | 24s | 2 (1/0/1) | clean |
| 9 | 8 | dana | 17s | 2 (1/0/1) | clean |
| 10 | 9 | anton | 31s | 2 (1/0/1) | clean |
| 11 | 10 | tanya | 32s | 2 (1/0/1) | clean |
| 12 | 11 | dana | 14s | 2 (1/0/1) | clean |
| 13 | 12 | anton | 38s | 3 (1/0/2) | clean |
| 14 | 13 | tanya | 20s | 2 (1/0/1) | clean |
| 15 | 14 | dana | 20s | 2 (1/0/1) | clean |
| 16 | 15 | anton | 27s | 3 (1/0/2) | clean |
| 17 | 16 | tanya | 56s | 3 (1/0/2) | clean |
| 18 | 17 | dana | 28s | 2 (1/0/1) | clean |
| 19 | 18 | anton | 26s | 3 (1/0/2) | clean |
| 20 | 19 | tanya | 47s | 3 (1/0/2) | clean |

### C acceptance (`npm run report:turns -- logs/text_mv1pglvc.jsonl`)

| Turn | Tick | Actor | Wall | Calls (P/S/R) | Outcome |
|---|---|---|---|---|---|
| 1 | 0 | anton | 2s | 2 (1/0/1) | clean |
| 2 | 1 | tanya | 1s | 2 (1/0/1) | clean |
| 3 | 2 | dana | 1s | 2 (1/0/1) | clean |
| 4 | 3 | anton | 2s | 2 (1/0/1) | clean |
| 5 | 4 | tanya | 2s | 2 (1/0/1) | clean |
| 6 | 5 | dana | 1s | 2 (1/0/1) | clean |
| 7 | 6 | anton | 2s | 2 (1/0/1) | clean |
| 8 | 7 | tanya | 3s | 3 (1/0/2) | clean |
| 9 | 8 | dana | 1s | 2 (1/0/1) | clean |
| 10 | 9 | anton | 2s | 2 (1/0/1) | clean |
| 11 | 10 | tanya | 2s | 2 (1/0/1) | clean |
| 12 | 11 | dana | 2s | 2 (1/0/1) | clean |
| 13 | 12 | anton | 1s | 2 (1/0/1) | clean |
| 14 | 13 | tanya | 3s | 3 (1/0/2) | clean |
| 15 | 14 | dana | 1s | 2 (1/0/1) | clean |
| 16 | 15 | anton | 1s | 2 (1/0/1) | clean |
| 17 | 16 | tanya | 2s | 2 (1/0/1) | clean |
| 18 | 17 | dana | 2s | 2 (1/0/1) | clean |
| 19 | 18 | anton | 2s | 2 (1/0/1) | clean |
| 20 | 19 | tanya | 1s | 2 (1/0/1) | clean |

## Bottom line

- **Think is not the lever** (no `<think>` output with or without the
  flag; `LLM_THINK=0` changes nothing measurable; `.env` already supplies
  it when exports don't). Stop spending runs on it.
- **The tuned 14B variant is a no-op** (baseline already 100% GPU) and the
  latency hypothesis is rejected by measurement — dig into ingest vs
  generation split per call (Ollama timings) before further tuning. The
  sudo-gated `OLLAMA_NUM_PARALLEL=1` + flash-attention is still untested
  but now has a lower expected value.
- **8B is the iteration engine**: 20/20 clean at ~2–5 s/turn, usable for
  loop/mechanics work; not a quality substitute (coordinate leakage, flat
  beats). Consider a render-prompt fix for cell/coordinate leakage — it
  showed up in both smoke and acceptance, so it's systematic, not noise.
- Open quality item (now 4+ cases across runs): validator
  genre/character consistency check.
