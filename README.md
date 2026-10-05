# NPC Simulator

Turn-based, open-ended life simulation. One scenario holds an environment,
objects, and characters. You control one character; all others are autonomous
NPCs. Each turn, one character performs an immediate, free-form action —
speech, movement, object interaction, social or emotional behavior, or any
combination. LLM engines interpret the text and update the world; a physical
validator keeps movement coherent and every step is logged.

See [`plan.md`](plan.md) for the full engineering plan.

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
- Milestones 4–5 (graphic UI, scenario editor): not started.

## Setup

```bash
npm install
cp .env.example .env   # then add your JOINGONKA_API_KEY (see https://gate.joingonka.ai/dashboard)
npm run diagnose:ai     # offline checks — expect all "PASS"
```

Optional local model:

```bash
npm run setup:laya   # install Laya weights (~808 MB)
npm run serve:laya   # serve the decision-AI endpoint
```

## Playing (Milestone 3 — text interface)

```bash
npm run start:text -- [scenario] [--mock] [--debug] [--no-autosave]
```

- `scenario` defaults to `scenarios/office.json` (you play Jeff).
- Without `--mock` the real LLM engines are used (backend from `.env`);
  if provider setup fails the UI warns and falls back to deterministic mocks.
- `--mock` forces offline deterministic engines — no network, no API key.
- `--debug` starts with the objective world + LLM traces visible.

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

## Development

```bash
npm run dev            # run src/index.ts
npm test               # vitest (88 tests: unit, integration, golden)
npm run typecheck      # tsc --noEmit
npm run diagnose:ai:live  # + live probes against JoinGonka and laya-serve
```

## Repository layout

```text
src/
  types.ts schemas.ts config.ts      # domain types, Zod schemas, defaults
  engine/                            # scenarioLoader, worldStore, turnOrchestrator,
                                     # contextBuilder, physicalValidator, patchApplier,
                                     # geometry, pathfinding, perceptionHelpers, persistence
  intelligence/                      # Proposal/Selection/Consequence interfaces
  llm/                               # providers + real LLM engines (Milestone 2)
  mocks/                             # deterministic engines (Milestone 1)
  logging/                           # Logger, LogStore, JSONL writer
  ui/text/                           # textUi.ts (CLI loop), commands.ts (Milestone 3)
  editor/ graphic/                   # Milestone 5 / 4 placeholders
scenarios/office.json                # golden office scenario
tests/{unit,integration,golden}/
logs/ saves/                         # git-ignored runtime artifacts
```
