# NPC Simulator

Turn-based, open-ended life simulation. One scenario holds an environment,
objects, and characters. You control one character; all others are autonomous
NPCs. Each turn, one character performs an immediate, free-form action —
speech, movement, object interaction, social or emotional behavior, or any
combination. The turn loop is deliberately small: one LLM **intent** call
(`{action, quote}`) → one local **Laya parse** of the action sentence →
deterministic engine **execution** (movement, speech quotes, object
manipulation — impossible things are clamped, never corrected) → one LLM
**narrate** call over the executed facts. A deterministic **director**
injects scenario incidents when the scene goes stale. Every step is logged.

See [`plan.md`](plan.md) for the original engineering plan,
[`PLAN_V2.md`](PLAN_V2.md) for the simplified turn loop, and
[`ACTION_ITEMS.md`](ACTION_ITEMS.md) for what's next.

## Running

```bash
npm install
cp .env.example .env   # optimal defaults are active; no key needed for local runs
npm run setup:ollama   # pull models + build tuned variants (npc-qwen3-14b, npc-stheno-8b)
npm run setup:laya     # Laya decision-model weights (~808 MB) for the semantic parser
```

**Text UI** (terminal — you play one character):

```bash
npm run start:text                                        # office scenario, your .env backends
npm run start:text -- --provider ollama                   # all-local Ollama
npm run start:text -- --provider ollama --model npc-stheno-8b   # fast 8B, lively turns
npm run start:text -- --mock                              # offline deterministic engines
```

**Graphic UI** (2.5D web console + scene preview):

```bash
npm start                                                 # everything: ollama + laya-serve +
                                                          # engine console (:8123) + scene preview (:8124)
npm start -- --model npc-qwen3-14b                        # same, 14B for richer prose
npm start -- --mock                                       # no models needed at all
npm start -- --dry-run                                    # print what would run, start nothing
npm start -- --help                                       # all options (ports, --engine-only, --no-debug, …)
```

**Autonomous mode** (experiments — every character is an NPC, no prompts):

```bash
npm run start:auto -- --limit-turns 20 scenarios/office-anton.json
npm run report:turns -- logs/<session>.jsonl              # generated findings table
```

`npm start` (`scripts/start.sh`) sources `.env` with auto-export, so an
Ollama daemon it launches itself picks up the tuned `OLLAMA_*` server
settings (`OLLAMA_KEEP_ALIVE=30m`, `OLLAMA_NUM_PARALLEL=1`,
`OLLAMA_FLASH_ATTENTION=1`). A system-service Ollama (e.g. `ollama.service`)
does **not** see them — for that, set them on the service itself. The
simulator only ever reads `OLLAMA_MODEL` (which model to request) despite
the prefix; everything else `OLLAMA_*` is daemon-side.

## Status

- **Milestone 1 — Engine core:** done. Deterministic turn loop, scenario
  loader, world store, context builder, physical validator, patch applier,
  geometry/pathfinding/perception helpers, mock intelligence, save/load,
  JSONL logging, golden office scenario.
- **Milestone 2 — Real LLMs:** done. Pluggable `LLMProvider`
  (hosted JoinGonka gateway + local Ollama + local Laya model), real Intent /
  Consequence engines with retry + fallback, `npm run diagnose:ai` checks.
  Superseded by the PLAN_V2 turn loop below — the old
  propose-then-pick decision stack was deleted in Phase 6.
- **Milestone 3 — Text UI:** done. Playable terminal interface
  (`src/ui/text/textUi.ts` + `commands.ts`, tested in
  `tests/unit/textUi.test.ts`).
- **Milestone 4 — Graphic UI:** done. Playable 2.5D web console adopted
  from `prototype-ui` into `src/ui/graphic/` (canvas scene + message
  composer + cast/timeline/JSON panels, offline mock adapter; see
  [`src/ui/graphic/README.md`](src/ui/graphic/README.md)).
- Milestone 5 (scenario editor): not started.

## Experiment economics (read before a long run)

Measured on a 16 GB VRAM machine (RTX 5070 Ti), all-local Ollama,
autonomous `--auto` office runs, v2 turn loop (intent → Laya parse →
execute/clamp → narrate):

