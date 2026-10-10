# Experiment protocol (phase-gate) — PLAN_V2

From `PLAN.md` §5, formalized, rewritten for the v2 turn loop. Follow it
verbatim for every experiment run — it exists because exp-7 burned 73
minutes to learn what 3 turns would have shown.

## The gate (in order — no skipping)

- [ ] **1. Preflight — `npm run diagnose:ai`.** 100% GPU offload or stop.
      The exp-7 failure was a VRAM squatter (`laya-serve` on 5.8 GB);
      the diagnose script checks for contention. Do not start a run on a
      contested GPU. Laya must be reachable too (`laya-serve` up) —
      otherwise every turn logs `parser_fallback` and you are measuring
      the deterministic-parsing path, not the parse path.
- [ ] **2. 5-turn smoke on the 3B model.** `--auto --limit-turns 5`.
      Mechanics must be clean. Mechanics are model-independent — prove
      them on the cheap model first.
- [ ] **3. 5-turn smoke on qwen3:14b.** Prose must be sane.
- [ ] **4. Only then: the 20-turn run**, with `--auto`'s per-turn table
      and ETA as the judge.
- [ ] **5. Every run gets:** the run's log (`logs/`), its saves
      (`saves/`), and a findings table **generated** by
      `npm run report:turns -- logs/<session>.jsonl` — never hand-computed
      (hand-computed tables are how the tick off-by-one survived into the
      exp-7 report's first draft).
- [ ] **6. Budgets:** `turnCallBudget` (default 4) — the run's report must
      show zero `budget_exceeded` turns. `TURN_TIME_BUDGET_MS` (default
      30000, Anton's hard line): any turn over 30 s logs
      `turn_time_exceeded` and gets a written explanation, not a shrug.

## Phase-gate discipline

- Each phase has acceptance criteria. If a criterion fails, the phase is
  **re-scoped, not force-merged**. A phase that can't meet its bar is
  information — it means the assumption underneath it was wrong, which is
  exactly what phase-gating is for.
- Move exactly one responsibility from the model to the engine per phase.
  Never two — that's how we got 11 rounds of tangled fixes.
- No 20-turn runs before a 5-turn smoke passes clean.
- Judge mechanics on the 3B model, prose on the 14B. Never the reverse.

## What "clean" means (v2 turn loop)

- Turn = **intent** (1 LLM call) → **parse** (1 local Laya decide) →
  **execute/clamp** (engine, 0 calls) → **narrate** (1 LLM call) →
  director injection when staleness fires.
- Typical cost: **exactly 2 LLM calls + 1 Laya decide** per NPC turn
  (1 + 1 on user turns — intent is skipped). Anything above is a bug or
  a phase-gate failure, not background noise. The scripted proxy
  (`tests/integration/v2TurnCost.test.ts`) asserts this shape; live runs
  confirm it via the `turn_telemetry` events.
- A clean turn: `render_accepted` on attempt 1, no `clamp_applied`
  surprises, no `parser_fallback`, no `fallback_used`, no
  `liveness_applied`, and no `turn_time_exceeded`.

## Anton's acceptance step: live 20-turn v2 run

PLAN_V2 is cut over — there is no v1 path left to A/B against in the
code. The acceptance run is therefore a **v2 live run measured against
the v2 budget**, with the historical v1 numbers (Stage-3 report:
~59 s mean turn, 40% fallback) as the comparison baseline:

- [ ] **20 turns on qwen3:14b**, `--auto`, office-anton scenario.
- [ ] **p90 turn time < 30 s** (hard line). p50 is informative; p90 is
      the gate.
- [ ] **Clean-turn rate** (attempt-1 `render_accepted`, no fallback, no
      liveness): target > 80% — the PLAN.md bar the renderer
      architecture was built to clear.
- [ ] **Attempt-1 narrate rate**: narrate accepted on the first attempt
      (no `render_failed`) — measures whether the executed-facts prompt
      is sufficient, without the retry crutch.
- [ ] **Cost check**: mean LLM calls/turn ≈ 2.0 (intent + narrate),
      `parser_fallback` rate near 0 (Laya up), zero `budget_exceeded`.
- [ ] Report via `npm run report:turns`; the findings table is
      generated, never hand-written. If p90 ≥ 30 s or clean-turn rate
      < 80%, the run is a re-scope signal, not a merge signal.

## Retired: Stage-3 cascade-vs-LLM --compare

Stage 3 (2026-10-09) returned NO DECISION on the cascade-vs-LLM
comparison, and Phase 6 deleted the cascade outright (see
ARCHITECTURE.md "Decision layer"). The `--compare` mode of
`scripts/eval-run-quality.ts` remains for historical log analysis, with
the Stage-3 lesson encoded: failed attempts carrying `usage` payloads
count in the per-turn call tallies (`failedDecisionCalls`) —
`tests/unit/evalCompare.test.ts`.
