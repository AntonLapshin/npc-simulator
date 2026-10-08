# Experiment 5 — Critique and Plan (exp5-fixes)

Peer review of the 13 action items in
`experiments/exp5-laya-anton-10moves-2026-10-08.md`, verified against the
run's own artifacts (`logs/exp5_laya.jsonl`, `saves/exp5-laya-anton.json`)
and the current code. Each item is marked IMPLEMENTED (done here),
ALREADY-DONE (verified live, not re-implemented), or PUSHED-BACK (premise
wrong / cheaper fix exists), with the verification evidence.

## Verified-against-logs (spot checks)

- **S4 tick-27**: confirmed exactly. `salvage_prose_synthesized` produced
  `Anton says "Thanks both for making me feel welcome. I'm going to get
  my laptop set up now."` (perfect quote preservation); the accept gate
  rejected it with `[narrative.unknown_actor] "Consequence"` — the word
  came from the engine-written `reasoning: "Fallback due to Consequence
  Engine failure."`, not the narrative. 1 `salvage_accept_gate_rejected`
  in the run, this one.
- **S2**: 8 `movement_repair_vetoed`, 6 `movement_repair_resteered`, 5
  `movement_repaired` — counts match. Tick-24 trace shows the veto
  firing and then the clamp path committing (4,12) under the stale
  `enters the office` narrative. Tick-15 trace shows the deeper bug: the
  repair (4,10) steered toward the judge's `anton_desk` but was vetoed
  because the *narrative* said "Tanya's desk" — the veto trusts corrupt
  prose over semantic ground truth.
- **S3**: all three receipts confirmed in `saves/exp5-laya-anton.json`
  history: tick 8 (Dana, wrong pronouns + phantom laptop), tick 23
  (`Dana: Tanya and Dana turn to look at Anton as he enters the office.`),
  tick 24 (`Anton: Anton enters the office.`).
- **S8**: Tanya's laptop-setup offer failed at ticks 13 and 19 with
  byte-identical text; the ban fired at tick 22 (`other|anton`) exactly
  per the skip-non-matching design (tick 16 was a different intent), then
  the substitute (`glance at the test plan…`) dodged the ban on a
  different key and failed too.
- **M1**: zero `narrative.first_person` / `narrative.doubled_prefix`
  validation hits in the run — the consequence-narrative voice gate is
  working; the 10+ first-person occurrences are action-text POV, which is
  by design (see below).
