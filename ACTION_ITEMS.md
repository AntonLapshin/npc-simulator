# Action items

Next steps for the npc-simulator, from the v2 live runs (2026-10-09/10:
baseline 14B, tuned 14B = Experiment B, 8B stheno = Experiment C).
Status as of 2026-10-10. Check off as they land; move to "Done" with the
run/commit that closed them.

## Code

### A1 — Scrub grid-speak from the narrate facts (engine-side)
**Why:** 11/24 narratives in the 8B run leak coordinates (`moved from
(13,13) to (12,13)`, `stands at (11, 5)`, `moved 6 cells toward Tanya`).
The executed-facts block feeds raw grid data and weak models echo it
verbatim. The 14B does it rarely (2 instances) — same bug, less often.
**What:** translate movement/position facts to qualitative language in the
narrate prompt builder (`buildNarrateContext`): distances → "a few steps /
halfway across the room / near the window", never raw `(x, y)` or
`N cells`. The engine keeps exact coordinates; the narrator never sees
them.
**Verify:** golden test — fact blocks with coordinates → prompt contains
no `\(\d+,\s*\d+\)` and no `\d+ cells`; full suite green.

### A2 — Genre/character consistency (thin-fact turns)
**Why:** 4+ genre breaks across runs (assassin-noir Tanya, battlefield,
thief/cellar, candlelight rogue) — all `render_accepted` attempt 1. The
validator is blind to them by construction (no physical claim to
contradict). Systematic trigger: thin-fact turns + "narrate vividly".
**What:** prototype the cheap fix first — a thin-fact brevity rule in the
narrate prompt ("when the facts are thin, write one plain sentence;
never reach for genre"). Measure break rate on a 20-turn run. If breaks
persist, add a Laya check question on the finished paragraph
("does this describe <actor> doing something plausible in <scenario>?").
**Verify:** 0 genre breaks across a 20-turn 14B run; suite green.

### A3 — JSON double-wrap repair in the parse-retry path
**Why:** Experiment B's only fallback turn: the narrator emitted
`{\n\n"{...}"` (JSON wrapped in a JSON string) five times straight →
"aborted: identical parse error repeated 3 times" → 61 s dead turn. A
targeted repair (strip the outer wrapper when the inner parses) would
have saved it outright.
**What:** in the consequence JSON repair path, detect leading
`{\s*"` + trailing `"` wrapping a parseable inner object and unwrap it
before schema validation.
**Verify:** unit test with the exact tick-3 payloads from
`logs/text_mv1p0g7j.jsonl`; suite green.

### A4 — Reject mid-word-truncated intent quotes
**Why:** same turn's intent carried `"quote": "Hey, T"` — truncated
mid-word. A broken quote poisons the narrate prompt (exactQuote vs
action text disagree).
**What:** intent schema validation rejects quotes ending mid-word
(no closing quote + trailing partial token vs the action text); triggers
the existing single intent retry.
**Verify:** unit test — truncated quote → retry; suite green.

## Experiments (GPU machine)

### D — Director events run (untested half of v2)
**Why:** every run so far idles in the second half (Dana ×5 identical
laptop beats, Anton frozen) because no scenario defines `directorEvents`.
The trigger logic is tested; the live behavior isn't.
**What:** add 2–3 `directorEvents` (+ optional `directorStalenessThreshold`)
to `scenarios/office-anton.json`, then a 20-turn tuned-14B run per
`experiments/PROTOCOL.md`. Expect: staleness breaks after K quiet turns,
each incident fires exactly once, `director_event_injected` in the log.
Keep this run separate from B/C comparisons (one variable at a time).

### E — 8B re-run after A1
**Why:** re-test whether the coordinate scrub fixes the gamey edge or the
flatness runs deeper. Same protocol, `OLLAMA_MODEL=npc-stheno-8b`
(or `qwen3:8b` + `LLM_THINK=0` if pulled — 9 GB).
**Verify:** coordinate-leak rate near 0; clean-turn rate vs the first 8B run.

## Low value / blocked

- **Tuned-variant A/B** (stock `qwen3:14b` vs `npc-qwen3-14b`, controlled):
  Experiment B measured the variant as a no-op (baseline already 100%
  GPU). Run only if curious about noise vs a small `num_batch` regression.
- **Sudo-gated tuning** (`OLLAMA_NUM_PARALLEL=1`, `OLLAMA_FLASH_ATTENTION=1`
  on the daemon): untestable without sudo; expected value lowered after the
  think falsification — per-call cost is prompt ingest + generation, and
  the daemon already runs 100% GPU.
- **Think flag**: falsified 2026-10-09 (`probe:think` no difference;
  `.env` backfills `LLM_THINK=0`). Do not spend runs re-testing it.

## Open design questions (from PLAN_V2, still open)

- **1-call vs 2-call narration:** Phase 4 could experiment with a single
  call returning `{action, quote, narrative}` before execution, validator
  catching lies, one retry. Halves narration cost; risks lower attempt-1
  rates. Cheap to try once A1/A2 land.
- **Rolling memory summarization for 100+ turns:** state builders budget
  characters today; long runs need distant-history summarization. Out of
  scope until someone runs 100+ turns.

## Done

- [x] PLAN_V2 Phases 1–6 (PRs #18–#23): intent call, Laya-as-parser, clamp
      policy, narrate executed facts, director, cutover + cleanup.
- [x] v2 14B acceptance run (2026-10-09): 20/20 clean, 0 fallback —
      significant improvement over v1 (59 s → 25.5 s mean, 40% → 0%
      fallback). p90 37.4 s missed the 30 s line; cause is per-call
      latency, not loop design.
- [x] Think falsification (2026-10-09): not the lever.
- [x] 8B viability run (2026-10-09): 20/20 clean at ~1.6 s/turn —
      the loop works on small models; prose needs A1/A2.
- [x] `(not done)` sentinel confirmed dead in output (0 narratives, B+C runs).
