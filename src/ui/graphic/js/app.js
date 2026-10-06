// app.js — wires adapters, live state, renderer and UI panels together.
//
// Data flow (one direction, like the text UI):
//   composer submit → adapter.sendUserAction(text)
//     adapter emits "progress" → composer/HUD status line
//     adapter emits "turn"     → liveState.applyTurn (tweens/bubbles/caption)
//                              → log/cast/tick panels refresh
//   rAF loop → liveState.frame(dt) → renderer.render(snapshot) when dirty
//
// The app never mutates World objects; adapters own simulation truth.

import { LiveState } from "./sim/liveState.js";
import { $ } from "./core/dom.js";

export class App {
  /**
   * @param {object} parts
   *   adapter   {load, sendUserAction, on, kind, label}
   *   renderer  SceneRenderer
   *   topbar    Topbar
   *   hud       StageHud
   *   castPanel CastPanel
   *   logPanel  LogPanel
   *   worldPanel WorldPanel
   *   composer  Composer
   *   staticScene STATIC_SCENE (for the JSON inspector)
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.live = new LiveState();
    this.world = null;
    this._needsRender = true;
    this._lastCaption = null;
    this._lastTs = 0;
    this._onTurn = this._onTurn.bind(this);
    this._onProgress = this._onProgress.bind(this);
  }

  async start() {
    /* ── load the initial world ─────────────────────────────────── */
    const { world, presentation } = await this.adapter.load();
    this.world = world;
    this.live.init(world, presentation);

    this._colorOf = (actorId) => this.live.visualActor(actorId)?.color || "#8fa0c0";
    this.logPanel.colorOf = this._colorOf;

    /* ── static UI ──────────────────────────────────────────────── */
    this.topbar.setScenario(world.title);
    this.topbar.setTick(world.tick);
    this.topbar.setCast(world.actors.length);
    this.topbar.setEngine(this.adapter.label, { mock: this.adapter.kind !== "http" });
    this.hud.setSceneName(presentation?.scene?.name || world.title);

    const me = world.actors.find((a) => a.id === world.userActorId);
    this.composer.setActorName(me?.name);
    this.hud.setLive(me?.name);
    this.hud.setCaption(world.narrative);

    this.castPanel.build(this.live);
    this.castPanel.sync(this.live, world);
    this.logPanel.reset(world);
    this.worldPanel.setData({
      world,
      live: () => this.live.snapshot(),
      scene: this.staticScene,
    });
    this.worldPanel.show();

    /* ── adapter events ─────────────────────────────────────────── */
    this.adapter.on("progress", this._onProgress);
    this.adapter.on("turn", this._onTurn);

    /* ── composer submit ────────────────────────────────────────── */
    this.composer.onSubmit = (text) => this._submit(text);

    /* ── side panel tabs ────────────────────────────────────────── */
    document.querySelector(".tabs").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("on"));
      document.querySelectorAll(".pane").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      $("pane-" + b.dataset.pane).classList.add("on");
      if (b.dataset.pane === "data") this.worldPanel.show();
    });

    /* ── first frame + loop ─────────────────────────────────────── */
    this.renderer.resize();
    this._needsRender = true;
    requestAnimationFrame((ts) => this._loop(ts));
    this.composer.focus();
  }

  async _submit(text) {
    this.composer.setBusy(true, `resolving ${text.length > 40 ? text.slice(0, 40) + "…" : text}`);
    this.hud.setBusy("your turn…");
    try {
      this.world = await this.adapter.sendUserAction(text);
      this._syncPanels();
      const me = this.world.actors.find((a) => a.id === this.world.userActorId);
      this.hud.setLive(me?.name);
      this.composer.setBusy(false);
    } catch (err) {
      console.error("[turn]", err);
      this.hud.setLive();
      this.composer.setError(`Turn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  _onProgress(ev) {
    this.composer.setProgress(ev.message);
    this.hud.setBusy(ev.message);
  }

  _onTurn(ev) {
    this.world = ev.world;
    this.live.applyTurn(ev);
    this.logPanel.append(ev.actionText, ev.world);
    this._syncPanels();
    this._needsRender = true;
  }

  _syncPanels() {
    this.topbar.setTick(this.world.tick);
    this.castPanel.sync(this.live, this.world);
    this.worldPanel.setData({ world: this.world });
    if (this.worldPanel.visible) this.worldPanel.show();
  }

  /** rAF loop: advance tweens/bubbles, repaint only when dirty. */
  _loop(ts) {
    requestAnimationFrame((t) => this._loop(t));
    try {
      const dt = this._lastTs ? Math.min((ts - this._lastTs) / 1000, 0.1) : 0;
      this._lastTs = ts;
      const animating = this.live.frame(dt);
      const caption = this.live.caption;
      if (caption !== this._lastCaption) {
        this._lastCaption = caption;
        this.hud.setCaption(caption);
      }
      if (animating || this._needsRender) {
        this._needsRender = false;
        const snap = this.live.snapshot();
        this.renderer.render(snap);
        if (this.worldPanel.visible && this.worldPanel.tab === "live") {
          this.worldPanel.setData({ live: snap });
          this.worldPanel.show();
        }
      }
    } catch (err) {
      console.error("[loop]", err);
    }
  }

  /** External hook (resize observer, fonts ready…) — force a repaint. */
  invalidate() {
    this._needsRender = true;
  }
}
