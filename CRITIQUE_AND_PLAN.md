# Experiment 3 follow-up: what was built, what's wrong with the plan, and the radical direction

Branch: `laya-exp3-fixes` (off `5466cbe`). All items below are implemented,
typechecked, and covered by 725 passing tests (11 new regression tests).

## A. What was implemented

**Model-side (doc items 1, 3, 4):**
- Roster-discipline examples now include Exp-3's `Leon` failure; new proper
  nouns for people/places/renamed objects are explicitly banned.
- `RENDERABILITY` guidance in proposal/selection prompts: contact only
  within reach, object use only with exact IDs, movement only toward named
  targets, no vague papers/chair micro-actions.

**S3 — identity (doc item 5):** `validateIdentityConsistency` rejects actors
claiming another roster name or a role that belongs exclusively to someone
else's persona ("I'm Dana, the new hire" on Dana's turn). Wired into
`validateConsequence` (retry feedback), `recheckAcceptedProse` (final
gate), AND the salvage prose-check — so salvage now *rebuilds* honest
prose from the action text instead of dying to "Nothing changes."
Defense in depth: the final accept gate now also runs on the two paths
that skipped it (`format_salvage_applied`, `liveness_applied`).

**S4 — speech (doc item 3):** apostrophe-aware quote parser (the old one
couldn't see tick-20's quote at all); deterministic quote reinsertion in
salvage; tightened the no-judged-quotes escape to short greetings only.

**S8 — thoughts (doc item 10):** reject thoughts naming unknown people or
claiming ungrounded requests/grants ("the pen she requested").

**S2 — failure memory (doc item 6):** `consecutiveIntentFailures` (history-
derived, survives save/load) + a hard ban in `runTurn` at 2 consecutive
failures of the same `verb|noun` intent, with `intent_banned` logging and
a prompt line so the proposal engine doesn't burn slots. `suggestionCore`
now keys `push|chair` (was `other|`). Plus the requested Laya
renderability score node (`LAYA_RENDERABILITY`, OFF by default): one 1–5
score on the final action text, ≤2 triggers one re-selection.

**S7 — retry abort (doc item 9):** replaced the "strictly growing twice"
rule with **RULE-C** (data-grounded on all 10 Exp-3 logs): abort when the
last two attempts both fail to strictly improve on best-so-far. Fires
17/25 eligible turns (vs 6/25), saves ~17 LLM calls, loses 0 best-attempts
by construction, costs 1 success (bounded, still advances via salvage).

