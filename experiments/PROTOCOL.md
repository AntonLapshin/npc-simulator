# Experiment protocol (phase-gate)

From `PLAN.md` §5, formalized. Follow it verbatim for every experiment
run — it exists because exp-7 burned 73 minutes to learn what 3 turns
would have shown.

## The gate (in order — no skipping)

- [ ] **1. Preflight — `npm run diagnose:ai`.** 100% GPU offload or stop.
      The exp-7 failure was a VRAM squatter (`laya-serve` on 5.8 GB);
      the diagnose script checks for contention. Do not start a run on a
      contested GPU.
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
      show zero `budget_exceeded` turns. Any turn over the 90 s turn-time
      gate gets a written explanation, not a shrug.

## Phase-gate discipline (from PLAN_PHASES.md ordering notes)

- Each phase has acceptance criteria. If a criterion fails, the phase is
  **re-scoped, not force-merged**. A phase that can't meet its bar is
  information — it means the assumption underneath it was wrong, which is
  exactly what phase-gating is for.
- Move exactly one responsibility from the model to the engine per phase.
  Never two — that's how we got 11 rounds of tangled fixes.
- No 20-turn runs before a 5-turn smoke passes clean.
- Judge mechanics on the 3B model, prose on the 14B. Never the reverse.

## What "clean" means (post-renderer-architecture)

- Turn = proposal → selection → execute (engine) → render (LLM).
- Consequence is 1 render call, occasionally 2 for prose issues.
- Typical calls/turn: **1–2** (cascade + 1 render), 3–4 on the
  LLM-decision fallback path. Anything above the budget is a bug or a
  phase-gate failure, not background noise.
