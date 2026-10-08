# Experiment 7 — office-anton.json, autonomous, local qwen3:14b (think off)

Date: 2026-10-08. Goal: watch the scenario unfold with the default local
setup, judge whether NPC actions are reasonable/logical, observe physical
world mutation, and measure per-turn duration + LLM calls per turn.

## 1. Setup & method

- Command: `npx tsx src/ui/text/textUi.ts scenarios/office-anton.json
  --provider ollama --model qwen3:14b --auto --limit-turns 20` (text mode,
  autonomous: all 3 characters are NPCs, `forceAllNpc`).
- Engine label at startup: `hard=ollama/qwen3:14b simple=ollama/qwen3:14b`
  (the `--provider` flag pins `LLM_BACKEND=ollama`, so both tiers resolve
  to the same model; `user_capable_tier_noop` logged as expected).
- `.env` defaults otherwise: `LLM_THINK=0` (no reasoning), `LLM_TIMEOUT_MS=120000`,
  per-task budgets 1500/800/1500/500, `LLM_JSON_MODE=1`, `LAYA_MODE=off`
  (chat path; Laya decision layer disabled).
- Laya server **was** running (`laya-serve` on :8000, healthy) — see §6 P1.
- **Planned 20 turns, stopped after 12** (operator decision: the pattern was
  stable and each turn costs ~6 min; 12 turns = 73 min wall). All numbers
  below cover ticks 0–11 (Anton→Tanya→Dana × 4).
- Artifacts: `logs/text_mv01ju0p.jsonl` (498 records), `saves/office_tick1..12.json`,
  console transcript in `/tmp/exp7_run.log`.

## 2. Headline results

| Metric | Value |
|---|---|
| Turns completed | 12 / 20 (ticks 0–11) |
| Total wall time | 4387 s = **73.1 min** |
| Mean turn time | **366 s (6.1 min)**; range 211–610 s |
| Total LLM calls | **94** (mean **7.8 / turn**) |
| Clean turns (applied, no caveat) | **1 / 12** (tick 9) |
| Turns with `(not done)` fallback | 6 / 12 |
| Turns with `(partial)` honesty note | 4 / 12 (+1 liveness-floor turn) |
| `validation_passed` events, whole run | **1** |
| Total tokens (OpenAI `usage` blocks) | 245 605 (181 880 prompt / 63 725 completion) |

Per-turn wall time and LLM-call counts (terminals = completed + failed):

| Tick | Actor | Wall | LLM calls (P/S/C/J) | Outcome |
|---|---|---|---|---|
| 0 | anton | 344 s | 7 (1/1/5/0) | partial (invented dialogue) |
| 1 | tanya | 211 s | 6 (1/1/4/0) | fallback `(not done)` |
| 2 | dana | 610 s | 11 (1/2/8/0) | fallback `(not done)` |
| 3 | anton | 449 s | 9 (1/1/6/1) | partial (quote reinserted) |
| 4 | tanya | 421 s | 10 (2/1/7/0) | fallback `(not done)` |
| 5 | dana | 245 s | 6 (1/1/4/0) | fallback `(not done)` |
| 6 | anton | 342 s | 6 (2/1/3/0) | fallback `(not done)` |
| 7 | tanya | 468 s | 9 (1/1/7/0) | fallback `(not done)` |
| 8 | dana | 257 s | 5 (1/1/3/0) | partial (invented dialogue) |
| 9 | anton | 374 s | 11 (1/1/7/2) | **clean** |
| 10 | tanya | 310 s | 6 (1/1/4/0) | liveness floor |
| 11 | dana | 356 s | 7 (1/1/5/0) | partial (invented dialogue) |

Completed-call latency (authoritative `durationMs` on `*_completed`):

| Engine | n | mean | median | max | total |
|---|---|---|---|---|---|
| proposal | 12 | 68 s | 56 s | 143 s | 815 s |
| selection | 12 | 33 s | 29 s | 67 s | 400 s |
| consequence | 39 | 75 s | 61 s | 218 s | 2918 s |
| semantic | 2 | 28 s | 28 s | 34 s | 56 s |