**S5 — movement (doc item 7):** four real fixes —
1. Possessive precedence: "my" now beats a bare "her" ("waiting for her
   to show me" no longer hijacks "my desk" → tick-24 root cause).
2. `applyDeterministicGrounding` now *populates* `merged.destination*`
   from text resolution when effects/judge declare nothing (they didn't —
   all 4 `movement_repaired` turns had zero destination ids, so the repair
   was re-deriving from text through the same buggy resolver).
3. Post-repair narrative veto: a repair stepping AWAY from the narrative's
   named approach target is vetoed (tick-28: "walks over to Anton" while
   stepping 1.0 → 4.2 cells away).
4. Conservative fuzzy match for invented effects ids ("tanya's laptop" →
   `tanya_laptop`; ambiguous → dropped, not guessed).
Plus a tri-state `destinationObjectExplicit` flag: fuzzy destinations get
strictly-closer enforcement but skip the arrival/wrong-landmark sub-checks
(a fuzzy misresolution must not reject good movement).

**S6 — state/pose (doc item 8):** `describePosition` rewritten —
furniture tier beats props, signs/walls excluded, possessives keep caps
("at Tanya's desk", never "near the tanya's mug"), at/near proximity, and
the action's named destination wins the label. New gates:
`validateStateLabel` (stacked articles, wrong-desk labels) and
`validateSitPoseSeating` (pose:sit requires a chair within 1.5 cells;
fails open when the scene models no chairs).

**S9:** already resolved — `.env.example` uses `fluffy/l3-8b-stheno-v3.2`,
matching `setup-ollama.sh`. The doc's broken `.env` was your local
runtime file, not the repo template. Nothing to change.

**S10:** not a code item — it needs live measurement (memory-precision:
entries paraphrasing real turns vs stubs/fiction) before the salience
threshold can be tuned. Pending your runs.

## B. Where the doc's action items were wrong

**S5's premise was outdated.** "suggestMoveTarget still never parses the
action text" is false — C7 (Exp-1) landed long ago. The 43
`declared_without_patch` hits are about *effects* declarations, orthogonal
to repair. The real bugs were: (1) possessive hijacking, (2) destinations
never grounded into semantics, (3) narrative/repair disagreement. I fixed
those instead of building a duplicate parser.

**S3's premise was half-wrong.** The salvage accept paths *did* run
`recheckAcceptedProse` — I traced tick-20 end-to-end. The hole was a
*missing check in the gate suite* (identity), not missing gate calls. The
two genuinely ungated paths (format-salvage, liveness) are now gated.

**The Laya renderability node is the wrong layer for the job.** I built
it as specified (off by default), but consider: the S2 failures are
"handshake at 8 cells", "papers with no object id", "chair-push with no
chair". Every one of these is checkable *deterministically* — contact
distance, object-id existence, chair proximity — at zero LLM cost, with
zero judgment variance. A Laya score node for these is paying 33ms and a
forward pass for what `Math.hypot` already knows. The deterministic
intent-failure ban (which I made the load-bearing half) catches them
after 2 failures; a deterministic *pre-check* would catch them before
the first. If you enable `LAYA_RENDERABILITY`, treat it as the fuzzy
fallback for ambiguous cases, not the primary screen.

## C. The radical direction (pushback on the Laya thesis)

Laya has absorbed choosing/classification brilliantly — 20/20 cascades,
92 plausibility scores, zero format failures. But Exp-3's verdict stands:
**Laya fixed choosing, not rendering.** And no amount of decision
delegation will fix rendering, because the failure is architectural:

The consequence LLM is a **world-state author**. One unstructured call
emits x/y coordinates, pose, props, object patches, narrative prose,
thoughts, and memories — then 40+ deterministic gates try to catch its
lies. This is backwards. The gates are excellent (they caught 100% of
unknown-id patches), but they're playing whack-a-mole with a generator
that can invent a new failure mode per turn.

The fix is to **demote the consequence LLM from author to proposer**:

1. **Typed action contracts.** The LLM outputs `{type: "move",
   destination: "anton_desk"}` or `{type: "speak", text: "...",
   addressee: "tanya"}` or `{type: "contact", target: "tanya", kind:
   "handshake"}` — not x/y, not patches. The engine executes: pathfinds
   the move, copies the speech verbatim, checks contact distance.
2. **Deterministic movement.** The engine already computes repairs via
   `suggestMoveTarget` — make that the *only* movement path. The LLM
   never emits coordinates.
3. **Deterministic speech.** The LLM provides the quote; the engine
   copies it verbatim into the narrative. Quotes can never be dropped or
   invented again, because the engine — not the model — writes them.
4. **Typed interaction primitives.** sit/stand/pickup/putdown/pour as
   primitives with deterministic preconditions (chair nearby, object in
   reach, prop held), not prose the validator has to interpret.
5. **Prose last, optionally.** Only after the world transition is fixed
   does anything render prose — and it can be template-based
   ("Tanya walks to Anton's desk.") with the LLM as an optional
   stylist, not the physics engine.

This is the "reduce the burden on generative LLMs" you asked for, taken
seriously: the LLM decides *what* (intent — where Laya already shines),
deterministic code decides *how* (physics — where code is exact). A
stronger model (Qwen3-14B) then becomes what it should be: a quality
multiplier on intent classification and prose style, not a load-bearing
physics engine. The architecture must work with the 8B; the 14B just
makes it nicer.

Concretely, this means the next experiment shouldn't be "more Laya
toggles" — it should be a **typed-consequence prototype**: one scenario,
one turn type (e.g. walk-and-greet), with the consequence LLM emitting
only `{type, target, quote}` and the engine doing everything else.
Measure: clean-turn rate, and (crucially) *novel* failure modes per
turn — the typed contract should drive those to zero by construction,
not by adding a 41st gate.

## D. What to run next

1. Apply this patch, run your 10-move scenario, compare clean-turn rate
   vs Exp-3's 1/30. The intent ban + RULE-C + movement fixes should move
   it substantially.
2. If you enable `LAYA_RENDERABILITY=1`, calibrate it against
   `laya-serve` first — it's unvalidated by design (Phase 5).
3. S10 (memory-precision measurement) is the highest-value unvalidated
   item left — it determines whether the salience gate binds or stays
   advisory.
4. The typed-consequence prototype (section C) is the real next
   experiment. Everything in section A is damage control; section C is
   the cure.