| Run | Model | Mean turn | LLM calls/turn | Clean turns |
|---|---|---|---|---|
| v1 baseline (Stage 3) | qwen3:14b | **~59 s** | ~3.6 | 1/12 |
| v2 acceptance (2026-10-09) | qwen3:14b | **25.5 s** | 2.3 | 20/20 |
| v2 tuned re-run | npc-qwen3-14b | 32.0 s | 2.4 | 19/20 |
| v2 8B run | npc-stheno-8b | **~1.6 s** (telemetry; ~5 s wall) | 2.1 | 20/20 |

Notes:

- The turn cost is ~100% LLM-bound: ~2k-token prompt ingest + generation at
  ~60 tok/s on the 14B. Two calls ≈ 25 s mean, so **any narrate retry blows
  the 30 s turn budget** — p90 was 37–47 s on the 14B runs. The 8B runs
  ~1.5 s/turn with ~3.5 s/turn of loop overhead (laya calls, saves) outside
  turn telemetry.
- **`LLM_THINK=0` is belt-and-braces, not the lever.** On current Ollama
  builds qwen3 emits no `<think>` output for these prompts either way
  (verified with `npm run probe:think`, 2026-10-09); the flag stays as
  insurance. Do not spend runs re-testing it.
- **The tuned variant (`npc-qwen3-14b`) measured as a no-op** when the stock
  model already runs at 100% GPU — `num_gpu 999` has nothing to reclaim.
  Keep it (idempotent, harmless), but expect nothing from it.
- **Full GPU offload still matters.** `ollama ps` must show 100% GPU. A
  second model on the card (exp-7: `laya-serve` holding 5.8 GB) drops a 14B
  model to ~20% GPU and triples every call. `npm run diagnose:ai` flags
  VRAM squatters; serve laya on CPU (`LAYA_DEVICE=cpu`).
- **Iterate on the 8B, finalize on the 14B.** Mechanics are model-independent
  and observable at ~2–5 s/turn on `npc-stheno-8b`; the 14B only changes
  prose quality (and breaks genre less often — 0 breaks on 8B vs 4+ on 14B
  across runs, though the 8B leaks grid coordinates into prose instead).
  A 20-turn 14B run costs ~10 min of GPU time; the 8B costs ~2 min.

`--auto` prints per-turn timing and a running ETA. Rule of thumb: if the
first 3 turns average >3 min on a 14B local model, stop and run
`npm run diagnose:ai` — something is offloading to CPU.

The full experiment protocol (phase gates, what "clean" means, the
acceptance checklist) lives in [`experiments/PROTOCOL.md`](experiments/PROTOCOL.md).
Every run gets its findings table from `npm run report:turns` — never
hand-computed.

## Why the turn loop looks like this (PLAN_V2 retrospective)

Future reference — read before redesigning anything. This records what
failed, why each v2 decision was made, and where the Laya model is and
isn't effective, so we don't re-learn it.

### What didn't work (v1)

