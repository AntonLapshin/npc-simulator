# NPC Simulator — Web UI

A live, playable web interface for the NPC simulator. It is a rework of the
`prototype.html` scenario **replayer** into a simulator **console**:

* the 2.5D office scene still renders on the main canvas exactly as before;
* the transport bar (back / play / forward / scrubber / speeds) is **gone**;
* a **message composer** sits at the bottom: you play one actor (`world.userActorId`),
  everyone else is an NPC driven by the engine;
* after you submit an action, your turn resolves and NPCs auto-advance until
  control returns to you — the same flow as the terminal UI's
  `runUserTurnAndNpcs()`.

The UI never mutates world state directly: every change arrives as an
immutable `World` snapshot through adapter turn events.

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
npm run test:graphic:dom      # integration test: boots the bundle in jsdom (needs jsdom)
npm run test:graphic:render   # renders real canvas frames to tests/out/*.png
                             # (needs: npm i --no-save jsdom canvas)
```

Or standalone from this directory (`src/ui/graphic`):

```bash
npm start          # static-only dev server (offline mock scenario) → http://localhost:8123/
npm run bundle     # regenerate preview.html (self-contained single file)
npm test           # smoke + bundle + jsdom integration
node tests/dom.mjs     # integration test: boots the bundle in jsdom
node tests/render.mjs  # renders real canvas frames to tests/out/*.png
                       # (needs: npm i --no-save jsdom canvas)
```

`index.html` is the canonical entry (native ES modules). `preview.html` is a
generated single-file build for contexts without a module server (double-click,
sandboxed viewers).

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
showcase.html            isolated object gallery (Storybook-style, ?file=..&showcase=..)
preview.html             generated self-contained bundle (tools/bundle.mjs)
styles/
  base.css               theme tokens, reset, page background, shared parts
  layout.css             app shell, topbar, main/side grid
  stage.css              canvas stage, HUD chips, toggles, caption
  panels.css             side tabs: cast list, history log, JSON inspector
  composer.css           bottom message textarea + send button + status line
  showcase.css           gallery: sidebar, stage, N/E/S/W segmented control
js/
  main.js                bootstrap: adapter selection, fallback, resize/fonts
  app.js                 orchestrator: adapter events → live state → render/panels
  core/
    utils.js             math/color/canvas helpers + the 2.5D projection model
    dom.js               $ / el / highlightJSON / autogrow
    emitter.js           tiny event emitter
  data/
    staticScene.js       backwards-compat re-export (see scenes/)
    scenes/
      officeFloor3.js    bundled pretty-office scene DATA (no painters)
      index.js           scene registry: getScene(id) — no hardcoded imports
    officeScenario.js    default scenario in the engine's Scenario format + presentation
    scenarioScene.js     world objects → view scene (foreign worlds stay data-driven)
  render/
    viewOptions.js       Names / Zones toggles
    background.js        cached background layer (composes objects/* painters)
    assets.js            backwards-compat re-export (see objects/)
    objects/             ONE FILE PER OBJECT (showcase pattern — gallery source of truth)
      direction.js       shared N/E/S/W normalizer + COMPASS_VARIANTS
      index.js           registry: OBJECTS, ASSET_DRAW, showcaseFiles, variantProps
      desk.js            Desk — fixed view
      roundTable.js      RoundTable — fixed view
      chair.js           Chair — rotatable N/E/S/W
      stool.js           Stool — fixed view
      laptop.js          Laptop — rotatable N/S (+E/W aliases)
      cup.js             Mug — fixed view
      cupRow.js          Mug Row — fixed view
      papers.js          Papers — fixed view
      lamp.js            Desk Lamp — fixed view
      deskSign.js        Desk Sign — fixed view
      counter.js         Counter — fixed view
      coffeeMachine.js   Coffee Machine — fixed view
      kettle.js          Kettle — fixed view
      waterCooler.js     Water Cooler — fixed view
      cabinet.js         Cabinet — fixed view
      printer.js         Printer — fixed view
      crates.js          Crates — fixed view
      sofa.js            Sofa — rotatable N/E/S/W
      plant.js           Plant — fixed view
      wall.js            Wall — scenery
      window.js          Window — City/Hills variants
      door.js            Door — scenery
      whiteboard.js      Whiteboard — scenery
      clock.js           Clock — scenery
      poster.js          Poster — scenery
      rug.js             Rug — scenery
      zone.js            Zone — scenery
      character.js       Character — rotatable N/E/S/W (wraps character.js)
    character.js         bodies, hair, emotion faces, mood FX, name plates
    bubble.js            speech & thought bubbles with collision placement
    avatar.js            cast-panel portraits (reuses character.js)
    sceneRenderer.js     canvas host, resize, frame pipeline, generic object fallback
  showcase/              gallery app (AntonLapshin/showcase pattern)
    core.js              pure registry/select/URL codec (no DOM — unit tested)
    files.js             showcase file registration (re-exports objects registry)
    app.js               thin view-model: sidebar + stage + segmented control
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
  showcase.mjs           gallery tests: registry, URL codec, every object·variant draws
  dom.mjs                jsdom integration: boot → submit → turns → back to user
  render.mjs             visual check: canvas frames saved as PNG
```

