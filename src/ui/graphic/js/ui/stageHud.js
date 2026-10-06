// ui/stageHud.js — overlays on the canvas stage: status chip, scene chip,
// Names/Zones toggles and the bottom caption. The status chip replaces the
// prototype's PAUSED/PLAYING transport state with turn state
// ("LIVE · your turn" vs "MAYA IS THINKING…").

import { $ } from "../core/dom.js";

export class StageHud {
  /**
   * @param {object} handlers { onToggleNames(bool), onToggleZones(bool) }
   */
  constructor(handlers = {}) {
    this.stateEl = $("hudState");
    this.recEl = $("recDot");
    this.sceneEl = $("hudScene");
    this.captionEl = $("captionText");
    this.tgNames = $("tgNames");
    this.tgZones = $("tgGrid");

    this.tgNames.addEventListener("click", (e) => {
      const on = !this.tgNames.classList.contains("on");
      this.tgNames.classList.toggle("on", on);
      handlers.onToggleNames?.(on);
    });
    this.tgZones.addEventListener("click", (e) => {
      const on = !this.tgZones.classList.contains("on");
      this.tgZones.classList.toggle("on", on);
      handlers.onToggleZones?.(on);
    });
  }

  setSceneName(name) {
    this.sceneEl.textContent = name || "—";
  }

  /** Idle state: it's the user's turn. */
  setLive(userLabel) {
    this.stateEl.textContent = `LIVE · ${userLabel ? userLabel + "'s turn" : "your turn"}`;
    this.recEl.classList.remove("busy");
  }

  /** Busy state: an actor's turn is resolving. */
  setBusy(message) {
    this.stateEl.textContent = (message || "thinking…").toUpperCase();
    this.recEl.classList.add("busy");
  }

  setCaption(text) {
    this.captionEl.textContent = text || "—";
  }
}
