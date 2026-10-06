// ui/castPanel.js — "Cast" tab: one row per actor with a live avatar,
// emotion chip, current line/state and a YOU badge for the user's actor.

import { el } from "../core/dom.js";
import { drawAvatar } from "../scene/ui.js";

/** emotion → [textColor, chipBackground] (prototype EMO_STYLE). */
export const EMO_STYLE = {
  neutral: ["#8fa0c0", "rgba(143,160,192,.16)"],
  happy: ["#2ec4a6", "rgba(46,196,166,.16)"],
  excited: ["#ffb648", "rgba(255,182,72,.18)"],
  nervous: ["#4f7cff", "rgba(79,124,255,.16)"],
  surprised: ["#ff5d7a", "rgba(255,93,122,.16)"],
  shy: ["#ff9ec4", "rgba(255,158,196,.16)"],
  confident: ["#2ec4a6", "rgba(46,196,166,.14)"],
  thinking: ["#9b6cf5", "rgba(155,108,245,.16)"],
  proud: ["#ffd166", "rgba(255,209,102,.16)"],
  sad: ["#7f8ca8", "rgba(127,140,168,.16)"],
  annoyed: ["#ff5d7a", "rgba(255,93,122,.16)"],
};

export class CastPanel {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    this.rows = new Map(); // actorId → { row, avatar, lineEl, emoEl }
  }

  /** Build rows once per world load. */
  build(live) {
    this.container.innerHTML = "";
    this.rows.clear();
    for (const v of live.snapshot().chars) {
      const avatar = el("canvas", { width: "88", height: "116" });
      const nameRow = el("div", { class: "castname" }, [
        el("i", { style: `background:${v.color}` }),
        document.createTextNode(v.name),
        v.isUser ? el("span", { class: "you-badge", text: "YOU" }) : null,
      ]);
      const lineEl = el("div", { class: "castline", text: "—" });
      const info = el("div", { class: "castinfo" }, [
        nameRow,
        el("div", { class: "castrole", text: v.role || (v.isUser ? "you" : "NPC") }),
        lineEl,
      ]);
      const emoEl = el("div", { class: "emo" });
      const row = el("div", { class: "castrow" + (v.isUser ? " you" : "") }, [avatar, info, emoEl]);
      this.container.appendChild(row);
      this.rows.set(v.id, { row, avatar, lineEl, emoEl, sig: "" });
    }
  }

  /** Refresh rows from live state + the authoritative world. */
  sync(live, world) {
    const snap = live.snapshot();
    for (const v of snap.chars) {
      const r = this.rows.get(v.id);
      if (!r) continue;
      const wa = world.actors.find((a) => a.id === v.id);
      r.row.classList.toggle("off", !v.visible);

      const emo = v.visible ? v.emotion : "off-stage";
      const col = EMO_STYLE[v.emotion] || EMO_STYLE.neutral;
      r.emoEl.textContent = emo;
      r.emoEl.style.color = v.visible ? col[0] : "#5f6e8c";
      r.emoEl.style.background = v.visible ? col[1] : "rgba(255,255,255,.04)";
      r.emoEl.style.borderColor = v.visible ? col[0] + "55" : "transparent";

      const speech = live.lastSpeech(v.id);
      r.lineEl.textContent = speech
        ? (speech.kind === "thought" ? "💭 " : "💬 ") + speech.text
        : v.visible
          ? wa?.state || "(idle)"
          : "(not on scene)";

      // avatar re-render only when something visual changed
      const sig = [v.emotion, v.dir, v.visible, v.prop, v.pose].join("|");
      if (sig !== r.sig) {
        r.sig = sig;
        drawAvatar(r.avatar, v);
      }
    }
  }
}