## Object gallery (`showcase.html`)

Storybook-style isolated view over `js/render/objects/` (pattern adapted from
[AntonLapshin/showcase](https://github.com/AntonLapshin/showcase)):

```bash
npm start  # → http://localhost:8123/showcase.html
```

* sidebar lists every object (furniture → scenery → character);
* the canvas shows the object in isolation with a props readout;
* rotatable objects (chair, sofa, laptop, character) get an **N / E / S / W**
  segmented control; fixed-view objects show a "fixed view" note instead;
* selection deep-links via `?file=Chair&showcase=E` (shareable, back/forward
  safe). To add an object: create `js/render/objects/<thing>.js` exporting a
  single uniquely-named showcase object, then register it in
  `js/render/objects/index.js` — the gallery picks it up automatically.

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
fade out, and the caption mirrors the latest history entry.

## Backend contract (`httpAdapter.js`)

The UI is backend-agnostic; the Node engine only needs three routes:

```
GET  /health            → 200 when up (used for the mock fallback probe)
GET  /world             → { world, presentation? }        (World as in types.ts)
POST /action  { text }  → { world, events? }
```

`events` (optional) is an ordered array of per-turn events
`{ actorId, isUser, actionText, speech?, narrative?, world? }`; when present the
UI replays them one by one (animating each NPC turn, like the text UI's
per-turn output). Without it, a single turn event is synthesised from the last
history entry and its `"Name: "` prefix. Quoted speech in action text becomes a
bubble automatically, so even a bare world diff produces speech.

If `/health` fails, the UI falls back to the offline `MockAdapter` with a
console warning — mirroring `buildDeps()` in `textUI.ts`.

## Scenario & presentation conventions

* `data/officeScenario.js` is a plain engine `Scenario` (version, id, title,
  narrative, userActorId, order, scene, actors) — the engine's `loadScenario`
  accepts the same JSON.
* `presentation` (optional, UI-only): per-actor `{ color, role, prop, look }`
  plus `scene.name`. Missing entries get deterministic looks derived from the
  actor id (`presentation.deriveLook`), so any world renders sensibly.
* Scene object `id`s that match a static-scene asset id (`deskA1`, `counter`, …)
  are considered already painted and skipped by the renderer; anything else is
  drawn as a labelled generic box, so foreign scenes still show their objects.
* Object `x/y` are footprint **centres** in scene coordinates; the view maps
  `scene.width/height` onto the 1040×730 canvas world.

## Adding a scenario

Drop another `Scenario` JSON next to `officeScenario.js`, import it in
`main.js`, and pass it to `MockAdapter` (or serve it from your backend's
`GET /world`). Everything else — renderer, panels, composer — is data-driven.
