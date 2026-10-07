# LAYA Decision Plan — radical utilization of the Laya decision model

Status: PLAN (not implemented). Companion to ARCHITECTURE.md.
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
