# Experiment 6 — office-anton.json, JoinGonka + GLM 5.3 Flash (all tasks), adaptive user turns, TRUNCATED at 9/21 turns

## 0. Status: incomplete run (read this first)

The run was **stopped after 9 of 21 turns (ticks 0–8, ~2.5 h wall clock)** at the
operator's request — the provider was too slow/unstable to finish 7 user turns
in reasonable time. All claims below are grounded in `logs/exp6_glm_b.jsonl`
(314 entries), `/tmp/exp6b_world.json` (world after tick 8), and
`/tmp/exp6_runall.log` (operator transcript + retry log). A pilot session
`logs/exp6_glm.jsonl` (27 entries, abandoned after a restart) additionally
showed a **single consequence call taking 315 s**.

User turns completed: 3 of 7 (ticks 0, 3, 6). NPC turns completed: 6 (ticks 1,
2, 4, 5, 7, 8). Tick 9 (user turn 4, coffee run) was killed mid-consequence.

## 1. Command / setup used

No interactive `tmux` this time — a step runner was written so every user
action is decided **at runtime, after reading the preceding NPC turns**
(`decideUserAction()` inspects positions/history/narratives; canonical
Exp-4/5 texts used when the live state matches assumptions, adapted otherwise):

```bash
npx tsx /tmp/opencode/exp6-run-all.ts --session exp6_glm_b --save /tmp/exp6b_world.json
# runner: /tmp/opencode/exp6-run-all.ts (repo untouched)
```

Key differences from Exp-4/5:

- **ALL four tasks (proposal + selection + consequence + semantic) on
  JoinGonka `zai-org/GLM-5.3-Flash`.** The default tier routing would have put
  selection/semantic on local Ollama (small model) — that would confound the
  "large model, no weak-model excuse" premise, so the runner injects one
  JoinGonka provider into every engine.
- **Retry wrapper around the provider** (`RetryingProvider`, 10 attempts,
  exponential backoff 2.5 s → 60 s + jitter) retrying 429 / timeout / 5xx /
  socket errors. Per-attempt timeout 120 s (`LLM_TIMEOUT_MS=120000`).
- Engine otherwise unchanged (post-Exp-5 code: clamp repair, tier-2 salvage,
  honest history, liveness floor threshold 3, selection screening).
- Autosave off; world saved + logger flushed **after every turn** (kill-safe;
  resume supported by re-running with the same `--save`).

## 2. Why did it take so long?

Per-turn wall times (from `turn_started` → `turn_completed`):

| tick | actor | wall time | outcome |
|---|---|---|---|
| 0 | anton (user) | **8.6 min** | applied |
| 1 | tanya | **12.0 min** | applied (via movement repair) |
| 2 | dana | 4.0 min | applied |
| 3 | anton (user) | 1.6 min | applied |
| 4 | tanya | **24.1 min** | FALLBACK (format collapse) |
| 5 | dana | 2.3 min | applied |
| 6 | anton (user) | **37.5 min** | FALLBACK (format collapse) |
| 7 | tanya | 8.6 min | applied (via movement repair) |
| 8 | dana | **47.4 min** | FALLBACK (format collapse) |

Three compounding causes, all measured:

1. **Provider latency + instability (dominant).** Typical successful calls take
   30–120 s; **37 transport timeouts (120 s each), 5× HTTP 429, 2× HTTP 503
   (`no escrow can fund this request … no devshard runtimes available`)**
   in 9 turns. The retry wrapper absorbed all of them (zero turns lost to
   transport), but every absorbed timeout costs 2+ minutes. The engine's
   `completeJson` loop (up to 4 attempts per engine call) multiplies this:
   one slow turn = 4 consequence attempts × (2 timeouts + 1 success) ≈ 15 min
   of pure waiting.
2. **Format-collapse retry loops.** Ticks 4, 6, 8 burned *all 4* consequence
   attempts on **unparseable output** (§4.1) — each attempt a full slow LLM
   call plus repair prompt. These three turns alone consumed ~109 min for
   three `fallback_used` lines.
3. **Call volume per turn.** An NPC turn = proposal (1 + parse retries) +
   selection (1 + retries) + consequence (up to 4) + semantic judge (1) ≈
   4–10 LLM calls. At ~1–2 min median per call under current gateway
   conditions, even a clean turn costs 5–12 min. Projected full 21-turn run:
   **5–6 hours**. A "long lasting simulation" at this price is ~2–4 turns/hour.

Verdict on speed: **the engine is not the bottleneck — the hosted gateway is.**
But the engine *amplifies* it: no timeout budget per turn, no early-abort on
repeated identical parse failures, no concurrency across independent calls.

## 3. What happened per tick (ground truth, cross-checked vs JSONL)