The v1 turn was a decision stack built to make an unreliable narrator
reliable: LLM proposes several action options → Laya cascade picks one →
renderability screen → re-screen → salvage → fallback chains. Eleven
rounds of prompt/retry/salvage hardening (PLAN.md) could not fix the
underlying capability mismatch: **1/12 clean turns**. The staged shakedown
then killed the cascade itself — Stage 3's cascade-vs-LLM comparison
returned NO DECISION with a damning footnote: the cascade converted
**0/10 turns** (it never ran; the test measured "LLM path + Laya latency
tax"). Per-turn economics were fatal regardless: 3–4 LLM calls plus
retries put a turn at ~60–90 s on the 14B with a 40% fallback rate.

Lesson: the stack was scar tissue. When the fix for unreliability is more
machinery around the unreliable part, delete the machinery instead.

### Why v2 is shaped the way it is

The binding constraint was set first: **a turn must complete in under 30
seconds**. At ~60 tok/s on the 14B that buys roughly two LLM calls per
turn, total. Everything else must be cheap (local) or free
(deterministic). The whole design falls out of that budget:

- **One intent call, not propose-then-pick.** The LLM does what it's good
  at (scene understanding, fluent intent → `{action, quote}`) and nothing
  else. No options list, no separate pick step.
- **Laya as parser, not decider.** The batched judge question set
  classifies the *action sentence* into structured facts. Laya never sees
  the scene — only the sentence in front of it — which kills the Stage-3
  miscalibration failure *by construction*. There is no scene-level
  classification left to get wrong.
- **The engine owns physics.** Movement (pathfinding), speech quotes
  (verbatim), object manipulation (affordances) — the renderer
  architecture proved this conclusively and v2 keeps it. Model-emitted
  coordinates are stripped and ignored.
- **Clamp, don't correct.** Impossible intents get one deterministic pass:
  contact beyond reach → recorded, never teleported; unreachable
  destination → closest reachable cell or stay; distant manipulation →
  graceful fail. Attempted-vs-executed is recorded every turn and fed to
  the narrator, so failure is narrated honestly. No correction loops,
  ever — re-asking the model is how v1 burned its budget.
- **Narrate executed facts.** The prompt is the fact list of what the
  engine actually did — not the intended action. Invention surface is
  small, so attempt-1 acceptance is high. One retry max, then
  accept-and-mark honest: a flawed paragraph beats a dead turn, and the
  `(not done)` sentinel family stays dead.
- **The director has two halves — deliberately.** Free-will NPCs drift
  into polite small talk (every run shows it). The style guide tells the
  narrator *how to handle* drama; the deterministic staleness trigger is
  the load-bearing half — exp-5 taught us that prompt-only direction
  ("do NOT repeat yourself") is politely ignored by turn 30, while
  deterministic rules are obeyed. After K stale turns the engine injects
  the next scenario `directorEvents` incident as a plain world fact. The
  LLM never decides *whether* drama happens; it only narrates it well.
  Scenario authors write the incident list; without one the director is
  off by design (and the scene will idle — that's authoring, not a bug).

### When Laya is effective — and when it isn't

**Effective:**
- Batched semantic parse of a *single action sentence* (moves? speaks?
  addressee? destination? contact?). 20/20 completions across every
  measured run, milliseconds on CPU. This is the one job that survived.
- The locomotion veto as a pure physics guard: it only ever vetoes a
  planned move it's confident about, and it fails open.
- Anything where Laya absorbs classification-shaped work so the small
  model doesn't have to — this is what makes the 8B viable at all.

**Not effective:**
- Scene-level decisions (which option is best, what the actor should do).
  Stage 3 proved 0/10 conversion; eleven hardening rounds proved the
  miscalibration can't be prompt-engineered away. Never put Laya back in
  a decider role — the failure mode is silent (it looks like it's working
  while adding only latency).
- Any path where the turn *blocks* on Laya. The parser is fail-open by
  design: Laya down → deterministic text parsers, `parser_fallback`
  event, turn completes. `parser_fallback` rate ≈ 0 is the health metric;
  if it's not ≈ 0 you're measuring the wrong thing.

**Operational:**
- Serve laya on CPU (`LAYA_DEVICE=cpu`), never on VRAM. Exp-7's
  laya-serve squatted 5.8 GB and starved qwen3:14b to 18% GPU offload,
  tripling every call. `npm run diagnose:ai` flags VRAM contention.
- `LAYA_MODE=off` disables Laya entirely (silent deterministic parsing).
  Useful for isolating parser vs model issues, not for real runs.

### Known validator blind spots (from live runs, 2026-10-09)

The prose validator polices *physical* claims — invented movement,
invented speech, wrong-subject narration. It is blind by construction to:
**genre/character breaks** (an assassin-noir paragraph for a QA engineer
passed validation — 4+ cases across runs; thin-fact turns plus "narrate
vividly" is the systematic trigger), **setting contradictions**
(cigarette in a daylight office), **social-logic errors** (introducing
yourself to the wrong person), **coordinate leaks** (`(16, 2)` in prose —
systematic on the 8B, 11/24 narratives), and **invented props** (a coffee
cup never picked up). See [`ACTION_ITEMS.md`](ACTION_ITEMS.md) for the
planned fixes.

## Setup

```bash
npm install
cp .env.example .env   # then add your JOINGONKA_API_KEY (see https://gate.joingonka.ai/dashboard)
npm run diagnose       # unified offline checks (graphic UI + AI layer) — expect all "PASS"
```

Local Ollama models (uncensored, no API key needed):

```bash
npm run setup:ollama   # install Ollama + pull both recommended models
npm run diagnose:ai    # verifies binary, server, and pulled models
```

Pulled models:

| Ollama id | Description | Size |
|---|---|---|
| `qwen3:14b` | Qwen3 14B (default, primary — used for Exp-6) | ~9.3 GB |
| `fluffy/l3-8b-stheno-v3.2` | L3 8B Stheno (legacy primary, 8K ctx) | ~4.9 GB |
| `huihui_ai/llama3.2-abliterate:3b` | Llama 3.2 3B abliterated (fast, 128K ctx) | ~2.2 GB |

Subset install: `npm run setup:ollama -- --only qwen3` or `-- --only stheno` or `-- --only llama3.2`.

Disk cost: the full pull is ~16 GB in `~/.ollama/models` (9.3 + 4.9 + 2.2).
`setup:ollama` also builds tuned variants (`npc-qwen3-14b`, `npc-stheno-8b`)
via Modelfile — full GPU offload (`num_gpu 999`), right-sized context
(`num_ctx 4096`), larger prefill batches. Keep weights resident between
turns with `OLLAMA_KEEP_ALIVE=30m` on the server (`keep_alive` is not a
Modelfile parameter). The
variants share the base weights, so they cost no extra disk.

### Local-model throughput (RTX 5070 Ti / 16 GB VRAM)

The levers, in order of impact (re-measured for the v2 loop, 2026-10-09):

1. **Few calls, not faster calls.** The v2 turn is exactly 2 LLM calls
   (intent + narrate) + 1 local Laya parse by design — down from 3–4 plus
   retries in v1. At ~60 tok/s on the 14B, two calls ≈ 25 s mean, so any
   narrate retry blows the 30 s turn budget. Attempt-1 quality is the
   whole game.
2. **Full GPU offload** — `ollama ps` must show 100% GPU for the active
   model. A VRAM squatter (exp-7: `laya-serve` holding 5.8 GB) drops a 14B
   model to ~20% GPU and triples every call. Serve laya on CPU.
3. **`LLM_THINK=0`** — belt-and-braces: on current Ollama builds qwen3
   emits no `<think>` for these prompts either way (verified
   2026-10-09). Kept as insurance; not the lever it was in exp-6.
4. **Right-sized context** — engine prompts measure ~2k real tokens
   (Ollama tokenizer), so `num_ctx 4096` (the default) is already
   correct; larger only burns VRAM on KV cache.
5. **Model-aware timeouts** — `npm run diagnose:ai:live` times the
   configured model, records the median to
   `~/.cache/npc-simulator/llm-latency.json`, and the engine derives the
   default `LLM_TIMEOUT_MS` from it (4× median, 60 s…600 s). An explicit
   `LLM_TIMEOUT_MS` always wins. Calls slower than half the timeout are
   logged as `<module>_slow_call` warnings.

All of it lives in one place: `.env` (copy from `.env.example`, which
ships the optimal values active). Note the split: `LLM_*` vars are read
by the simulator, while `OLLAMA_*` vars (`OLLAMA_KEEP_ALIVE=30m`,
`OLLAMA_NUM_PARALLEL=1`, `OLLAMA_FLASH_ATTENTION=1`) are read by the
`ollama serve` daemon — start it via `npm run ollama:serve`
(`scripts/start-ollama.sh`), which exports the `OLLAMA_*` lines from
`.env` into the server's environment. Starting ollama any other way
silently ignores them.

Note on GPU utilization: 20–30% SM occupancy during generation is normal
for batch=1 decoding (memory-bandwidth-bound, not compute-bound) — the
metric that matters is tokens/sec and 100% GPU offload, not the
utilization percentage.

Optional legacy local model:

```bash
npm run setup:laya   # install Laya weights (~808 MB)
npm run serve:laya   # serve the decision-AI endpoint
```

## Playing (Milestone 3 — text interface)

```bash
npm run start:text -- [scenario] [--provider <backend>] [--model <id>] [--base-url <url>] [--mock] [--debug] [--no-autosave]
```

- `scenario` defaults to `scenarios/office.json` (you play Jeff).
- Without `--mock` the real LLM engines are used (backend from `.env`);
  if provider setup fails the UI warns and falls back to deterministic mocks.
- `--provider` picks the backend for this run: `joingonka` (default),
  `laya-local`, or `ollama` (alias `--backend`). Overrides `LLM_BACKEND`.
- `--model` picks the model id for the active provider
  (`JOINGONKA_MODEL` / `LAYA_MODEL` / `OLLAMA_MODEL`).
- `--base-url` overrides the provider endpoint
  (`JOINGONKA_BASE_URL` / `LAYA_BASE_URL` / `OLLAMA_BASE_URL`).
- `--mock` forces offline deterministic engines — no network, no API key.
- `--debug` starts with the objective world + LLM traces visible.

Provider examples:

```bash
# Hosted gateway (needs JOINGONKA_API_KEY in .env)
npm run start:text -- --provider joingonka

# Local Ollama, default Qwen3 14B model (needs `npm run setup:ollama` first)
npm run start:text -- --provider ollama

# Local Ollama, fast 3B abliterated model
npm run start:text -- --provider ollama --model huihui_ai/llama3.2-abliterate:3b

# Same via environment (no flags)
LLM_BACKEND=ollama OLLAMA_MODEL=qwen3:14b npm run start:text
```

Example session (mock engines):

```text
> look
=== Office: Jeff is a new coworker ===
Tick 0 | turn 0 | current actor: jeff (you)
...

> action: Hey guys, I'm a new team member, my name is Jeff!
--- Tick 0 — you (Jeff) acted ---
  Tick 0 - Jeff: Hey guys, I'm a new team member, my name is Jeff!
  ...

> next            # Ana's NPC turn runs automatically — no input needed
--- Tick 1 — Ana (ana) acted ---
...

> next            # your turn again: pick a suggestion number or type anything
Suggested actions (type the number, or any free-form text):
  [1] Stay where you are and observe the situation.
  [2] Walk toward Ana and greet them.
  ...
action (number, 'action: <text>', or free text): 2
```

### Commands

```text
start [path]              Load a scenario JSON (default: scenarios/office.json).
next                      Run one turn (NPC turns need no input; yours prompts).
action: <text>            Free-form action for your turn. Any text is accepted.
look                      Scene panel (title, tick, current actor, narrative, nearby).
look actor <id>           Actor panel (state, emotion, goal, memories, beliefs, relations).
look object <id>          Object panel (description, rectangle, flags).
memories [actor]          Show memories (default: your actor).
beliefs [actor]           Show beliefs (default: your actor).
relationships [actor]     Show relationships (default: your actor).
history [n]               World history (default: last 10).
save [path]               Save world JSON (default: saves/<id>_tick<tick>.json).
load <path>               Load a saved world JSON.
log tail [n]              Recent log entries.
log module <module> [n]   Filter logs by module (turn, intent, laya, consequence, ...).
log tick <tick> [n]       Filter logs by tick.
debug on|off              Debug view: objective world + LLM prompts/responses/reasoning.
help                      Show help.
quit                      Exit.
```

Notes:

- The UI never mutates world state directly — it forwards action text to the
  engine (`runTurn`) and renders the consequence narrative.
- Default view is subjective (what your actor perceives); `debug on` reveals
  the objective world and full LLM traceability.
- No content filtering is applied by the engine or the UI; only physically
  impossible mutations are rejected and retried.
- Session logs go to `logs/text_<session>.jsonl`; autosaves to `saves/`.

### Autonomous mode (no user — all characters are NPCs)

For experiments where nobody plays: every character — including the one the
scenario names as the user — runs the NPC pipeline (intent → Laya parse →
execute/clamp → narrate). There are no prompts and no REPL; the loop stops
after the turn cap, prints the final scene, saves the world, and exits.

```bash
# 30 turns (default cap), mock engines, office scenario
npm run start:auto -- --mock

# 60 turns, local Ollama, your scenario, then evaluate the saved world
npm run start:auto -- --limit-turns 60 --provider ollama scenarios/office-anton.json
npm run eval:run-quality -- saves/office-anton_tick60.json
```

Flags: `--auto` (also reachable as `npm run start:text -- --auto …`) and
`--limit-turns <n>` (positive integer, default 30; requires `--auto`).
All other `start:text` flags (`--provider`, `--model`, `--base-url`,
`--mock`, `--debug`, `--no-autosave`) apply as usual, so the same
`.env` / tier / Laya configuration used in the interactive UI drives the
autonomous run.

Notes:

- Engine-wise this is `forceAllNpc` on `EngineDependencies`: `runTurn`
  never takes the user path, so no `getUserAction` prompt can appear —
  every turn gets NPC engine-tier routing and the liveness floor.
- Every turn's narrative is printed (no perceivability filtering — in an
  experiment you want the full log).
- The run saves to `saves/<scenario>_tick<tick>.json` on completion (and
  autosaves per turn unless `--no-autosave`), so a Ctrl-C'd run can be
  resumed with `load` in the interactive UI or re-run from the save.
- Exit code is 0 when all requested turns ran, 1 when the run stopped
  early (engine-reported turn failure or crash).

## Playing (Milestone 4 — graphic interface)

```bash
npm run start:graphic        # static dev server → http://localhost:8123/
npm run bundle:graphic       # regenerate src/ui/graphic/preview.html (self-contained single file)
npm run test:graphic         # smoke + bundle + jsdom integration (needs jsdom for the dom step)
npm run test:graphic:smoke   # headless engine-core checks, no DOM
npm run test:graphic:render  # renders canvas frames to src/ui/graphic/tests/out/*.png
                             # (needs: npm i --no-save jsdom canvas)
```

`src/ui/graphic/index.html` is the canonical entry (native ES modules).
`src/ui/graphic/preview.html` is a generated single-file build for contexts
without a module server (double-click, sandboxed viewers).

The graphic side is split in two: `src/ui/graphic/` is a thin console
(composer, cast/timeline/JSON panels, adapters, engine server) while the
actual 2.5D scene — objects, characters, renderer, gallery + scene preview —
lives in the sibling project `../npc-simulator-ui`, linked as
`src/ui/graphic/ui-lib` and bridged through `src/ui/graphic/js/scene/ui.js`.
That project serves separately for visuals-only work:

```bash
cd ../npc-simulator-ui && npm start   # → http://localhost:8123/showcase.html (object gallery)
                                      # → http://localhost:8123/scene.html (raw scene preview)
```

Query parameters (console):

| param | effect |
|---|---|
| `?backend=url` | use a real engine server (`GET /health`, `GET /world`, `POST /action`); probes `/health` first, falls back to the offline mock adapter |
| `?mock=1` | force the offline mock engine |
| `?fast=1` | mock turns resolve with zero artificial delay |

Same turn flow as the text UI: you play one actor, the composer submits
free-form action text, NPC turns auto-advance until control returns to you.
Full details (layout, turn/data flow, backend contract, presentation
conventions) live in [`src/ui/graphic/README.md`](src/ui/graphic/README.md).

## Development

```bash
npm run dev            # run src/index.ts
npm test               # vitest (unit, integration, golden)
npm run test:graphic   # graphic UI: smoke + bundle + jsdom dom test
npm run typecheck      # tsc --noEmit
npm run diagnose          # unified: graphic-UI availability + offline AI checks
npm run diagnose:ai       # offline: binary + server + model checks (JoinGonka, Laya, Ollama)
npm run diagnose:ai:live  # + live probes against JoinGonka, laya-serve, and Ollama
npm run diagnose:ui       # graphic-UI availability only (sibling npc-simulator-ui + console link)
```

## Repository layout

```text
src/
  types.ts schemas.ts config.ts      # domain types, Zod schemas, defaults
  util/                              # shared low-level helpers (errors, .env loader)
  engine/                            # scenarioLoader, worldStore, contextBuilder,
                                     # patchApplier, geometry, pathfinding,
                                     # perceptionHelpers, persistence,
                                     # deterministicSemantics, semanticParser,
                                     # clampPolicy, layaWiring
    turnOrchestrator.ts              # turn loop: intent → Laya parse →
                                     # execute/clamp → narrate → apply
    turnLiveness.ts                  # NPC liveness floor (fallback streak)
    turnOutcomes.ts                  # per-turn outcome accounting (SLO)
    physicalValidator.ts             # validateConsequence entry point
    validate/                        # focused validation check groups:
                                     # movement, narrative, objects, speech,
                                     # textUtils (id suggestions)
  intelligence/                      # Intent/Consequence/SemanticJudge
                                     # interfaces (types.ts)
  llm/                               # providers + real LLM engines (Milestone 2)
  mocks/                             # deterministic engines (Milestone 1)
  logging/                           # Logger, LogStore, JSONL writer, storyTrace
   ui/text/                           # textUi.ts (CLI loop), commands.ts (Milestone 3)
   ui/graphic/                        # thin graphic console (Milestone 4):
                                      # index.html + js/{app,main,sceneBridge,sim,ui}
                                      # + styles/ + tools/ + tests/
                                      # scene layer via ui-lib/ → ../../../../npc-simulator-ui
                                      # (see src/ui/graphic/README.md)
scenarios/office.json                # golden office scenario (you play Jeff)
scenarios/office-anton.json          # office scenario with Anton as the user
                                     # character (default for `npm start`)
tests/{unit,integration,golden}/
logs/ saves/                         # git-ignored runtime artifacts
../npc-simulator-ui/                 # sibling visual scene project (objects,
                                     # characters, renderer, showcase + scene preview;
                                     # see ../npc-simulator-ui/README.md)
```
