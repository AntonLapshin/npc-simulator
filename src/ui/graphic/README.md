# NPC Simulator — Graphic Console (thin layer)

A live, playable web console for the NPC simulator:

* a **message composer** at the bottom: you play one actor
  (`world.userActorId`), everyone else is an NPC driven by the engine;
* after you submit an action, your turn resolves and NPCs auto-advance until
  control returns to you — the same flow as the terminal UI's
  `runUserTurnAndNpcs()`;
* side panels: live **cast** rows, **timeline** log, **JSON** inspector.

The console never mutates world state directly: every change arrives as an
immutable `World` snapshot through adapter turn events.

The 2.5D scene itself is **not** implemented here. It is rendered by the
sibling project [`npc-simulator-ui`](../../../npc-simulator-ui/README.md)
(objects, characters, scene renderer, gallery + scene preview), linked as
`ui-lib/` (`src/ui/graphic/ui-lib → ../../../../npc-simulator-ui`).
`js/scene/ui.js` is the single bridge module: it re-exports `SceneRenderer`,
`drawAvatar`, canvas utils and the bundled office scene for the console.
Visuals work — polishing objects/characters/variants, adding new objects —
happens over there (`npm start` in that project serves its showcase and
scene preview independently, no engine needed).

If `ui-lib/` dangles, the sibling checkout is missing — run `npm run
diagnose` from the repository root (it checks graphic-UI availability).

---

## Run it

From the repository root:

```bash
# Engine-backed (same flags as the text UI — scenario + providers drive the view):
npm run start:graphic -- scenarios/office-anton.json --provider ollama --model fluffy/l3-8b-stheno-v3.2 --debug
# → http://localhost:8123/ renders Anton/Tanya/Dana via the real engine,
#   no ?backend needed (the page auto-connects to the serving origin).
npm run bundle:graphic       # regenerate preview.html (self-contained single file)
npm run test:graphic         # smoke + bundle + jsdom integration
npm run test:graphic:smoke   # headless smoke tests (engine core, no DOM)
npm run test:graphic:dom     # integration test: boots the bundle in jsdom (needs jsdom)
npm run test:graphic:render  # renders real canvas frames to tests/out/*.png
                             # (needs: npm i --no-save jsdom canvas)
```

Or standalone from this directory (`src/ui/graphic`):

```bash
npm start          # static-only dev server (offline mock scenario) → http://localhost:8123/
npm run bundle     # regenerate preview.html (self-contained single file)
npm test           # smoke + bundle + jsdom integration
npm run test:uilib # object-gallery tests from the sibling ui project
```

`index.html` is the canonical entry (native ES modules). `preview.html` is a
generated single-file build for contexts without a module server
(double-click, sandboxed viewers) — it inlines the console plus the scene
code pulled through `js/scene/ui.js`.

Query parameters:

| param          | effect                                                              |
| -------------- | ------------------------------------------------------------------- |
| `?backend=url` | use a real engine server (see contract below); probes `/health` first |
| `?mock=1`      | force the offline mock engine                                         |
| `?fast=1`      | mock turns resolve with zero artificial delay                         |

---

## Project layout

```
index.html               DOM shell: stage + composer + side panels
preview.html             generated self-contained bundle (tools/bundle.mjs)
ui-lib/                  link → ../../../../npc-simulator-ui (the scene layer)
styles/
  base.css               theme tokens, reset, page background, shared parts
  layout.css             app shell, topbar, main/side grid
  stage.css              canvas stage, HUD chips, toggles, caption
  panels.css             side tabs: cast list, history log, JSON inspector
  composer.css           bottom message textarea + send button + status line
js/
  main.js                bootstrap: adapter selection, fallback, resize/fonts
  app.js                 orchestrator: adapter events → live state → render/panels
  scene/
    ui.js                THE bridge: re-exports SceneRenderer et al from ui-lib
  core/
    dom.js               $ / el / highlightJSON / autogrow
    emitter.js           tiny event emitter
  data/
    officeScenario.js    default scenario in the engine's Scenario format + presentation
    scenarioScene.js     world objects → view scene (foreign worlds stay data-driven)
  sim/
    textParse.js         quote/thought recovery from free-form action text
    presentation.js      look/color resolution + world→view coordinate mapping
    liveState.js         visual state: movement tweens, timed bubbles, caption
    mockAdapter.js       offline deterministic engine stand-in (turn contract)
    httpAdapter.js       real-backend client (GET /world, POST /action)
  ui/
    topbar.js            scenario / tick / cast / engine pills
    stageHud.js          status chip (LIVE vs thinking…), scene chip, caption, toggles
    castPanel.js         live cast rows: avatar, emotion chip, last line, YOU badge
    logPanel.js          world.history feed ("Name: action text" entries)
    worldPanel.js        JSON inspector: world / live / scene
    composer.js          textarea, Enter/Shift+Enter, busy + progress + error states
tools/
  bundle.mjs             builds preview.html (import graph → one classic script)
  serve.mjs              zero-dependency static server
tests/
  smoke.mjs              engine-core tests (mock turns, tweens, parsing)
  dom.mjs                jsdom integration: boot → submit → turns → back to user
  render.mjs             visual check: canvas frames saved as PNG
```

