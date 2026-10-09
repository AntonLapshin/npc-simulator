# PLAN_V2 — the simplified turn loop ("director's cut")

## Why

The renderer architecture proved one thing conclusively: **the engine must
own physics** (movement, speech quotes, object manipulation). Everything the
Stage 1–3 shakedowns validated on that front stays.

But the decision stack built on top of it — propose options → pick one →
screen → re-screen → salvage → fallback chains — is scar tissue from trying
to make an unreliable narrator reliable. Stage 3 proved the Laya cascade
doesn't convert (0/10 turns), and the per-turn economics are fatal: 3–4 LLM
calls plus retries put a turn at 60–90 seconds on the 14B.

**The binding constraint: a turn must complete in under 30 seconds.**
At ~60 tokens/sec on the 14B, that budget buys roughly **two LLM calls per
turn, total**. Everything else must be cheap (local) or free
(deterministic). This plan redesigns the turn around that budget.

## The v2 turn (target shape)

One NPC turn = **2 LLM calls + 1 cheap local call + deterministic engine**:

1. **Intend (1 LLM call).** The prompt states the physical facts —
   who stands where, who holds what, what is within reach — and asks for
   one thing: `{ action: "one sentence, third person", quote: "exact words
   or empty" }`. No options list, no separate pick step. The LLM does what
   it is good at (scene understanding, fluent intent) and nothing else.
2. **Parse (1 Laya call, batched, local).** The existing judge question
   set (`q_moves / q_speaks / q_addressee / q_destination / q_contact`)
   classifies the *action sentence* into structured facts. Laya stops being
   a decider and becomes a **parser** — it never has to understand the
   scene, only the sentence in front of it. This kills the Stage-3
   miscalibration failure by construction: there is no scene-level
   classification left to get wrong.
3. **Execute (engine, deterministic).** Movement via pathfinding, the quote
   recorded verbatim, manipulation via affordances — from the parsed facts.
   **Impossible things are clamped, not corrected.** If she tries to shake
   a hand from across the room, the engine does not teleport her and does
   not ask the LLM for another idea: the attempt is recorded, the
   execution is clamped (she calls out instead / the attempt visibly
   fails), and the turn moves on. No correction loops, ever.
4. **Narrate (1 LLM call).** The prompt contains *what the engine actually
   executed* — not what was intended. The existing prose validator checks
   it; **one retry max**, then accept-and-mark honest. Invention surface is
   small because the prompt is a list of executed facts.

**Budget math (rough):** intend ≈ 700 prompt + 60 output tokens; narrate ≈
600 + 150. On the 14B (~60 tok/s) that is ~25–30s; on an 8B (~100 tok/s),
~15–18s. The Laya parse is local (milliseconds to low seconds on CPU);
the engine is milliseconds.

## The director

Free-will NPCs drift into polite small talk — every experiment log shows
it. A scenario that lasts a hundred turns needs injected drama.

The director has two halves (this is a deliberate refinement of the
"system prompt only" idea):

- **Style guide (system prompt).** Instructions for eventful narration —
  the draft is in the appendix. It tells the narrator how to *handle*
  drama, not when to invent it.
- **Deterministic trigger (the load-bearing half).** We learned in exp-5
  that small models ignore prompt lines ("do NOT repeat yourself" did
  nothing; the deterministic ban did everything). A prompt-only director
  will be politely ignored by turn 30. So: the engine watches for
  staleness — K consecutive turns with no new action cores and no
  world-state changes — and injects the next unconsumed incident from the
  scenario's `directorEvents` list as a plain world fact
  ("The fire alarm starts ringing."). The LLM never decides *whether*
  drama happens; it only narrates it well. Because incidents are world
  facts, the picture shows them too.

Scenario authors (you) write the incident list per scenario; the trigger
guarantees it fires.

## Phases

Each phase is scoped to fit a single agent run and a single PR, in order.
Nothing lands without its tests.

### Phase 1 — The intent call (kill proposal+selection)

- New `src/llm/llmIntentEngine.ts`: builds the physical-facts prompt
  (reuse `contextBuilder`), one structured call → `{ action, quote }`.
  Deterministic schema validation → 1 retry → deterministic fallback
  action ("waits and observes the situation").
- Orchestrator: `TURN_LOOP=v2` flag gates a new path that replaces
  proposal+selection with the intent call. The v1 path stays untouched
  behind the default flag.
- User (human) turns: unchanged — the human's text *is* the intent.
- Add `turnTimeBudgetMs` (default 30000) as telemetry-only: a loud
  `turn_time_exceeded` event when a turn blows the budget, mirroring
  `budget_exceeded`. Never aborts a turn.
- Tests: prompt contains the physical facts; schema validation;
  retry-then-fallback; one full v2 turn with scripted providers.
- Acceptance: 10-turn run on the 14B — intent parse-failure rate near
  zero; median intent-call latency recorded.

### Phase 2 — Laya as parser

- Wire `LayaSemanticJudge.classify` (the existing batched judge set — one
  local `decide` call) directly after the intent call. Output is
  `ActionSemantics`: moves? speaks? addressee? destination? contact?
