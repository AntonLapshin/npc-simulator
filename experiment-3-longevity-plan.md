# Experiment 3 §6 — Longevity Plan: Can this loop sustain a long conversation?

Source: `experiment-3.md` §6 "High-level reasoning: is this simulation setup the right approach, and could it sustain a long conversation?"

Verdict from §6: **Yes, conditionally.** Architecture is sound (`propose → select → adjudicate → validate → log`), proposal quality already drives the arc, physics backstop works. What kills long runs is not prose quality but grounding: judge-poisoning, teleport/shuffle movement, all-or-nothing fallback (57% "Nothing changes"), verb-drop loopholes, and append-only memory.

This plan turns the five structural fixes (a–e) into ordered phases with entry/exit criteria.

## Baseline to protect (do not regress)

From §6 "What is right about the setup (keep)":

1. Turn loop + minimal structured state + full JSONL trace — every §3 failure was diagnosable.
2. Subjective proposal/selection vs objective consequence split.
3. Deterministic physics as backstop (bounds, furniture-collision, pathfinding, observer-move, unknown-id, closer-to-target, arrival-radius).
4. Retry-with-feedback + fallback liveness guarantee (21/21 turns advanced, nothing crashed).

Exp-3 baseline metrics to beat:
- 12/21 fallbacks (57%), 0/21 object touches, 0/2 desk-question answers, 0/2 first-task answers.
- Repro ticks: 0/3/9 judge-poisoning; 4-vs-3 speech asymmetry; 8/20 glance-teleports; 12 dropped-handshake pass; 13 observer-subject pass; 3/9 fallback-erases-good; 15 1-cell "progress"; 10/11 object-id guesses.

## Phase 0 — Freeze the contract + repro harness

Goal: make §6 testable before changing behavior.

Tasks:
- [ ] Add golden repro set from §3 ticks: 0, 3, 4, 8, 9, 12, 13, 15, 20 (action text + world positions + expected valid/invalid).
- [ ] Log judge-vs-effects disagreement rate per session (Exp-3 §5 item 8c) — currently silent fail-open.
- [ ] Define long-run SLOs: fallback rate, object-touch rate, question-answer rate, mean displacement per locomotion turn, memory bytes per turn.

Exit: `npm run test` passes with new repro fixtures failing for the right reasons; disagreement metric visible in logs.

Touches: `src/engine/*`, `src/logging/*`, `tests/`.

## Phase 1 — Deterministic grounding (fix §6 point 1 / §5 item 1+8)

Problem: judge (same 8B) invents quotes ("Good to see you again, Jeff") and destinations (`destinationActorId: jeff/tanya`) via merged-OR; validator then enforces hallucinations. Ticks 0, 3, 6, 9, 14, 16, 17, 20.

Tasks:
- [ ] Extract `quotedSpeech` ground truth from **action text** with existing quote parser; judge/effects quotes count only if substring of action text.
- [ ] Resolve destinations against roster/landmark table (regex + lookup, no LLM); never accept free-generated actor/object ids as requirements.
- [ ] Split judge roles: (a) deterministic judge for quotes/destinations, (b) LLM only for `moves/speaks/contact`.
- [ ] Add `judge_vs_effects_disagreement` log event per turn.

Exit: ticks 0/3/9 no longer fail on invented quotes; `jeff` as destination never becomes a hard requirement; disagreement rate measurable.

Touches: `src/engine/actionSemantics.ts`, `src/llm/llmSemanticJudge.ts`, `src/engine/physicalValidator.ts`.

## Phase 2 — Movement with speed + progress semantics (fix §6 point 2 / §5 items 3+4)

Problem: strictly-closer + no cap lets glance teleport 13 cells (tick 20) and cross-office walk "succeed" with 1-cell shuffle (tick 15). Perception verbs (`look/glance up`, `ask`, `sip`, `review`, `prepare`, `type`) classified as locomotion (ticks 2, 8, 11, 14, 17).

