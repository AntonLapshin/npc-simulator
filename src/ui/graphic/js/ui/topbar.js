// ui/topbar.js — header pills: scenario title, tick, cast count, engine.

import { $ } from "../core/dom.js";

export class Topbar {
  constructor() {
    this.title = $("pillTitle");
    this.tick = $("pillTick");
    this.cast = $("pillCast");
    this.engine = $("pillEngine");
    this.engineDot = $("engineDot");
  }

  setScenario(title) {
    this.title.textContent = title || "—";
  }

  setTick(tick) {
    this.tick.textContent = String(tick ?? 0);
  }

  setCast(count) {
    this.cast.textContent = String(count ?? 0);
  }

  /** @param {string} label e.g. "MOCK (offline)" or "LLM · joingonka/x" */
  setEngine(label, { mock = true } = {}) {
    this.engine.textContent = label;
    this.engineDot.style.background = mock ? "var(--to)" : "var(--em)";
    this.engineDot.style.boxShadow = `0 0 10px ${mock ? "var(--to)" : "var(--em)"}`;
  }
}
