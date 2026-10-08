# LAYA Decision Plan — radical utilization of the Laya decision model

Status: PLAN (not implemented). Companion to ARCHITECTURE.md.

## Implementation status (2026-10-07 — updated as phases land; design sections below unchanged)

- **Phase 0 — quality gate:** dataset + probe script shipped
  (`scripts/eval-datasets/laya-eval.json`, `scripts/eval-laya.ts`,
  `scripts/eval-laya.RUNBOOK.md`). **Live gate pending owner run** — needs
  laya-serve with the typed-decisions checkpoint on the owner's machine.
- **Phase 1 — foundation:** shipped. `src/decision/` core module
  (`layaClient`, types, slim states, static selection diagram,
  `LayaSelectionEngine`) behind `LAYA_SELECTION=1`; real decision probe in
  `scripts/diagnose-ai.ts`.
- **Phase 2 — judge:** shipped. `LayaSemanticJudge` (one batched judge-set
  decide per action; quote extraction stays deterministic) behind
  `LAYA_JUDGE=1`.
- **Phase 3 — intent-first + triage:** wiring shipped behind flags
  (default OFF). `runTurn` runs the intent cascade and narrows the proposal
  prompt (`buildNarrowedProposalPrompt`); observer triage and the salience
  gate run as post-hooks before patch application.
- **Phase 4 — dynamic planner + plausibility:** wiring shipped behind flags
  (default OFF). `planDiagram` (cached) replaces `SELECTION_CASCADE` in
  dynamic mode with static fallback on ANY planner failure; plausibility is
  advisory-only (`LAYA_PLAUSIBILITY=1`).
- **Phase 5 — evaluation:** eval script + runbook shipped
  (`scripts/eval-turns.ts`, RUNBOOK below). **Rerun pending owner** — needs
  Ollama (+models) and laya-serve; not runnable in automation.

Until Phase 5 validates end to end, every Laya behavior defaults OFF
(`readLayaRuntimeConfig` in `src/config.ts`): `LAYA_MODE=off` and all
`LAYA_*` toggles at 0, so the chat path is byte-for-byte today's behavior.
Goal: invert the current ratio — today ~4–10 chat-LLM calls per NPC turn and
zero Laya decisions; target 2–3 chat-LLM calls (pure generation) + 5–15 Laya
micro-decisions at ~33ms each. Small local models get dramatically more
reliable because every classification-shaped subtask moves to calibrated
scoring, and the generative tasks left for them become narrow and easy.

## 1. What Laya is (the 30-second version)

- A 421M-param ModernBERT-based **non-autoregressive decision model** (Apache-2.0).
  It does not generate text. You send it a `state` + typed questions and get
  calibrated probabilities back in **one forward pass (~33ms)**:
  - `choice` — pick one of N options, probability per option
  - `noul` — yes/no, calibrated P(true)
  - `score` — expected level on an ordered rubric (e.g. 1–5)
- Served locally by `laya-serve` (`POST /v1/systemone`), already booted by
  `scripts/start.sh` and health-probed by `diagnose-ai.ts` — then never called.
- Hard limits: **512-token state** on the base English checkpoint (1024 on
  `laya-typed-decisions`, 8k on multilingual). Jev-family models are weaker
  past ~20 options per `choice`. The model card is blunt: **zero-shot
  typed-decision accuracy is near-random (0.362 vs 0.318 baseline)** — the good
  numbers need the typed-decisions checkpoint or fine-tuning, and calibration
  needs a per-question-type temperature refit.

## 2. Core idea: decision cascades as state machines

Exactly what you described: call Laya with an option set, take the ranked
winner, call Laya again with the next option set conditioned on it. A
**decision diagram** (a small DAG) *is* the state machine:

```
node intent_kind: choice [speak, move, interact_object, gesture, wait]
  --speak--> node addressee: choice [visible actors..., "nobody in particular"]
  --move--> node destination: choice [landmarks..., actors..., "wander"]
             --winner--> node manner: choice [go directly, wander over, approach]
  --interact_object--> node target_object: choice [nearby objects...]
             --winner--> node interaction: choice [use, take, examine, ...]  (options may be LLM-generated)
```

