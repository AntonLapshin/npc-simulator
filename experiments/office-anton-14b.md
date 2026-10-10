# Experiment: office-anton, text mode, 14B all-local (2026-10-09)

Scenario `scenarios/office-anton.json`, autonomous text UI, 20-turn acceptance run
plus 5-turn smoke run. 14B variant: intent + narrate both on local Ollama.

## Run config

- git: master @ `b0b267f` ("Clean up"), `git pull` clean ("Already up to date").
- Run env (exports, `.env` untouched):
  `LLM_BACKEND=ollama LLM_SIMPLE_BACKEND=ollama OLLAMA_MODEL=qwen3:14b`
  `LAYA_MODE=on TURN_TIME_BUDGET_MS=30000`
  - `LAYA_MODE=on` overrides stale local `.env` (`LAYA_MODE=off`, predates
    `.env.example` default `on`). With `off`, parsing is silent-deterministic
    and `parser_completed` never fires — that would measure the wrong thing.
  - `TURN_TIME_BUDGET_MS=30000` equals the code default; set explicitly so the
    run config is self-documenting.
- Ollama: system `ollama.service` on 127.0.0.1:11434 (could not restart via
  `npm run ollama:serve` — no sudo; daemon env lacks the tuned `OLLAMA_*`).
  Deviation accepted on evidence: `ollama ps` showed `qwen3:14b` at **100% GPU**,
  9.6 GB, ctx 4096, before, during (smoke), and after the acceptance run.
  Tiny-probe: 5.2 s total (4.9 s one-time model load, inference instant).
- laya-serve: up on 127.0.0.1:8000, CPU mode (`nvidia-smi` shows no laya python
  process in VRAM). Note: the serving process cmdline reads `laya-serve --help`
  (serve-laya.sh's `--device` probe appears to have become the server —
  pre-existing script bug; server answers correctly, left alone).
- `npm run diagnose:ai`: 17 pass. 2 FAIL, both pre-existing / expected:
  - `joingonka config` — no API key, and the run uses `LLM_BACKEND=ollama`, so
    the hosted backend is unused (would be WARN under the acceptance routing).
  - `engine wiring` — stale diagnose script calls
    `engines.selectionEngine.select`; `createLlmEngines` now returns
    `{ consequenceEngine, semanticJudge, intentEngine, getEnginesForTurn }`.
- 8B variant (`qwen3:8b`) NOT run — model not in local store, system store
  unreadable without sudo, and a 9 GB pull was out of scope. Recommended follow-up.

## Artifacts

- Smoke (5 turns): `logs/text_mv1njhje.jsonl`, `saves/office-anton_tick5.json`
- Acceptance (20 turns): `logs/text_mv1nmk4g.jsonl`, `saves/office-anton_tick20.json`
- Smoke prose: sane (nervous Anton, Tanya at desk, impatient Dana). 5/5 clean,
  mean turn 24 s, 12 calls (2.4/turn), 0 fallback/liveness/budget. Go for full run.

## Gate metrics (acceptance run)

| Metric | Target | Actual | Verdict |
|---|---|---|---|
| p50 turn time | — | 24.6 s (interp 24.8 s) | info |
| p90 turn time | < 30 s | **37.4 s** (nearest-rank 37.4 s) | **FAIL** |
| `turn_time_exceeded` turns | 0, else written explanation | **8 / 20** (see below) | FAIL (explained) |
| Clean-turn rate (telemetry) | > 80% | 20 / 20 (100%) | PASS |
| Strict-clean rate (attempt-1 `render_accepted`, no fallback, no liveness) | > 80% | **15 / 20 (75%)** | **MISS** |
| Attempt-1 narrate rate | — | 15 / 20 (75%) | info |
| Mean LLM calls / turn | ≈ 2.0 | 2.3 (45 calls) | ok (retries explain +0.3) |
| `parser_fallback` rate | ≈ 0 | 0 (20/20 `parser_completed`) | PASS |
| `budget_exceeded` count | 0 | 0 | PASS |
| Liveness-floor turns | 0 | 0 | PASS |
| Director fired? | note | **No** — `directorEvents` absent in scenario, director off by design (0 `director_event_injected`) | as designed |

Percentiles computed in code from the 20 `turn_telemetry.totalMs` values
(exact s: 10.7, 15.8, 17.2, 17.4, 18.5, 19.8, 22.5, 22.8, 23.5, 24.6, 24.9,
26.9, 28.8, 29.3, 29.4, 30.1, 30.2, 37.4, 38.1, 42.0).

## `turn_time_exceeded` explanations (8 turns, budget 30 s, never aborts)

Root pattern: qwen3:14b calls land 10–20 s each (proposal mean 14 s, render
mean 12 s). Any turn with a render retry (2 render calls) or one slow stage
crosses 30 s. Per-turn wall (`turnWallMs`):

