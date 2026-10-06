// ui/worldPanel.js — "JSON" tab: live inspector with three sub-views
// (world = engine state, live = render-side view state, scene = static
// office layout). Re-renders on demand; only when the pane is visible.

import { $, highlightJSON } from "../core/dom.js";

export class WorldPanel {
  /** @param {HTMLElement} subtabsEl @param {HTMLElement} preEl */
  constructor(subtabsEl, preEl) {
    this.subtabsEl = subtabsEl;
    this.preEl = preEl;
    this.tab = "world";
    this.data = { world: null, live: null, scene: null };

    subtabsEl.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      [...subtabsEl.children].forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      this.tab = b.dataset.j;
      this.show();
    });
  }

  setData({ world, live, scene }) {
    if (world !== undefined) this.data.world = world;
    if (live !== undefined) this.data.live = live;
    if (scene !== undefined) this.data.scene = scene;
  }

  /** Refresh the visible JSON (cheap enough to call after every turn). */
  show() {
    let o = this.data[this.tab];
    if (typeof o === "function") o = o(); // live view is supplied as a thunk
    this.preEl.innerHTML = highlightJSON(o ?? { note: "nothing loaded yet" });
  }

  get visible() {
    return $("pane-data")?.classList.contains("on") ?? false;
  }
}