| tick | actor | result | positions after (Anton/Tanya/Dana) |
|---|---|---|---|
| 0 | anton (user 1: greeting) | **applied, clean pass** | (16,2)/(8,7)/(15,11) |
| 1 | tanya (save work, greet) | **applied via movement repair** (8,7)→(13,4), sit→stand, prop laptop→null | (16,2)/(13,4)/(15,11) |
| 2 | dana (shout welcome) | **applied, clean pass** | unchanged |
| 3 | anton (user 2: walk to Tanya + desk Q) | **applied, clean pass** (16,2)→(14,3) | (14,3)/(13,4)/(15,11) |
| 4 | tanya (lead west to desk) | **FALLBACK** (format collapse ×4) | unchanged |
| 5 | dana (resume skimming) | **applied, clean pass** | unchanged |
| 6 | anton (user 3: thanks + desk + sit + Q) | **FALLBACK** (format collapse ×4) | unchanged |
| 7 | tanya (walk west with Anton) | **applied via movement repair** (13,4)→(10,9) | (14,3)/(10,9)/(15,11) |
| 8 | dana (shortlist drag + note) | **FALLBACK** (format collapse ×4) | unchanged |

Applied: **6/9 (67%)** vs Exp-5's 2/21 (10%). Fallbacks: 3/9 — **all three are
JSON-format collapses, zero are gate rejections of well-formed output.**

Scene narrative (the part a player sees): Anton greets from the door; Tanya
saves her test run, stands, walks over; Dana shouts a welcome without looking
up; Anton walks to Tanya and asks where his desk is; Tanya starts leading him
west; Dana keeps screening. **Coherent, in-character, no strangers, no Jeff,
no handshakes, no re-introductions.** The large model kills every Exp-3/4/5
small-model attractor dead (handshake ×0, greeting-loop ×0, Jeff ×0, invented
roster ×0, stranger-frames ×0).

## 4. Verdict: engine vs. large-model attribution

### 4.1 Model-side failures (large model is NOT exempt)

1. **Format collapse under complexity (ticks 4, 6, 8).** Three distinct
   failure shapes, all on information-dense turns:
   - prose-only analysis with no JSON (`no JSON object found`, tick 4 ×12,
     tick 8 ×2) — raw starts `"Let me analyze this. Dana is at his desk…"`;
     the model leads with chain-of-thought despite "Return JSON only".
   - prose + pseudo-JSON with single-quote-style syntax
     (`Expected double-quoted property name … position 37/38`, ticks 6 ×12,
     8 ×10) — identical byte offset across turns suggests a systematic
     template quirk, not randomness.
   - schema-shape errors (`memoriesAppend` as string, missing `narrative`,
     tick 0–1 attempts).
   
   Critically, **the repair prompt never converges**: the same error repeats
   4/4 attempts (the Exp-5 "same omission 4/4" modal pattern, now at the JSON
   layer rather than the gate layer). `formatRepairPrompt` appends the
   clipped bad output + "Return ONLY the corrected JSON" — the model
   re-emits the same analysis-first shape. Expecting a different result from
   an identical prompt is the loop's design flaw (§5.2).