1. Turn 1 / tick 0 (32.3 s): render retry — validator rejected 1st narrate
   (`observer_as_subject`: Dana cast as subject on Anton's turn). 16 s
   proposal + 13.3 s render stage.
2. Turn 4 / tick 3 (40.9 s): render retry + slow 27 s render stage.
3. Turn 10 / tick 9 (32.7 s): no retry; slow proposal (~14 s) + render (~15 s).
4. Turn 12 / tick 11 (45.0 s, slowest): render retry, 17 s proposal + 25 s render.
5. Turn 13 / tick 12 (31.9 s): render retry — 1st narrate rejected
   (`movement.narrated_without_move`: Anton "near the cluster of empty desks"
   with no executed move). Accepted 2nd narrate despite violations (see below).
6. Turn 16 / tick 15 (33.0 s): no retry; 17 s proposal + 13 s render.
7. Turn 18 / tick 17 (33.2 s): no retry; 20 s proposal (run max) + 10 s render.
8. Turn 20 / tick 19 (40.4 s): render retry + 25 s render stage; accepted prose
   still off-genre (see prose notes).

## Narrate-retry detail (strict-clean 15/20)

- Accepted on 2nd attempt (3): ticks 3, 11, 19 (`render_failed` × 1 then `render_accepted`).
- Accepted despite violations (2): ticks 0, 12 — retry budget spent, validator
  logged `narrate_accepted_despite_violations` (honest, never rewritten).
  Telemetry still counts these `clean` (no fallback/liveness), hence 20/20 vs 15/20.
- Typical validator catches were real prose bugs (wrong-subject, movement
  without move) — the retry loop earned its keep on ticks 3/11/19.

## Prose notes (quality, outside the gates)

- Turn 20 (Tanya): genre break — "The figure slinks through the alley … hand
  tightening around the knife at their belt." Assassin-noir narrate for a QA
  engineer in a daylight office. Worst single prose failure of the run; outcome
  still `clean`, so gates don't catch this class. Follow-up: genre/character
  consistency check in the validator.
- Turn 4 (Anton): "lights a cigarette … exhaling smoke into the dimly lit
  room" — contradicts office setting (daylight windows).
- Turn 19 (Anton): introduces himself to Tanya ("I'm Anton, new here on Tanya's
  referral") — addresses the wrong person; he means Dana.
- Dana turns are repetitive (6 near-identical laptop/keyboard-tightening beats);
  Anton freezes for 4 late turns. Second-half staleness with no director to
  break it — expected: scenario defines no `directorEvents`, so the director is
  off. That's v2 working as designed, not noise.

## Generated table (`npm run report:turns -- logs/text_mv1nmk4g.jsonl`, pasted, not hand-computed)

## Summary

| Metric | Value |
|---|---|
| Turns with telemetry | 20 |
| Total wall time | 8m 30s |
| Mean turn time | 25s |
| Total provider calls | 45 (mean 2.3 / turn) |
| Clean turns | 20 / 20 |
| Liveness-floor turns | 0 |
| Fallback turns | 0 |
| Turns over call budget | 0 |

## Per-turn economics

| Turn | Tick | Actor | Wall | Calls (P/S/R) | Outcome |
|---|---|---|---|---|---|
| 1 | 0 | anton | 29s | 3 (1/0/2) | clean |
| 2 | 1 | tanya | 17s | 2 (1/0/1) | clean |
| 3 | 2 | dana | 24s | 2 (1/0/1) | clean |
| 4 | 3 | anton | 38s | 3 (1/0/2) | clean |
| 5 | 4 | tanya | 23s | 2 (1/0/1) | clean |
| 6 | 5 | dana | 25s | 2 (1/0/1) | clean |
| 7 | 6 | anton | 18s | 2 (1/0/1) | clean |
| 8 | 7 | tanya | 25s | 2 (1/0/1) | clean |
| 9 | 8 | dana | 20s | 2 (1/0/1) | clean |
| 10 | 9 | anton | 29s | 2 (1/0/1) | clean |
| 11 | 10 | tanya | 17s | 2 (1/0/1) | clean |
| 12 | 11 | dana | 42s | 3 (1/0/2) | clean |
| 13 | 12 | anton | 29s | 3 (1/0/2) | clean |
| 14 | 13 | tanya | 16s | 2 (1/0/1) | clean |
| 15 | 14 | dana | 23s | 2 (1/0/1) | clean |
| 16 | 15 | anton | 30s | 2 (1/0/1) | clean |
| 17 | 16 | tanya | 27s | 2 (1/0/1) | clean |
| 18 | 17 | dana | 30s | 2 (1/0/1) | clean |
| 19 | 18 | anton | 11s | 2 (1/0/1) | clean |
| 20 | 19 | tanya | 37s | 3 (1/0/2) | clean |

## Per-stage latency

| Stage | n | mean | median | max | total |
|---|---|---|---|---|---|
| proposal | 20 | 14s | 13s | 20s | 4m 31s |
| selection+execute | 20 | 0s | 0s | 0s | 0s |
| render | 20 | 12s | 11s | 27s | 3m 58s |

## Bottom line

All-local 14B completes 20/20 turns with zero fallbacks, zero liveness, zero
budget breaches and a working Laya parser (20/20) — but the p90 < 30 s gate
fails (37.4 s; 8/20 turns over budget) because single qwen3:14b calls take
10–20 s and any render retry pushes the turn over. Strict-clean 75% misses the
80% target for the same retry reason. Suggested next steps: (a) re-run against
the tuned `npc-qwen3-14b` variant / `OLLAMA_NUM_PARALLEL=1` server to test the
latency hypothesis; (b) validator genre-consistency check for turn-20-class
hallucinations; (c) 8B run (`qwen3:8b` pull + same protocol) for the
speed/quality trade-off.