- **S7**: all 17 `retry_aborted` events carry the RULE-C message ("last
  two attempts failed to improve on best-so-far") — Exp-3 item 9 is live
  and firing.

## Item-by-item verdicts

### Model-side

**1. Third-person discipline line in proposal + consequence prompts — PUSHED BACK (proposal half).**
The consequence prompt already carries the NARRATIVE VOICE line (Exp-4
item 1, both short and full modes). The proposal half contradicts a
deliberate design decision documented in `validateSelectionForActor`
(Exp-4 item 6 / S4): "Proposal suggestions are first-person BY DESIGN…
the 'I' is unambiguous identity anchoring." Forcing third-person into
proposal would churn the action-text convention (selection screen,
`tried:` history format, intent-ban keying, fully-spoken detection) for
no validated gain — exp-5 had zero narrative voice violations, so the
current split (first-person intent in, third-person narrative out, voice
gate between) works. The actual M1 harm (first-person in canonical
history) is already gated. Not implemented.

**2. Capable tier for user turns + noop warning — ALREADY DONE.**
`user_capable_tier_noop` warning exists in `src/llm/index.ts:149-176`
(verified live in code; the event name is also wired into the eval
harness). Not re-implemented.

**3. Canonical speech-turn form + echo-gate exemption — ALREADY DONE.**
`FULLY_SPOKEN_ACTION_LINE` is in both consequence prompt modes (Exp-2
item 3) and `quotedSpeechEchoedVerbatim` exempts fully-spoken actions
from `narrative.echoes_action` (Exp-2 item 6). `narrative.echoes_action`
fired 0× in exp-5. The pure-speech turns died to other gates (movement,
S4), not the echo gate. Not re-implemented.

**4. Renderability-matched proposals — ALREADY DONE (prompt half).**
RENDERABILITY lines exist in both `proposalSuffix` and `selectionSuffix`
(Exp-3 item 4) with exactly the asked content (contact ≤2 cells, exact
object ids, named movement targets). A selection-side renderability
*screen* (deterministic reject of ungroundable picks) would be the
enforcement half, but it is a behavior change needing live calibration
and the item was scoped to prompts. Noted as an optional follow-up, not
implemented here.

### Simulation-side

**5. S4 — accept-gate name checks must not scan `reasoning` — IMPLEMENTED.**
`validateNarrativeActors` built its audit text as
`` `${narrative} ${reasoning}` `` — the tick-27 false positive. The
reasoning field never becomes canonical history, and the engine itself
writes pipeline words into it ("Fallback due to Consequence Engine
failure."), so scanning it is pure false-positive surface. Fix: the
audit scans `narrative` only (signature narrowed to `{ narrative }`;
all 5 call sites updated). Hygiene: engine-written fallback reasoning
strings no longer use the pipeline-banned words ("Selection/Proposal/
Consequence Engine failure" → "engine failure"). Regression test: the
exact tick-27 case (good-quote salvage + engine-worded reasoning passes).

**6. S2 — vetoed repair must commit, never veto-then-retry-to-fallback — IMPLEMENTED (two parts).**
(a) *Veto target priority (new observation).* The veto compared the
repair against the *narrative's* named target, but the narrative is
untrusted model output: at tick 15 the judge correctly resolved
`anton_desk` and the repair stepped toward it, yet the veto fired
because the corrupt narrative said "Tanya's desk". Fix: the veto and
re-steer now use the *effective* target — the judge's explicit
destination when present, else the narrative's (disagreements are
logged). The tick-28 case the veto was built for (narrative right,
repair wrong) is preserved: when the judge is silent or agrees, behavior
is unchanged.
(b) *Honest stationary downgrade.* When the veto fires and no legal
toward-step exists (already adjacent, or blocked — e.g. Tanya at (8,7)
next to Anton at (7,7)), the world fact will not change on retry, so the
turn now commits a stationary downgrade immediately instead of burning
retries into a fallback: movement stripped from the attempt's patch,
`moved=false`, honest synthesized narrative ("<Name> remains in position
[by <target>][. <Name> says "…"]"), thoughts/emotion kept, full
validation + accept gate before commit. If the downgrade fails
validation, the loop retries as before.

**7. S3 — gate re-check + regression tests — IMPLEMENTED (premise corrected).**
The "full gate-suite re-check" premise is wrong: `recheckAcceptedProse`
already runs on *every* accept path (retry-loop clean accept, in-loop
movement/clamp/prop repairs, format salvage, content-salvage accept and
tier-2, liveness) — the tick-10/11 hole from exp-2 stays closed. The real
gaps were missing *checks*, fixed here:
(a) *Observer-led coordinations (tick-23 repro).* "Tanya and Dana turn
to look…" dodged both prose gates: the `and`-split produces a bare
"tanya" fragment (no Name+verb match) and a "dana…" clause led by the
acting actor. New shared matcher catches `^observer (and <name>)*
<word>` on the unsplit clause — verb-agnostic in the supplement,
verb-list-checked in `validateObserverSubject`.
(b) *Stale `enters` gate (ticks 23/24 repro).* New `narrative.stale_enter`:
"enter(s|ed|ing) the office/room/building" fails when the acting actor
already has a completed prior turn in history (re-entry across a modeled
exit is the known limitation; the office scenario has none).
(c) Three regression tests: stay-action→teleport (mechanism existed via
`isExplicitStayAction`, test was missing), stale `enters the office`,
observer-as-subject coordination on the accept path
(`recheckAcceptedProse`).

**8. Voice gate — ALREADY DONE (narrative half) / PUSHED BACK (action-text half).**
`validateNarrativeVoice` is wired unconditionally into
`validateConsequence` (physicalValidator.ts, Exp-4 item 6) with a
targeted retry hint, and fired 0× in exp-5 because narratives were
clean. Failing fast on first-person *action text* would contradict the
by-design first-person proposal convention (see item 1) and substitute
every NPC turn to fallback. Not implemented.

**9. S8 — intent-ban keys too narrow — IMPLEMENTED.**
Two changes: (a) exact-key normalization — added the missing `offer`
verb stem to `CORE_VERBS` (the tick-13/19/22 verb keyed to `other`;
case/leading-pronoun handling was already fine); (b) *intent-cluster
bans* — the substitute dodge: `suggestionClusterNouns` extracts
concrete object-kind nouns (laptop, desk, coffee, …; actor mentions and
abstract nouns excluded so a failed walk to Anton doesn't ban greeting
him), and `consecutiveClusterFailures` counts same-actor fallbacks
whose noun sets intersect (non-matching skipped, applied breaks, same
threshold). At tick 22 both the `offer|anton` exact ban and the
`{laptop}` cluster ban fire — the glance-at-test-plan substitute is
rejected at selection. Regression test replays ticks 13/19/22.

**10. S5 — state/pose labels — ALREADY DONE.**
All three mechanisms exist and are wired: `describePosition`
landmark-templated labels with pose-aware at/near (patchApplier
auto-fills on movement when the model omits `state`),
`validateSitPoseSeating` (pose:sit against chair cells),
`validateStateLabel` (grammar + wrong-landmark) and
`validateStateCoherence` (state refresh on pose/prop/move). Exp-5's
examples were weak: "near the lounge sofa" is grammatical (the gate
targets stacked article+possessive), and "at Tanya's chair" followed the
pose-aware rule — the save shows Dana's pose was `sit`, not standing as
the report claims. Not re-implemented.

**11. S7 — early-abort on growing errors — PUSHED BACK (already done, stronger).**
Exp-3 item 9 is implemented as RULE-C (abort when the last two attempts
fail to improve on best-so-far) and fired 17× in exp-5 — every single
`retry_aborted` event. The requested "grows two attempts in a row" rule
is strictly weaker than RULE-C (RULE-C also aborts plateaus like
[2,2,2] that the grows-twice rule misses). Not implemented.

**12. S6 — prop stubs + applied-objectPatches measure — PARTIALLY IMPLEMENTED.**
The deterministic prop stubs already exist (`propStubForGroundingErrors`
+ in-loop and salvage repair, Exp-4 item 10); they fired 0× in exp-5
because object-wording errors never appeared *alone* (always mixed with
movement failures) — widening the stub to mixed failures would risk
patching props onto corrupt turns, so the stub is unchanged. The
measurement half was real: the harness §4 counted *proposed*
objectPatches in `consequence_completed`, not *applied* ones. Added a
true applied measure: JSON diff of `scene.objects` between the first and
last `turn_completed` snapshots (exp-5: 0, as the report says).

**13. S9/S10 — env alignment + memory precision — ALREADY DONE / DOCUMENTED.**
S9: `.env.example` was aligned with `setup:ollama` in e28a2f6 ("Align
.env.example OLLAMA_MODEL default with setup:ollama (exp2 S10)") — the
report's claim is stale; only Anton's local (git-ignored) `.env` may
still say `qwen3:14b`, which he should check. S10: the memory-precision
measurement already exists (harness §3). "Wire it to the salience gate"
is documented as *why not* (code comment in `layaTurn.ts`): the salience
gate scores event *worthiness* (is this worth remembering?), not prose
*truthfulness* — a stub can be salient and a fiction can be salient, so
wiring precision into it conflates axes. The pollution source is the
deterministic narrative→memory append, fixed at the source by the S3/S4
gates above (corrupt narratives never become memories if they never
become canonical).

## New flags

None. All fixes are unconditional deterministic correctness repairs in
the existing repair/validator family (same as the movement-repair,
clamp, and prop-stub precedents) — no new behavior-gating flags.

## Calibration notes for the next run

- The stationary downgrade commits on veto-no-step instead of retrying;
  watch that its "remains in position" narratives read honestly in history.
- The stale-enter gate assumes no modeled re-entry; scenarios with
  exits would need an entered/inside flag.
- Cluster bans are per-actor and reset on the first applied own turn,
  same as exact-key bans.