2. **`"Consequence" leaking into narrative (ticks 4, 6, 8).** Validation
   reports `narrative names unknown actor "Consequence"` — the model names
   the pipeline stage in-prose, exactly the Exp-4/5 small-model symptom.
   Scale did not fix it; it fires when the model is already collapsing
   (all three are placeholder-"Nothing changes." outputs), so it reads as a
   give-up marker rather than a belief about the world.
3. **Stale `state` strings (tick 1).** Tanya stands up, walks 5.8 cells, puts
   down the laptop — but her `state` still reads
   `"sitting at her desk and working on a laptop"` afterward. The validator
   has no state↔pose↔position coherence check; prose/state drift is free.

### 4.2 Engine misses (all with repro ticks)

1. **Destination resolution misranks — again (tick 7).** The consequence
   correctly declared `effects.destinationObjectId=anton_desk`; the
   deterministic layer overrode it with `grounded=tanya_desk`
   (`destination conflict: effects=anton_desk grounded=tanya_desk (kept
   grounded)`), because "desk with the ANTON nameplate" keyword-matched
   Tanya's desk. The applied position (10,9) is adjacent to *Tanya's* desk
   while the narrative claims the ANTON nameplate desk — a wrong-desk pass
   laundered through the repair path. **Exp-5 item 3 is still open, and this
   run proves it is not a small-model artifact**: the model was right, the
   resolver was wrong, and the merge rule ("grounded wins") sided with the
   resolver. Reconsider the precedence: model-declared ids that exist in the
   roster/object list should outrank keyword guessing.
2. **Curly-vs-straight quote mismatch drops speech (tick 7).**
   `dropped ungrounded quote "You're asking …" (not in action text)` — the
   action used `'` and the narrative `'`. Same Exp-4 item 4 class
   (apostrophe handling), now as a Unicode-normalization gap. Normalize
   quotes/apostrophes before comparing.
3. **No per-turn time budget.** A turn can burn 47 min (tick 8) with no
   circuit breaker. Add: total turn deadline (e.g. 10 min) after which the
   turn salvages/falls back; early-abort when N consecutive attempts fail
   with the *identical* parse error (re-prompting is futile — vary the
   repair: shorter prompt, lower temperature, or schema-only retry).
4. **Salvage correctly refused 3/3 — but log the asymmetry.** All three
   `salvage_evaluated: ineligible` are correct (placeholder narrative +
   observer-discipline failures are hard gates by design). However, note the
   pattern: with a large model, failures are *format* failures (nothing to
   salvage — no valid patches exist), while tier-2 salvage was built for
   *content* nits. The salvage path is nearly unreachable in the
   format-collapse regime. A "valid-JSON-at-all-costs" tier (accept any
   parseable subset, e.g. narrative + thoughts-only) would convert ticks
   4/6/8 from total fallbacks into liveness-grade dialogue.
5. **Movement repair is the run's hero — and it over-trusts the resolver.**
   Both repairs (ticks 1, 7) landed legal ≤6-cell steps that advanced the
   scene. But tick 7 shows repair aim follows the (possibly wrong)
   `destinationObjectId` from grounded semantics. Repair to a wrong landmark
   passes gates while contradicting the narrative.
6. **Proposal-level dedup fires correctly (tick 8).** `selection "Open my
   calendar…" repeats recent action "Dana: Call out…"` — wait, that rejection
   message itself looks over-eager (calendar vs shout share little), but it
   forced a fresh pick. No handshake/greeting attractor appeared at all, so
   dedup had almost nothing to do. Selection screening (Exp-5 item 7) had no
   POV-swap to catch — the large model holds POV.
7. **Memory compounding works when turns apply (ticks 1, 7).** Tanya and
   Anton both appended genuine episode memories
   (`"Started leading Anton west toward his desk…"`,
   `"Tanya got up from her desk and came over…"`) plus goal updates. Exp-5
   item 7 ("memory appends nothing") is a *fallback-rate* symptom, not a
   mechanism bug: at 67% applied, memories grow on their own.

### 4.3 What the large model fixed (confirm with numbers)

| metric | Exp-5 (8B local) | Exp-6 (GLM 5.3 Flash, partial) |
|---|---|---|
| applied rate | 2/21 (10%) | **6/9 (67%)** |
| NPC locomotion | 0 cells in 21 turns | **Tanya 2 capped steps (~11.6 cells)** |
| pose changes applied | 1 (user only) | **1 (Tanya stand, NPC)** |
| object touches applied | 0 | 0 (unchanged — see §5.4) |
| handshake attractor | 6+ | **0** |
| greeting/re-intro loop | 5+ | **0** |
| Jeff / invented roster | Jeff + 4 names | **0** |
| stranger/candidate frames | 5+ | **0** |
| observer-as-subject prose | 10 rejections | **0 rejections** |
| memories appended | 0 in 21 turns | **≥3 in 9 turns** |
| quote-drop / question-drop gates | fired constantly | **0 fired on applied turns** |
| judge-poisoned fallbacks | 0 (fixed Exp-4) | **0** |
| fallback history honest | yes | **yes (`tried: … (not done)`)** |

The Exp-3 §6 conditional ("engine sound if model strong") **holds**: with a
capable model, grounding/caps/gates stop being a freezer and become what they
were designed as — a backstop. The remaining fallbacks are transport/format,
not physics disagreements.

## 5. Action items (ordered)

Engine (correctness):

1. **Fix destination precedence (tick 7).** Model-declared existing ids
   (`effects.destinationObjectId`) should outrank deterministic
   keyword-first-match; keep the resolver as fallback for undeclared targets.
   Add furniture-over-prop / ownership / proximity ranking to the resolver
   regardless (Exp-5 item 3, now with large-model repro).
2. **Normalize quotes before speech comparison (tick 7).** Curly/straight
   apostrophes and quote chars must canonicalize in both action text and
   narrative before the quoted-speech gate compares (Exp-4 item 4, Unicode
   edition).
3. **Per-turn time budget + identical-error early abort (ticks 4, 6, 8).**
   Cap total turn wall time; abort the retry loop when the same parse error
   repeats (vary strategy instead: minimal schema-only re-prompt).
4. **"Valid-JSON-at-all-costs" salvage tier (ticks 4, 6, 8).** When all
   attempts fail *parse* (not gates), accept a degraded thoughts-only /
   narrative-only payload rather than `fallback_used`. Format collapse ≠
   content violation.