Rules that keep it sane: max depth 4, max 12 options per `choice`, independent
sibling questions batch into **one** `/v1/systemone` request (the API takes
many questions per call). Every walk is logged node-by-node, so a turn's
decisions are fully replayable.

## 3. The reordered turn pipeline (the radical part)

Today: proposal (wide-open generation) → selection (fuzzy pick) → consequence.
Proposed: **decide the intent first with Laya, then generate narrowly.**

```
1. LAYA intent cascade (~3 batched calls, ~100ms):
   intent_kind → target/addressee/destination → manner
   Output: Intent { kind, targetId?, manner? }
2. PROPOSAL (chat LLM, now NARROW): "suggest 4 things Dana could SAY to Anton
   about the deadline" — a small model is far more reliable at this than at
   open-ended brainstorming. This is the "delegate complexity to the decision
   model" thesis.
3. LAYA candidate choice: pick best proposal candidate vs "none fit"
   → "none fit" or low confidence → chat LLM invents one (escape hatch).
4. CONSEQUENCE (chat LLM, unchanged): narrative + patches + effects.
5. LAYA judge set (ONE batched call): moves?/speaks? (noul), addressee/
   destination/contact (choice over roster/landmarks). Replaces the chat
   SemanticJudge. Quote extraction stays deterministic (Laya can't pull
   verbatim spans).
6. Deterministic validation (unchanged — still the final word).
7. LAYA observer triage: per perceiver, noul "worth an inner reaction?"
   → today EVERY perceiver gets thoughts rewritten EVERY turn (noisy + bloat);
   Laya gates it to meaningful events only.
8. LAYA salience: score 1–5 "how memorable is this?" → gates memory appends,
   replacing the current free-text memory judgment with a calibrated one.
```

