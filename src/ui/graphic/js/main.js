// main.js — bootstrap: pick the adapter, build the UI, start the app.
//
// Query parameters (mirrors the text UI flags where sensible):
//   ?backend=<url>   use a real engine server (GET /health, GET /world,
//                    POST /action). If the probe fails the UI falls back
//                    to the offline mock adapter with a console warning —
//                    the same fail-open behaviour as textUI's buildDeps().
//   ?mock=1          force the offline mock adapter.
//   ?fast=1          mock turns resolve without artificial delays.
//
// When the page is served by the engine server (npm run start:graphic),
// the server injects window.__NPC_ENGINE__ and the UI connects back to the
// same origin automatically — the scenario and LLM engines from the CLI
// (e.g. scenarios/office-anton.json --provider ollama …) drive the view.
// Static opens (preview.html, file://) have no flag and keep the offline
// mock, with no probe delay.

import { STATIC_SCENE } from "./data/staticScene.js";
import { OFFICE_SCENARIO } from "./data/officeScenario.js";
import { SceneRenderer } from "./render/sceneRenderer.js";
import { MockAdapter } from "./sim/mockAdapter.js";
import { HttpAdapter } from "./sim/httpAdapter.js";
import { App } from "./app.js";
import { $ } from "./core/dom.js";
import { Topbar } from "./ui/topbar.js";
import { StageHud } from "./ui/stageHud.js";
import { CastPanel } from "./ui/castPanel.js";
import { LogPanel } from "./ui/logPanel.js";
import { WorldPanel } from "./ui/worldPanel.js";
import { Composer } from "./ui/composer.js";

async function pickAdapter(params) {
  const backend = params.get("backend");
  const forceMock = params.get("mock") === "1";
  if (forceMock) {
    return new MockAdapter(OFFICE_SCENARIO, {
      stageDelayMs: params.get("fast") === "1" ? 0 : 420,
    });
  }
  if (backend) {
    const ok = await HttpAdapter.probe(backend);
    if (ok) {
      console.log(`[main] using engine backend: ${backend}`);
      return new HttpAdapter({ baseUrl: backend });
    }
    console.warn(
      `[main] backend '${backend}' unreachable — falling back to mock engines. Add ?mock=1 to silence this.`,
    );
  } else if (typeof window !== "undefined" && window.__NPC_ENGINE__) {
    // Served by `npm run start:graphic` — the same origin IS the engine
    // (scenario + providers come from the server CLI). No probe needed:
    // the page could not have loaded if the server were down.
    console.log(
      `[main] using same-origin engine backend (${window.__NPC_ENGINE__.engine || "engine"}) — scenario: ${window.__NPC_ENGINE__.scenario || "?"}`,
    );
    return new HttpAdapter({ baseUrl: "" });
  }
  return new MockAdapter(OFFICE_SCENARIO, {
    stageDelayMs: params.get("fast") === "1" ? 0 : 420,
  });
}

async function main() {
  const params = new URLSearchParams(location.search);
  const adapter = await pickAdapter(params);

  /* renderer + HUD */
  const renderer = new SceneRenderer($("scene"), STATIC_SCENE);
  const hud = new StageHud({
    onToggleNames: (on) => {
      renderer.setNames(on);
      app.invalidate();
    },
    onToggleZones: (on) => {
      renderer.setZones(on);
      app.invalidate();
    },
  });

  /* panels + composer (submit handler is wired by App.start) */
  const composer = new Composer({ onSubmit: () => {} });
  const app = new App({
    adapter,
    renderer,
    staticScene: STATIC_SCENE,
    topbar: new Topbar(),
    hud,
    castPanel: new CastPanel($("castList")),
    logPanel: new LogPanel($("logList"), $("logCount")),
    worldPanel: new WorldPanel($("subtabs"), $("jsonOut")),
    composer,
  });

  /* responsive canvas */
  try {
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        renderer.resize();
        app.invalidate();
      }).observe($("stage"));
    }
  } catch (err) {
    console.error("[resize-observer]", err);
  }
  window.addEventListener("resize", () => {
    renderer.resize();
    app.invalidate();
  });

  /* repaint once webfonts land so canvas text metrics are final */
  const fontsReady = document.fonts?.ready ?? Promise.resolve();
  fontsReady
    .then(() => {
      renderer.repaintBackground();
      app.invalidate();
    })
    .catch(() => {});

  await app.start();
  console.log(
    `[main] NPC Simulator UI ready — engines: ${adapter.kind === "http" ? adapter.label : "MOCK (deterministic, offline)"}`,
  );
}

main().catch((err) => {
  console.error("[boot]", err);
  const hint = $("bootError");
  if (hint) hint.textContent = `Boot failed: ${err instanceof Error ? err.message : String(err)}`;
});