Everything under `js/render/`, `js/showcase/`, `js/data/scenes/`,
`showcase.html` and the object gallery used to live here; they were extracted
into `npc-simulator-ui` (see its README for the object/showcase/scene docs).

## Turn / data flow

```
composer submit ──▶ adapter.sendUserAction(text)
                      │  "progress" {actorId, stage, message}
                      │      → composer status line + HUD chip (e.g. "maya is choosing an action… (3s)")
                      │  "turn" {world, actorId, isUser, actionText, speech?}
                      ▼
                    app._onTurn
                      ├─ liveState.applyTurn   → tweens movement, shows bubbles, sets caption
                      ├─ logPanel.append       → history feed
                      ├─ castPanel.sync        → avatars, emotions, last lines
                      └─ topbar tick           → tick counter
                    rAF loop: liveState.frame(dt) → renderer.render(snapshot) when dirty
```

`LiveState` exists because engine patches are instantaneous while the scene
should feel alive: an actor whose `x/y` changed gets an eased tween (duration
scales with distance), speech bubbles live for `2.6–9s` depending on length and
fade out, and the caption mirrors the latest history entry. The `renderer`
here is `SceneRenderer` from `npc-simulator-ui` (via `js/scene/ui.js`); the
snapshot it receives (`{ chars, bubbles, objects }`) is the raw-input
contract documented in that project's README.

## Backend contract (`httpAdapter.js`)

The console is backend-agnostic; the Node engine only needs three routes:

```
GET  /health            → 200 when up (used for the mock fallback probe)
GET  /world             → { world, presentation? }        (World as in types.ts)
POST /action  { text }  → { world, events? }
```

`events` (optional) is an ordered array of per-turn events
`{ actorId, isUser, actionText, speech?, narrative?, world? }`; when present the
console replays them one by one (animating each NPC turn, like the text UI's
per-turn output). Without it, a single turn event is synthesised from the last
history entry and its `"Name: "` prefix. Quoted speech in action text becomes a
bubble automatically, so even a bare world diff produces speech.

If `/health` fails, the console falls back to the offline `MockAdapter` with a
console warning — mirroring `buildDeps()` in `textUI.ts`.

## Scenario & presentation conventions

* `data/officeScenario.js` is a plain engine `Scenario` (version, id, title,
  narrative, userActorId, order, scene, actors) — the engine's `loadScenario`
  accepts the same JSON.
* `presentation` (optional, UI-only legacy): per-actor `{ color, role, prop, pose, look }`
  plus `scene.name`. Actor appearance now lives on the actor itself
  (`color, pose, prop, look` — the npc-simulator-ui raw `chars` contract);
  precedence is actor fields → `presentation` block → deterministic looks
  derived from the actor id (`presentation.deriveLook`), so any world renders sensibly.
* The painted room comes from `npc-simulator-ui` scenes for the bundled
  office, or from `data/scenarioScene.js` (world objects → view scene) for
  foreign worlds; the renderer draws anything unrecognised as a labelled
  generic box.
* Object `x/y` are footprint **centres** in scene coordinates; the view maps
  `scene.width/height` onto the 1040×730 canvas world.

## Adding a scenario

Drop another `Scenario` JSON next to `officeScenario.js`, import it in
`main.js`, and pass it to `MockAdapter` (or serve it from your backend's
`GET /world`). Everything else — renderer, panels, composer — is data-driven.
To add or polish visuals (objects, characters, scenes), work in
`npc-simulator-ui` instead.