- Executors accept the pre-parsed semantics as input; when absent they
  keep their current text-parsing behavior (v1 keeps working).
- Fail-open: Laya down → fall back to the existing deterministic text
  parsers (they already exist for movement/speech/manipulation). The turn
  never blocks on the parser.
- Tests: a golden set of action sentences → expected semantics, scripted
  Laya client (build the set from Stage 2/3 logs — real sentences, not
  invented ones).
- Acceptance: parse accuracy on the golden set; v2 turn still completes
  with the parser disabled.

### Phase 3 — Clamp policy (no correction loops)

- Write down, as code, what the engine does with impossible parsed
  intents: contact beyond reach → attempt recorded, no teleport (convert
  to calling out where the verbs allow, else graceful fail); movement to
  unreachable/occupied → closest reachable cell or stay; manipulation of
  a distant/unheld object → graceful fail.
- Every turn records **attempted vs executed**. The narrator receives both,
  so the story shows honest failure ("she reaches for his hand, but he's
  across the room") instead of silent drops or `(not done)` sentinels.
- Tests: one unit test per clamp rule, plus attempted-vs-executed showing
  up in the narrate input.
- Acceptance: a deliberately impossible action (handshake from 10 cells)
  produces a coherent honest turn with no extra LLM calls.

### Phase 4 — Narrate executed facts

- New narrate prompt: input is the executed-facts block (from Phase 3),
  not the intended action. Reuse the prose validator as-is.
- **One retry max**, then accept-and-mark honest (the `(not done)` family
  of sentinels stays dead — a flawed paragraph beats a dead turn).
- Hypothesis to confirm: attempt-1 pass rate rises vs Stage 2's 1/5,
  because the prompt is a fact list with little invention surface.
- Tests: validator still catches invented movement/speech; retry cap
  respected; executed-facts prompt shape.
- Acceptance: 10-turn run — attempt-1 rate and median narrate latency
  recorded against the 30s budget.

### Phase 5 — The director

- Scenario JSON gains `directorEvents`: ordered list of
  `{ id, text }` — each a world fact ("The fire alarm starts ringing.",
  "Dana's phone buzzes with an urgent message.").
- Deterministic staleness trigger in the orchestrator: K consecutive
  turns (default K=6, tunable per scenario) with no new verb|noun action
  cores and no world-state changes → inject the next unconsumed event
  into the intent prompt as a fact. Consumed events are never repeated.
- The director style guide (appendix draft) ships in the narrate prompt.
- Tests: trigger fires exactly when stale; stays silent when the scene is
  lively; each event consumed once; incident appears in history (and
  therefore in the picture).
- Acceptance: scripted 15-turn run with a boring loop → incident fires →
  the scene visibly changes.

### Phase 6 — Cutover, measure, clean

- Flag flip: v2 becomes the default, v1 goes behind the flag (then the
  flag — and v1 — is deleted in the same phase; no permanent dual paths).
- Head-to-head: 20 turns v1 vs v2 on the 14B — p90 turn time (target
  < 30s), clean-turn rate, LLM calls/turn, attempt-1 narrate rate.
  Repeat the head-to-head on an 8B model if one is handy — the simplified
  loop is *designed* for it.
- Fix the `--compare` script to count failed attempts carrying `usage`
  payloads (the Stage-3 36-vs-34 lesson) so the next comparison is honest.
- **Aggressive cleanup:** delete `layaProposalEngine`,
  `layaSelectionEngine`, `intentCascade`, the static decision `diagrams`,
  the renderability screen, the LLM proposal/selection engines, and the
  `cascade_delegated` telemetry. The Laya judge (parser) stays.
- Update `ARCHITECTURE.md` (new turn pipeline), `PROTOCOL.md`
  (v2 run checklist), `README.md`.
- Acceptance: full suite green; docs match the code; the deleted
  machinery is confirmed gone (grep).

## Open questions (decided during implementation, not now)

- **One call or two?** Phase 4 could experiment with a single call that
  returns `{ action, quote, narrative }` *before* execution, with the
  validator catching lies and one retry. It halves narration cost; it
  risks lower attempt-1 rates. Default stays two calls; the experiment
  is cheap once Phase 4 exists.
- **Observer thoughts/emotions** (triage/salience): keep, simplify, or
  cut? Decide in Phase 6 cleanup — they are not on the critical path.
- **The human player's actions** go through the Laya parser too (Phase 2),
  so the picture stays accurate for player actions. No special casing.
- **Memory over 100+ turns:** the slim state builders already budget
  characters; long runs will additionally need rolling summarization of
  distant history. Out of scope for these six phases — flagged now so it
  is not forgotten.

## Appendix — director style guide (draft)

> You are narrating a living scene, not transcribing one. Favor the
> specific over the generic: a chipped mug, not "a cup". Let small
> frictions surface — interruptions, misunderstandings, unfinished
> sentences. When a director incident arrives, treat it as real and
> let every character react in character; do not resolve it in the same
> paragraph it appears. Never summarize feelings instead of showing them.
> Never let three consecutive turns pass with everyone merely being
> polite — if the facts give you nothing, say what the room feels like.
> The world facts are final: narrate what happened, not what should have.