Tasks:
- [ ] Locomotion = explicit displacement verbs only (`walk/go/head/move/approach/return to <place>`). Extend `maskResumedActivity` → `maskNonLocomotion` allowlist; `moves` requires destination-or-displacement token.
- [ ] Per-turn displacement cap, e.g. ~6 cells (half perception radius) + existing arrival-radius.
- [ ] Named-landmark progress rule: if target >8 cells away, require halving distance (not 0.8 cells); forbid claiming a *different* landmark's desk ("Tanya's desk" for "my desk").
- [ ] Keep deterministic repair (tick 1's (8,7)→(15,2) walk is the best movement of the run) but clamp it by the same cap.

Exit: ticks 8/20 glance-teleports fail or stay in place; tick 15 shuffle fails; escort-to-desk / go-fetch-coffee become 2–3-turn arcs.

Touches: `src/engine/actionSemantics.ts`, `src/engine/movementAssist.ts`, `src/engine/geometry.ts`, `src/engine/pathfinding.ts`, `src/engine/physicalValidator.ts`.

## Phase 3 — Action-side verb gates (fix §6 point 5 / §5 item 2)

Problem: object/contact/pose gates read only the *narrative*, so consequence dodges by omission: no "pour" → no object check (tick 9), no "handshake" → no contact check (tick 12), "stands" for "sit" → no pose check (tick 15). Also speech gate asymmetry: over-strict on paraphrase (tick 3 "asks for directions" fails) but under-strict on verb-drop (ticks 4, 12, 15, 18 pass).

Tasks:
- [ ] Split speech gate: lenient paraphrase bar for *how* speech is rendered + strict action-side verb coverage.
- [ ] Action says X → patch X or fail: `contact` → adjacency + mention; `sit/stand` → pose; `pour/pick up/hold/open/boot` → object/prop; `ask` → question mark or quoted question preserved.
- [ ] Observer-as-subject prose check (tick 13): fail narratives whose grammatical subject is a roster observer ("Anton <verb>…" on Tanya's turn). Complement to observer-move rule.
- [ ] Fuzzy object-ID repair (ticks 10, 11): on unknown id, suggest 3 closest roster ids by edit distance (`coffee mug` → `anton_mug|dana_mug|…`; `paper` → `dana_papers|…`) in retry feedback.

Exit: ticks 12/15/18 verb-drops fail; tick 3 paraphrase passes; tick 13 observer-subject fails; ticks 10/11 retry can succeed.

Touches: `src/engine/physicalValidator.ts`, `src/llm/prompts.ts`, `src/llm/llmConsequenceEngine.ts`.

## Phase 4 — Partial-apply fallback (fix §6 point 3 / §5 item 6)

Problem: 57% "Nothing changes" is the actual scenario-killer. Ticks 3 and 9 had correct movement discarded whole for a speech nit + stray patch. No salvage path; history fills with null events.

Tasks:
- [ ] When movement+destination valid but quote nit / stray observer thought fails: keep valid patches (or movement-repair them), retry only prose.
- [ ] Or: apply movement + thoughts, log speech miss as warning instead of failing the turn.
- [ ] Track salvaged-turn rate separately from clean-pass and full-fallback rates.
- [ ] Keep liveness guarantee from `src/engine/turnOrchestrator.ts` (never deadlock) — degrade gracefully, don't hope for perfect turns.

Exit: ticks 3/9 become degraded-but-advancing instead of full fallback; fallback rate drops without weakening physics gates; history stops filling with null events.

Touches: `src/engine/turnOrchestrator.ts`, `src/engine/patchApplier.ts`, `src/engine/worldStore.ts`, `src/intelligence/consequenceEngine.ts`.

## Phase 5 — Compounding memory + context budget (fix §6 point 4 / §5 items 12+13)

Problem: appends without consolidation drift (Tanya stranger-frames Anton at 0/6/15; Dana re-asks fit at 14/17/20; recruiter codes at tick 20). Full world JSON in every consequence call grows linearly; 4 LLM calls/NPC turn ≈ 15 min/21 turns — a 200-turn run is infeasible as-is.

Tasks (implemented — see `tests/unit/phase5.test.ts`):
- [x] Rolling summarization per actor: relationship state, open questions, current project. Summarize, don't just trim.
- [x] Per-actor refresh line in Tanya/Dana subjective contexts only: "Anton: hired backend dev, ex-Sixt with Tanya (referred by her) — never stranger/candidate." (Exp-2 item 13, still open.)
- [x] Shrink consequence payload: slim objective snapshot (nearby actors/objects + targets) instead of full world; move rarely-firing rules (arrival radius, mask lists) into retry feedback only; trim ~150-line consequence prompt for small models.
- [x] Ship exact ID list into every consequence call (mugs/papers/desks + "never write 'coffee mug'").
- [x] Add quoted-speech copy rule + contact/pose/prop one-liners (§5 items 10–11) as part of the trimmed prompt.

Exit: stranger/candidate frames gone over 20+ turns; open questions ("where is my desk?", "first task?") persist until answered; per-turn tokens flat, not linear; 200-turn run time-bounded.

Touches: `src/engine/contextBuilder.ts`, `src/llm/prompts.ts`, `src/engine/worldStore.ts` (trim/summarize), `src/config.ts` (limits).

## Phase 6 — Long-run validation (prove §6 conditional)

Goal: answer "could it sustain a long conversation?" with data, on a large model, after Phases 1–5.

Tasks:
- [ ] Re-run Exp-3 protocol (same 7 adaptive user turns, `office-anton.json`) on large model; compare fallback / object-touch / answer rates vs baseline.
- [ ] New 50–200-turn soak: escort-to-desk arc, coffee-fetch arc, first-task arc must complete at least once each; zero teleports >cap; zero "Nothing changes" streaks >3.
- [ ] Publish judge-disagreement rate, salvaged-turn rate, memory-growth curve alongside prose quality notes.

Exit: ship/no-ship decision on scaling the model; remaining failures filed as new ticks with the same traceability §6 praises.

Touches: `scenarios/office-anton.json`, `logs/`, `scripts/`, experiment-4 write-up.

## Ordering + dependencies

```
Phase 0 (harness)
  → Phase 1 (grounding) ─┐
  → Phase 2 (movement) ───┼→ Phase 4 (partial-apply) → Phase 6 (soak)
  → Phase 3 (verb gates) ┘
  → Phase 5 (memory/budget) ──────────────────────→ Phase 6 (soak)
```

- Phase 1 first: removes judge-poisoning noise so Phases 2–4 measure real gates.
- Phases 2+3 in either order, both before Phase 4 (salvage must know what "valid movement" means).
- Phase 5 parallelizable anytime after Phase 0; required before any 200-turn soak.
- Model scale-up only after Phase 6 entry criteria met — per §6, a bigger model alone fixes Jeffs and prose, not stalls.