Failed LLM calls: **28** — 12× consequence schema-mismatch, 11×
`empty response (finish_reason=length)` (10 consequence + 1 selection;
i.e. truncated at max_tokens), 2× identical-parse-repeat abort, 1× proposal
identity-leak, 1× proposal empty, 1× semantic schema-mismatch.
15 slow-call warnings (`*_slow_call`, >50% of timeout): 12 consequence + 3 proposal.

### Where the time went (§6 detail)

Wall ≈ 100% LLM-bound (per-turn wall == sum of completed-call durations to
within rounding; engine/validator/persistence overhead is negligible):

- **Consequence ≈ 70%** of LLM time (39 completed calls + the bulk of the 28
  failures; up to 8 consequence terminals in a single turn, tick 2).
- **Proposal ≈ 19%** (1 call/turn, but slow: median 56 s, max 143 s).
- **Selection ≈ 9%** (1 call/turn, median 29 s — cheapest stage).
- **Semantic judge ≈ 1%** — lazy by design: ran only 3× in 12 turns
  (effects present ⇒ skipped; the Exp-6 optimization holds).
- Retries, not first attempts, dominate: the average turn burns ~5.8
  consequence terminals to produce one applied-or-salvaged result.

## 3. How the scenario unfolded (narrative arc)

0. **Anton** greets the room: *"Morning, everyone — first day, be gentle."*
   (partial — the line was invented by consequence, not in the action text.)
1. **Tanya** tries to stand up and walk to Anton's desk to greet him → `(not done)`.
2. **Dana** stares at his monitor, half-listening → `(not done)` after 4 failed
   consequence attempts (10 min turn, worst of the run).
3. **Anton** approaches Tanya's desk: *"Hey Tanya, thanks for the referral…"*
   (partial — quotes had to be deterministically reinserted).
4. **Tanya** checks her laptop, tries to stride to Anton → `(not done)`.
5. **Dana** types furiously on his laptop → `(not done)`.
6. **Anton** approaches Tanya's desk again → `(not done)`.
7. **Tanya** pauses her test plan, tries to approach Anton → `(not done)`.
8. **Dana**: *"I need to start working on the report."* (partial, invented dialogue).
9. **Anton** walks toward the coffee machine — the run's only clean turn.
10. **Tanya** holds position (liveness floor after her approach-intent was banned).
11. **Dana** to Anton: *"I need help with this task, Anton."* (partial, invented).

Story verdict: a static tableau with dialogue intentions. The social plot
(first-day greeting → referral thanks → coffee break) is *appropriate*, but
11 of 12 turns are visibly degraded (`(not done)` / `(partial)` caveats leak
into the story text), and the same two approach-intentions repeat for 8
turns without physical progress.

## 4. Are NPC actions reasonable and logical?

The **proposal/selection layer is mostly sensible** (walk to the newcomer,
say thanks for the referral, keep screening, get coffee — all in-character).
What fails is **consequence execution + grounding**:

- **B1 — Invented dialogue (systematic).** 32 `speech.invented_dialogue`
  violations. Consequence puts quoted speech into narratives whose action
  text contains none (ticks 0, 8, 11; Dana tick 2 attempts). The model seems
  unable to render "says X" actions without improvising lines.
- **B2 — Prior-turn echo (perseveration).** 19 `observer_as_subject`
  violations. Anton's tick-0 greeting recurs *verbatim* as Tanya's (tick 1,
  attempts 2–3) and Dana's (ticks 2 and 5, attempts 2–4) narrative — up to
  3 identical retries in one turn; retry feedback does not steer it away.
- **B3 — Movement never materializes.** All 6 multi-step "approach X"
  actions end `(not done)` (`movement.no_position_change` ×24,
  `acting_actor_not_patched` ×11). The model narrates walks but emits no
  `x/y` patch (or moves the *wrong* actor — B6). Only a bare
  "walks toward the coffee machine" (tick 9) succeeded.
- **B4 — Genre break.** Dana tick 2, attempt 1: *"The figure slinks through
  the alley … fingers twitching near the knife at their belt"* for a
  "stare at monitor" action, plus `moved=true` with no patch.