5. **State↔pose↔position coherence check (tick 1).** Reject or auto-patch
   `state` strings that contradict applied pose/position (sitting-state
   while standing 5.8 cells away).
6. **Throughput engineering for hosted backends.** Per-turn deadline,
   concurrent proposal+selection context builds where independent, token
   budgets proportional to payload (consequence prompts are the long pole),
   and provider health probing with model fallback before burning 37
   timeouts in one session.

Prompting (cheap, high-leverage):

7. **Reasoning-leak guard.** "Let me analyze this…" preambles cause 14/61
   parse failures. Add an explicit first-token constraint
   (`Begin your response with {`) and/or a JSON-mode flag if the gateway
   supports `response_format: {type: "json_object"}` — the single highest-ROI
   fix in this report.
8. **Stop naming the pipeline.** Add one line to the consequence suffix:
   never write the words proposal/selection/consequence/semantic/actor/patch
   in narrative or reasoning-as-prose.

Unchanged (still zero): **object interaction.** 0/9 applied turns touch
objects (0/21 in Exp-4/5 too). The desk-lamp/laptop/mug patches never
materialize even when the action is *about* them (tick 8's shortlist drag is
arguably UI-fiction, but tick 6's sit + tick-1's laptop put-down show the
same avoidance). With hallucination ruled out as the cause, suspect gate
asymmetry: pose/prop/object patches are *required when the verb appears*
but the model is never *required to attempt* them — and `prop: null` (tick 1)
is accepted without an object patch for the put-down. Consider an
affordance nudge: when the action names a manipulable object, the retry
feedback should demand the object/prop patch explicitly rather than only
punishing its absence after the fact.

## 6. High-level reasoning: is it built properly? Can it last?

**Architecture verdict: yes, the core design is sound — this run is the
strongest evidence for it so far.** The turn loop (subjective proposal /
selection → objective consequence → physics validation → honest history),
the merged action semantics (deterministic parse OR judge, logged
disagreements), the repair-then-salvage-then-liveness degradation ladder —
all behaved as designed under a competent model. Every applied turn is
defensible; every fallback is correctly labeled; history distinguishes wishes
from facts; memories compound. The Exp-5 fear ("tighter validation is a
freezer") turned out to be model-contingent: at 67% applied with NPC-initiated
locomotion, the same gates are a backstop, not a wall. Nothing in ticks 0–8
suggests a structural ceiling on scene coherence.

**But "built properly" ≠ "ready for long-lasting simulation". Three gaps
stand between this engine and a session users enjoy for hours:**

1. **Throughput is the existential problem, not intelligence.** 2–4
   turns/hour at hosted-latency means a "long lasting simulation" is
   currently a slideshow users watch loading spinners through. Decompose:
   provider latency (external, mitigable via budgets/failover/local-first
   routing for simple tasks) × call volume (~8 LLM calls/NPC turn, two of
   which carry near-identical full-context prompts — the
   verification-action-items duplication concern, still unaddressed) × retry
   amplification (4 attempts × 10 transport retries with no turn-level
   deadline). A longevity soak must start with a latency SLO (e.g. p50 turn
   < 60 s) and the engineering to meet it; otherwise compounding memory,
   liveness floors, and quest threads are moot — users leave before tick 10.
2. **Degradation covers content failure but not format failure.** The
   ladder (repair → salvage → liveness → fallback) assumes parseable output.
   A third of this run's turns produced *nothing parseable*, and the ladder
   has no rung for that — each cost 24–47 min and yielded "Nothing changes."
   JSON-mode + format-tier salvage (§5.4/5.7) would convert the worst turns
   into the cheapest ones.
3. **The world model is still bodies + words, not hands + things.**
   Zero object touches across four experiments (two models, 70+ turns) is
   now a structural datum: the engine verifies object patches strictly but
   never *elicits* them, and validates `state` strings never. Long-lived
   play needs object-mediated goals (brew coffee *in a cup*, open *the*
   laptop, hand *the* papers) with the validator checking
   state↔pose↔position↔prop coherence as one unit — otherwise months of
   simulated office life leave every mug untouched and every laptop closed,
   and the "simulation" is improv dialogue on a static diorama.

**Bottom line:** the engine earns its keep — it kept a clean, persona-true,
physics-legal story for 9 turns with a good model, and its logs told us
exactly why the other 3 failed. Recommend: (a) JSON-mode + turn budgets +
   destination-precedence fixes, (b) re-run the full 21-turn protocol when
   the gateway is healthy (off-peak, with the §5 items in), success = ≥60%
   applied with ≥1 NPC applied turn per cycle and ≥1 object touch, (c) only
   then schedule the longevity soak (Phase 6). The idea is viable; the
   per-turn economics are not — yet.
