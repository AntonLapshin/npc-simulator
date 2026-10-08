# The Plan: Making npc-simulator Work

Written 2026-10-08, after Experiment 7. This is the honest version — what
the data says, what this PR does, and what actually has to change for the
project to succeed.

## 1. Why 11 rounds of action items didn't work

Every experiment round did the same thing: found failure modes, then added
machinery *around* them — smarter retry feedback, more salvage tiers, more
prompt rules, more validators. Exp-7 proves the core bet underneath all of
it is wrong:

**The bet:** a 14B local model can, in one shot, emit a valid
`ConsequenceResult`: narrative prose + coordinate patches + effects JSON.

**The data:** 1 clean turn out of 12. 28 failed LLM calls. The model
inventing dialogue (B1), echoing prior turns verbatim through 3 identical
retries (B2), narrating walks while emitting no position patch (B3),
moving the *wrong* actor (B6). Retry feedback does not steer it. Attempt 1
is the best attempt ~72% of the time (exp-3). The consequence engine asks
one call to do four jobs — decide what happens, narrate it, emit
coordinate patches, emit valid JSON — and the model is good at exactly one
of them (prose).

**The cost structure:** wall time ≈ 100% LLM-bound, and it's
multiplicative: `(calls per turn) × (seconds per call)`. Eleven rounds
attacked *seconds per call* (think off, timeouts, budgets). Nobody
attacked *calls per turn* — which is where 70% of the time goes
(5.3 consequence terminals per turn in exp-7, most of them retries that
change nothing).

The uncomfortable corollary: **more prompt hardening will not fix this.**
A4-style prompt work moves the needle slightly; it cannot fix a capability
mismatch. The next round of "smarter retries" would be round 12 of the
same.

## 2. What this PR (exp7-fixes) does

Stop the bleeding — the highest-ROI items from exp-7, all tested
(852/852):

- **Retry cap:** outer consequence attempts 4 → 2
  (`EngineConfig.consequenceMaxAttempts`). Retries don't steer the model;
  deterministic in-loop repairs already run on attempt 1.
- **GPU safety:** `diagnose:ai` gains a VRAM-contention check
  (`nvidia-smi` resident processes — the exp-7 failure was laya-serve
  squatting on 5.8 GB); serve scripts pass `--device` explicitly when the
  binary supports it.
- **Quality:** pronoun injection + validator (`narrative.pronoun_mismatch`
  on subject pronouns, `state.pronoun_mismatch` on self-descriptive state
  strings — the tick-8 Dana state was plagiarized from Tanya verbatim);
  stationary-work verbs (typing/staring/sipping) no longer demand x/y;
  ECHO-BAN with the real exp-7 negative example; the preceding turn's
  narrative is dropped from the consequence history window.
- **Hygiene:** plain-language history notes (validator codes stay in logs),
  sentinel/control-code sanitization at display and prompt boundaries,
  `turn_completed` logged with the turn's own tick, scenario-stem save
  names, `diagnose:ai` crash fixed, `--auto` per-turn ETA, consequence
  temperature 0.9 → 0.5, `npm run probe:think` for the A3 verdict.

Expected effect: ~2–3× faster turns at 100% GPU offload (fewer calls +
no contention), fewer degenerate outputs. **This does not make the
project "work".** It buys back the time to do the real fix.

## 3. The real fix: the renderer architecture

Invert the division of labor. Today: *LLM executes, engine validates.*
The fix: *engine executes, LLM narrates.*

The engine already knows how to do everything the model fumbles:

| Today (model does it, fails) | Renderer architecture (engine does it) |
|---|---|
| Emit x/y patches for walks (B3) | Pathfinding exists (`pathfinding.ts`, `movementAssist.ts`) — the engine computes the step from action semantics; the model never emits coordinates |
| Preserve quoted speech exactly (B1) | Engine already re-inserts quotes deterministically — make it the *only* path: speech is verbatim by construction |
| Move the right actor (B6) | Engine patches only the acting actor, always |
| Emit object/prop patches (zero in 12 turns) | Affordance-driven deterministic patches (the prop-stub repair already proves the pattern) |
| Valid JSON with 6 patch fields | Consequence schema shrinks to `{narrative, thoughts, emotion}` — prose only |

What remains for the LLM per turn: **one render call** — "here is what
happened (executed, final); narrate it in third person." Validation
becomes prose-only (voice, pronouns, echo, observer-discipline). There is
nothing left to retry *about* — the patch-validation retry loop, the 70%
cost center, ceases to exist.

Then Phase 3, which is Anton's original thesis and already scaffolded:
**Laya takes proposal + selection.** Intent cascades, the renderability
screen, salvage ranking, the locomotion veto — all exist behind flags.
A turn becomes: Laya decision cascade (seconds, local, small) + one
render call (~20–30 s at 100% offload). **Target: under a minute per
turn, >80% clean turns, zero `(not done)` for simple actions.**

This is a 2–4 week refactor, not a PR. It should be done on a branch,
behind the current architecture, with the mock engines as the
deterministic-execution test harness (they already simulate the
"engine executes" contract).

## 4. What not to do

- Another round of prompt hardening as the *strategy*. Prompts are
  seasoning; the architecture is the meal.
- More retry/salvage tiers. The loop is the problem.
- Judging the project on 14B prose quality before the mechanics work.
  Mechanics are model-independent — prove them on the 3B abliterated
  model in seconds per turn, then spend 14B time on finals.
- 20-turn runs before a 5-turn smoke test passes clean. Exp-7 burned 73
  minutes to learn what 3 turns would have shown.

## 5. Experiment protocol (going forward)

1. `npm run diagnose:ai` — preflight. 100% GPU or stop.
2. 5-turn smoke on the 3B model. Mechanics must be clean.
3. 5-turn smoke on qwen3:14b. Prose must be sane.
4. Only then: the 20-turn run, with `--auto`'s ETA line as the judge.
5. Every run gets what exp-7 had: findings doc + logs + saves. The
   findings docs are the reason any of this is actionable.

## 6. Open risks, stated plainly

- The renderer architecture changes what "the simulation" *is* — less
  emergent, more authored. The LLM stops deciding outcomes. If the goal
  was "the model surprises us", this kills it. If the goal was "stable,
  logical, physical" (it is), this is the way.
- Laya decision quality is unvalidated end-to-end (Phase 5). The cascade
  could be dumber than the LLM proposal loop. Validate it on the 3B
  harness before trusting it.
- The 100%-offload speedup is projected from exp-7's numbers, not
  measured — it needs one clean 14B run to confirm.
- Even at one render call per turn, a bad render call still produces a
  bad turn. Prose-only validation + the liveness floor keep it honest,
  not perfect.