- **B5 — Misgendering.** Dana (he/him in scenario + persona) is twice
  rendered *"she says" / "sitting at her desk"* (tick 5 attempt 1, tick 8
  narrative). The model defaults to she/her despite explicit cues.
- **B6 — Observer moved, actor frozen.** Dana tick 5 attempt 2 moves **Anton**
  (observer) into a blocked cell (inside `anton_desk`) while Dana stays put.
- **B7 — Fine-motor verbs read as locomotion.** "Typing furiously" / "stare
  blankly" trigger `movement.no_position_change` (semantics says moves=true
  for typing/staring; 40 `judge_vs_effects_disagreement` events). Either the
  judge over-labels or the validator over-demands — stationary work actions
  cannot pass as written.
- **B8 — Mild role reversal.** Dana (busy recruiter) asking newcomer Anton
  *"I need help with this task"* (tick 11) is odd prioritization, though
  socially salvageable as an icebreaker.

What worked: `intent_cluster_banned` + `selection_substituted` fired at tick
10 and broke Tanya's 4-turn approach loop; the identical-error early abort
(`retry_aborted` ×6) and format-collapse salvage kept every turn terminating
— no hangs, no crashes, exit path always honest (`(not done)` / `[partial: …]`).

## 5. Physical world mutation

| Actor | Start | End (tick 12) | Moves |
|---|---|---|---|
| anton | (16,2) stand | (4,10) stand, "at Anton's desk" | 3: →(11,5) t1, →(7,7) t4, →(4,10) t10 |
| tanya | (8,7) sit | (8,7) sit, state string unchanged | 0 |
| dana | (15,11) sit | (15,11) sit, state string unchanged | 0 |

- Tanya's and Dana's `state` strings are **byte-identical** from tick 1–12.
- **Zero object patches** in 12 turns (no description/flag/position change;
  not even `prop` changes for the "grab tea mug and sip" turn).
- Inner life advances thinly: memories +1–2 per actor (deterministic floor),
  beliefs frozen, thoughts update per turn and stay on-script.
- Net: the world is a *tableau with one mobile actor*. The validator
  correctly rejects bad movement, but the consequence model cannot produce
  acceptable movement, so the office never comes alive.

## 6. Issues

