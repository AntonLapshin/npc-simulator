// ui/logPanel.js — "Timeline" tab: the world's history feed.
//
// History entries follow the engine convention "Name: action text".
// Entries by the user actor are highlighted; quoted speech gets a SAY tag
// (THINK for inner thoughts), everything else an ACT tag.

import { el } from "../core/dom.js";
import { extractQuoted, looksLikeThought } from "../sim/textParse.js";

export class LogPanel {
  /**
   * @param {HTMLElement} container scrollable list element
   * @param {HTMLElement} countEl   header counter element
   * @param {(actorId:string)=>string} colorOf actor id → color (presentation)
   */
  constructor(container, countEl, colorOf) {
    this.container = container;
    this.countEl = countEl;
    this.colorOf = colorOf || (() => "#8fa0c0");
    this.autoScroll = true;
    this.container.addEventListener("scroll", () => {
      const c = this.container;
      this.autoScroll = c.scrollTop + c.clientHeight >= c.scrollHeight - 30;
    });
  }

  /** Full (re)build from a world — used on load and after history trimming. */
  reset(world) {
    this.container.innerHTML = "";
    if (world.narrative) this.container.appendChild(this._row("•", "SCENE", null, world.narrative, false));
    world.history.forEach((entry, i) => this.container.appendChild(this._entryRow(i, entry, world)));
    this._updateCount(world);
    this.scrollToBottom();
  }

  /** Append a single entry after a completed turn (cheap incremental path). */
  append(entry, world) {
    this.container.appendChild(this._entryRow(world.history.length - 1, entry, world));
    this._updateCount(world);
    if (this.autoScroll) this.scrollToBottom();
  }

  scrollToBottom() {
    this.container.scrollTop = this.container.scrollHeight;
  }

  _updateCount(world) {
    this.countEl.textContent = `${world.history.length} entries · tick ${world.tick}`;
  }

  /** Parse "Name: text" against the world's roster, then build the row. */
  _entryRow(index, entry, world) {
    const m = /^([^:]{1,40}):\s*([\s\S]+)$/.exec(entry);
    const actor = m ? world.actors.find((a) => a.name === m[1].trim()) : null;
    if (actor) {
      const body = m[2];
      const tag = extractQuoted(body) ? (looksLikeThought(body) ? "THINK" : "SAY") : "ACT";
      const isUser = actor.id === world.userActorId;
      return this._row(`t${index + 1}`, tag, actor, body, isUser);
    }
    return this._row(`t${index + 1}`, "SCENE", null, entry, false);
  }

  _row(time, tag, actor, body, isUser) {
    const ds = el("span", { class: "ds" }, [el("span", { class: "tg", text: tag })]);
    if (actor) {
      ds.appendChild(el("span", { class: "who", style: `color:${this.colorOf(actor.id)}`, text: actor.name + " " }));
    }
    ds.appendChild(document.createTextNode(body));
    return el("div", { class: "ev" + (isUser ? " is-user" : "") }, [
      el("span", { class: "tc", text: time }),
      ds,
    ]);
  }
}
