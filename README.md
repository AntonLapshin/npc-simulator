# NPC Simulator

Turn-based, open-ended life simulation. One scenario holds an environment,
objects, and characters. You control one character; all others are autonomous
NPCs. Each turn, one character performs an immediate, free-form action —
speech, movement, object interaction, social or emotional behavior, or any
combination. LLM engines interpret the text and update the world; a physical
validator keeps movement coherent and every step is logged.

See [`plan.md`](plan.md) for the full engineering plan.

## Quick start (everything at once)

```bash
npm install
npm start
```

`npm start` (`scripts/start.sh`) brings up the whole stack and runs the
engine-backed graphic console in the foreground:

1. ensures the Ollama server is up (`ollama serve`, started detached if needed),
2. ensures `laya-serve` is up on `:8000` (started detached if installed —
   skipped with a warning when `npm run setup:laya` was never run),
3. serves the sibling `../npc-simulator-ui` gallery/preview on
   `http://localhost:8124/`,
4. runs the engine console on `http://localhost:8123/` with these defaults:

```text
scenarios/office-anton.json --provider ollama --model qwen3:14b --debug
```

Everything is overridable without editing files — flags are forwarded to
`npm run start:graphic`, sidecars can be skipped, ports moved:

```bash
npm start -- --help                                                # all options
npm start -- --dry-run                                             # print what would run, start nothing
npm start -- --model huihui_ai/llama3.2-abliterate:3b               # fast 3B model, same scenario
npm start -- scenarios/office.json --provider joingonka            # different scenario/backend
npm start -- --mock                                                # offline deterministic engines
npm start -- --no-debug                                            # hide objective world + LLM traces
npm start -- --port 8123 --ui-port 8124                           # move either web server
npm start -- --engine-only                                         # skip ollama/laya/UI management
```

Already-running servers are reused, never duplicated; only processes this
script started are torn down on Ctrl-C. Env equivalents: `ENGINE_PORT` /
`UI_PORT` (= `--port` / `--ui-port`), `OLLAMA_HOST`, `LAYA_SERVE_URL`.

## Status

- **Milestone 1 — Engine core:** done. Deterministic turn loop, scenario
  loader, world store, context builder, physical validator, patch applier,
  geometry/pathfinding/perception helpers, mock intelligence, save/load,
  JSONL logging, golden office scenario.
- **Milestone 2 — Real LLMs:** done. Pluggable `LLMProvider`
  (hosted JoinGonka gateway + local Laya model), real Proposal / Selection /
  Consequence engines with retry + fallback, `npm run diagnose:ai` checks.
- **Milestone 3 — Text UI:** done. Playable terminal interface
  (`src/ui/text/textUi.ts` + `commands.ts`, tested in
  `tests/unit/textUi.test.ts`).
- **Milestone 4 — Graphic UI:** done. Playable 2.5D web console adopted
  from `prototype-ui` into `src/ui/graphic/` (canvas scene + message
  composer + cast/timeline/JSON panels, offline mock adapter; see
  [`src/ui/graphic/README.md`](src/ui/graphic/README.md)).
- Milestone 5 (scenario editor): not started.

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
log module <module> [n]   Filter logs by module (turn, proposal, selection, ...).
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
                                     # actionSemantics, deterministicSemantics,
                                     # movementAssist
    turnOrchestrator.ts              # turn loop: proposal → selection →
                                     # consequence → validate → apply
    turnSalvage.ts                   # degraded-path salvage tiers + honest notes
    turnLiveness.ts                  # NPC liveness floor (fallback streak)
    turnOutcomes.ts                  # per-turn outcome accounting (SLO)
    physicalValidator.ts             # validateConsequence entry point
    validate/                        # focused validation check groups:
                                     # movement, narrative, objects, speech,
                                     # textUtils (id suggestions)
  intelligence/                      # Proposal/Selection/Consequence/SemanticJudge
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