Chat LLMs end up doing only what they're good at (writing text); Laya does all
the choosing (what it's good at).

## 4. Dynamic question generation (the "freedom" mechanism)

Static diagrams cover the backbone (selection, judge, triage). For the
long tail, a **QuestionPlanner**: a low-temperature chat-LLM call that
generates the diagram *for this turn* as validated JSON:

```json
{ "nodes": [{ "id": "q1", "type": "choice",
              "instructions": "How does Anton use the coffee machine?",
              "options": ["brew coffee", "clean it", "unplug it", "stare at it"] }],
  "edges": [{ "from": "q1", "when_winner": "brew coffee", "to": "q2" }],
  "terminal": "q2" }
```

- The LLM provides freedom (it invents the decision space); Laya provides
  determinism (it collapses every node). Small models are decent at
  *enumerating* options and terrible at *choosing* — this split plays to both.
- Safety rails (Zod-validated): ≤8 nodes, ≤12 options/node, instructions
  length-capped, options non-empty and distinct. Planner failure or low
  confidence → static diagram. Never a bare chat fallback for a decision node.
- Cost control: diagrams are cached by hash(intent + target + goal) for the
  scenario run; the planner only runs when static-diagram confidence is low
  or every N turns (configurable).

## 5. Exact code touchpoints

New module `src/decision/`:
- `layaClient.ts` — typed `POST /v1/systemone` client (`{state, questions}`
  → answers), timeout + AbortSignal, single-question and batch helpers,
  `LayaUnavailableError` for fallback paths. This *replaces the concept* of
  the chat-mode `LocalLayaProvider` (deprecate it; keep for compat).
- `decisionTypes.ts` — Zod schemas: `LayaQuestion`, `LayaAnswer`,
  `DecisionDiagram`, `DiagramNode`, `Intent`.
- `diagrams.ts` — static diagrams: selection cascade, judge set, observer
  triage, salience.
- `diagramRunner.ts` — DAG walker: conditional edges on winners, batching of
  independent nodes, depth/option caps, per-node logging.
- `questionPlanner.ts` — LLM diagram generator + cache.
- `decisionState.ts` — **slim state builders** (persona + goal + 2–3 recent
  events + roster/landmarks, hard-budgeted to ~400 tokens for the 512 limit).
- `layaSelectionEngine.ts`, `layaSemanticJudge.ts` — implement the existing
  `SelectionEngine` / `SemanticJudge` interfaces (drop-in replacements).

Modified:
- `src/engine/turnOrchestrator.ts` — intent-first ordering; observer-triage
  and salience hooks in the apply phase (behind flags).
- `src/llm/llmProposalEngine.ts` — accept an `Intent` to narrow the prompt.
- `src/llm/index.ts` — wire Laya engines; deprecate chat-mode Laya provider.
- `src/config.ts` + `.env.example` — `LAYA_URL` (default
  `http://127.0.0.1:8000`), `LAYA_MODE=off|static|dynamic` (default `static`
  after Phase 1, `off` = today's behavior), `LAYA_CONFIDENCE_THRESHOLD`
  (default 0.55), `LAYA_TIMEOUT_MS` (default 5000), `LAYA_MAX_OPTIONS` (12),
  per-phase toggles (`LAYA_SELECTION`, `LAYA_JUDGE`, `LAYA_TRIAGE`,
  `LAYA_SALIENCE`, `LAYA_PLANNER`).
- `scripts/diagnose-ai.ts` — replace the ping with a real decision probe
  (a 2-option `choice`; assert a sane answer shape).
- `scripts/start.sh` — already starts `laya-serve`; add a note pointing at
  the typed-decisions checkpoint for quality.

Tests: `tests/unit/decision/` — client against a mock fetch, runner against
stub answers (winner-routing, caps, fallback), diagram schema validation,
slim-state token budgets, plus a golden turn test with stubbed Laya.

## 6. Phased rollout

- **Phase 0 — quality gate (do not skip).** Before building anything: take
  ~50 selection picks + ~50 judge classifications from existing logs, run them
  through Laya (typed-decisions checkpoint), compare argmax-vs-chat-judge
  agreement and measure calibration (ECE). GO only if argmax agreement is
  clearly above chance and sensible; otherwise the plan needs fine-tuning
  work first. This is the load-bearing assumption.
- **Phase 1 — foundation.** `layaClient`, types, slim states, static selection
  diagram, `LayaSelectionEngine` behind `LAYA_SELECTION=1` (chat selection
  stays default). Real decision probe in `diagnose-ai`.
- **Phase 2 — judge.** Batched Laya judge set replaces the chat judge
  (already lazy after the arch-fixes patch, so this just makes the remaining
  calls cheap and deterministic).
- **Phase 3 — intent-first + triage.** Reorder to intent → narrow proposal →
  candidate choice; observer triage + salience scoring live.
- **Phase 4 — dynamic planner** + patch-plausibility as an *advisory* signal
  (`score` 1–5 per patch → targeted retry feedback like "teleport rated 1/5:
  too far"; enforcing comes only after measurement).
- **Phase 5 — evaluation.** Rerun the experiment protocol: chat-only vs
  Laya-assisted. Metrics: selection format-failure rate (target: 0), judge
  LLM calls (target: 0), applied-turn rate (target: parity or better),
  turns/hour, LLM cost per turn, observer thought-churn per turn.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Zero-shot Laya quality near-random | Phase 0 gate; typed-decisions checkpoint; argmax ranking, never raw-threshold decisions; confidence threshold → chat fallback |
| 512-token state limit | Slim state builders with hard budgets; typed-decisions ckpt (1024) for bigger diagrams |
| `laya-serve` down / slow | Every Laya call has a fallback (chat LLM or deterministic); `LAYA_MODE=off` restores today's behavior exactly |
| Error compounding across cascade depth | Keep cascades shallow (≤4); confidence-gated early exit to chat; measure end-to-end applied rate, not per-node accuracy |
| Dynamic planner adds an LLM call | Cache diagrams; planner only on low static confidence / every N turns |
| Over-decomposition kills the "vibe" | Generation (prose, personality) never touches Laya — only decisions do |

## 8. Why this should make small models better (the thesis, stated plainly)

A 3B model's failure mode is *choosing and formatting*, not *writing*.
Today we ask it to do both at once ("brainstorm good actions AND pick the
best AND format as JSON"). The cascade splits the job along the model's
strengths: the small LLM enumerates options and writes prose (narrow prompts,
low temperature sensitivity), Laya — calibrated, instant, unhallucinatable —
does every choice. If the thesis holds, the local 3B/8B tier stops being the
hallucination source and becomes a viable default, with the hosted model
reserved for the two truly creative calls.

## RUNBOOK — Phase 5 eval (`scripts/eval-turns.ts`)

Runs N scripted turns in `--mode=chat` vs `--mode=laya` and reports the
Phase-5 comparison metrics. **Runs on the owner's machine only — never in
CI, and do not attempt a live run in automation.**

### Prerequisites

1. Ollama serving the configured models (`npm run setup:ollama`), same
   `.env` for both runs — only the `LAYA_*` flags may differ.
2. For `--mode=laya`: laya-serve answering at `LAYA_URL`
   (`npm run serve:laya`; typed-decisions checkpoint recommended).
3. A scenario file (default `scenarios/office-anton.json`).

### How to run

```bash
# 1. Chat-only baseline (Laya fully off — today's behavior)
tsx scripts/eval-turns.ts --mode=chat --turns=30 --out=logs/eval-chat.json

# 2. Laya-assisted (static cascade + judge + triage + salience;
#    planner and plausibility stay off — see below)
tsx scripts/eval-turns.ts --mode=laya --turns=30 --out=logs/eval-laya.json
```

The script prints a metric table per run and writes the JSON for
side-by-side comparison. The user actor is scripted ("continues working
quietly.") so long runs never block on stdin; autosave is off.

The `--mode=laya` profile (set only when the env var is unset, so explicit
exports win):
`LAYA_MODE=static LAYA_SELECTION=1 LAYA_JUDGE=1 LAYA_TRIAGE=1 LAYA_SALIENCE=1`.

### Metrics and what to look for

| Metric | Definition | Target (laya vs chat) |
|---|---|---|
| applied-turn rate | turns whose consequence was not the "Nothing changes." fallback (`1 - fallback_used/turns`) | parity or better |
| selection format failures | `selection_failed` + `selection_rejected` log records | 0 (down from baseline) |
| judge LLM calls | `semantic_completed` records | 0 — the Laya judge has no chat calls |
| turns/hour | wall-clock throughput | higher (Laya ~33ms vs chat-LLM seconds) |
| LLM calls/turn | engine `*_completed` + `*_failed` records per turn (proposal/selection/consequence/semantic); Laya decisions are not LLM calls | fewer |
| observer thought-churn | observer (non-acting) `actorPatches` carrying `thoughts`, per turn | lower (triage gates noise) |

Also reported: `layaEvents` — the `module=laya` event histogram
(`intent_decided`, `triage_applied`, `salience_scored`, …). In chat mode it
is empty; in laya mode a missing `intent_decided` means the cascade failed
open on every turn (check laya-serve).

### Interpreting results

- **GO for wider rollout** if applied-turn rate is at parity or better AND
  selection format failures drop toward 0 AND judge LLM calls are ~0, with
  no regression in turns/hour. Then consider enabling the flags by default.
- **Triage too aggressive?** If observer thought-churn collapses to ~0 and
  scenes feel dead, the triage noul threshold (pTrue ≥ 0.5) is too strict —
  tune per-question, not by disabling the gate outright.
- **Salience too aggressive?** If actors stop forming memories about
  obviously memorable events, lower `LAYA_SALIENCE_THRESHOLD` (default 3).
- **Planner (Phase 4)** gets its own eval before `LAYA_PLANNER=1` is ever
  defaulted: compare `--mode=laya` with `LAYA_PLANNER=1 LAYA_MODE=dynamic`
  against static, watching applied-turn rate and the planner-fallback rate
  (fallback = static diagram used; logged nowhere yet — add a counter if
  this eval happens).
- **Plausibility** is advisory-only by design and has no GO/NO-GO bar; check
  the retry-feedback notes read sensibly (`plausibility 2/5: …`) before
  relying on them.

### Troubleshooting

- `JOINGONKA_API_KEY is not set` (or Ollama connection refused): the LLM
  tier isn't configured — fix `.env` / start Ollama first. Both modes need
  the identical LLM tier or the comparison is meaningless.
- laya mode behaves exactly like chat mode (no `layaEvents`, same
  metrics): laya-serve is down or `LAYA_URL` is wrong — every Laya call
  fails open to the chat path by design. Check `npm run serve:laya` and
  `scripts/diagnose-ai.ts --live`.
- Runs are slow: each mode burns real LLM calls (no mocks). 30 turns is a
  smoke comparison; 100+ turns gives a stable applied-turn rate.