### Performance
- **P1 — Default local setup starves its own GPU.** `laya-serve` (python,
  PID 34279) holds **5.8 GB VRAM** while `qwen3:14b` (9.3 GB) needs the same
  16 GB card → Ollama reports **18% GPU / 82% CPU** offload (worse than
  Exp-6's ~50%). ~60–75 s per LLM call, 6.1 min/turn, ~2 h projected for 20
  turns. `.env` says `LAYA_DEVICE=cpu`, but the running server still sits on
  the GPU (and `LAYA_MODE=off` means it contributed nothing to this run).
- **P2 — Retry storms dominate cost.** Consequence terminals/turn: 3–8;
  67% of all LLM calls are consequence; slowest turn (tick 2) took 610 s,
  flirting with the 600 s `turnTimeoutMs`.
- **P3 — Truncation despite think-off.** 11 `finish_reason=length` empties +
  1 `consequence_budget_raised`. Median completion tokens remain huge
  (proposal 877, consequence 728, selection 454) for ~100-token JSON
  payloads — either `think:false` is not fully effective on this Ollama
  build or qwen3 is pathologically verbose (max completion hit 1500).
- **P4 — Proposal is slow for a non-retry stage**: median 56 s, max 143 s
  (3 `proposal_slow_call`) for a suggestion list.

### Behavior / quality (B1–B8 above, folded into action items A4–A8)

### Tooling / hygiene
- **T1 — `npm run diagnose:ai` crashes**: `scripts/diagnose-ai.ts:478` has a
  stray `}` (esbuild TransformError). The offline preflight is unusable.
- **T2 — Internal notes leak into story text.** `(partial) [partial:
  [speech.invented_dialogue] …]` validator jargon and `(not done)` are
  appended to `history` entries, i.e. shown to users *and* fed back into
  future prompts (likely contributor to B2 echo).
- **T3 — Garbage codepoint in output.** `(not done)` lines end with a raw
  U+10FFFF character (`\U0010ffff`) — missing output sanitization.
- **T4 — `turn_completed` is logged with the *next* tick**, which silently
  breaks naive per-turn log analysis (tripped this report's first script).
- **T5 — Save-name collision.** `office-anton.json` (id `office`) saves as
  `saves/office_tickN.json` — indistinguishable from `office.json` runs.

## 7. Action items

| # | Action | Fixes | Priority |
|---|---|---|---|
| A1 | Make the default local setup GPU-safe: honor `LAYA_DEVICE=cpu` in `serve-laya.sh` (verify it actually keeps Laya off VRAM), or document `ollama stop`/laya-CPU discipline; add a VRAM-contention check to `diagnose:ai` (`ollama ps` %GPU + `nvidia-smi` resident processes) | P1 | **P0** |
| A2 | Fix `scripts/diagnose-ai.ts:478` stray `}` so `npm run diagnose:ai` runs | T1 | P0 |
| A3 | A/B-probe `think:false` vs unset on `qwen3:14b` (completion-token histograms); if usage stays ~900, escalate (Ollama version, flag actually sent on the OpenAI endpoint?) | P3 | P1 |
| A4 | Consequence prompt hardening: restate "describe ONLY the acting actor, no invented quotes, emit x/y with every narrated move" with a *negative example* (the tick-0 greeting echo); consider splitting move+speak actions into ordered clauses the model must ground one by one | B1, B2, B3 | P1 |
| A5 | Anti-echo: exclude the immediately-preceding turn's narrative from the consequence prompt's history window (keep older context), and/or add an explicit "never repeat a prior turn's sentence" instruction | B2 | P1 |
| A6 | Inject actor pronouns into proposal/consequence prompts (e.g. `Dana (he/him)`); add a lightweight validator check for third-person pronoun mismatch | B5 | P1 |
| A7 | Split locomotion from manipulation in semantics/validation: typing/sipping/staring must not require `x/y` patches; reserve `no_position_change` for locomotion verbs or explicit destination language | B7 | P1 |
| A8 | Give stationary work actions a clean pass path: accept explicit no-op object interaction (or require the affordance patch the nudge demands) instead of routing everything through `(not done)` salvage | B3, B7 | P2 |
| A9 | Keep validator annotations in log records only; append a *plain-language* caveat (`(not done)` → "…couldn't do that") to history, and stop feeding validator jargon back into prompts | T2, B2 | P1 |
| A10 | Sanitize model/narrative output (strip non-characters such as U+10FFFF, control codes) before history/log writes; add a unit test | T3 | P2 |
| A11 | Reduce truncation: raise `LLM_MAX_TOKENS_CONSEQUENCE` (or lower consequence temperature 0.9→0.7 to curb verbosity) after A3's verdict; keep `consequence_budget_raised` telemetry | P3 | P2 |
| A12 | Fix save naming to include the scenario file stem (`office-anton_tickN.json`) or enforce unique scenario ids | T5 | P2 |
| A13 | Document experiment economics: 14B-class local runs cost ~6 min/turn — iterate on the 3B abliterated model, reserve qwen3:14b for finals; log a per-turn ETA line in `--auto` mode | P2, P4 | P2 |
| A14 | Keep what worked: intent-ban + liveness floor + early-abort + honest `(not done)` notes all fired correctly — add regression coverage for the tick-10 ban/substitute sequence | — | P2 |

## 8. Reproduction

```bash
npx tsx src/ui/text/textUi.ts scenarios/office-anton.json \
  --provider ollama --model qwen3:14b --auto --limit-turns 20
# analysis (repo-root):
python3 /tmp/exp7_analyze.py   # per-turn walls, calls, outcomes
python3 /tmp/exp7_timing2.py   # call-latency distributions, token totals
```

Note: timings above reflect a contended GPU (P1). Re-run after A1 for the
uncontended baseline; expect ~2–3× faster turns at 100% offload.
