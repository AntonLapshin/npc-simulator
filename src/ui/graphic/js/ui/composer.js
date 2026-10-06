// ui/composer.js — the bottom message input: how the user takes a turn.
//
// Replaces the prototype's transport (play/prev/next/scrubber). Enter sends,
// Shift+Enter inserts a newline; the input locks while a turn round is
// resolving and shows the engine's progress line (mirrors the text UI's
// single-line spinner: "Maya (NPC) — choosing an action (3s)").

import { $, autogrow } from "../core/dom.js";

export class Composer {
  /** @param {{onSubmit:(text:string)=>void}} handlers */
  constructor({ onSubmit }) {
    this.input = $("composerInput");
    this.sendBtn = $("composerSend");
    this.statusEl = $("composerStatus");
    this.statusText = $("composerStatusText");
    this.onSubmit = onSubmit;
    this._busy = false;
    this._startedAt = 0;
    this._elapsedTimer = null;

    this.input.addEventListener("input", () => {
      autogrow(this.input);
      this._updateSendState();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    this.sendBtn.addEventListener("click", () => this.submit());
  }

  /** Actor name shown in the placeholder ("Type an action for Noah…"). */
  setActorName(name) {
    this.input.placeholder = name
      ? `Type what ${name} does or says… (Enter to send · Shift+Enter for a new line)`
      : "Type your action… (Enter to send · Shift+Enter for a new line)";
  }

  submit() {
    if (this._busy) return;
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    autogrow(this.input);
    this._updateSendState();
    this.onSubmit(text);
  }

  /** Lock input and show a progress line while the engine resolves turns. */
  setBusy(busy, message) {
    this._busy = busy;
    this.input.disabled = busy;
    this.statusEl.classList.toggle("busy", busy);
    this.statusEl.classList.remove("error");
    if (busy) {
      this._startedAt = Date.now();
      this._renderStatus(message || "resolving…");
      if (!this._elapsedTimer) {
        this._elapsedTimer = setInterval(() => this._renderStatus(this._lastMessage), 1000);
      }
    } else {
      clearInterval(this._elapsedTimer);
      this._elapsedTimer = null;
      this._lastMessage = null;
      this.statusText.textContent = "";
    }
    this._updateSendState();
    if (!busy) this.focus();
  }

  /** Progress update while busy (adapter "progress" events). */
  setProgress(message) {
    if (!this._busy) return;
    this._lastMessage = message;
    this._renderStatus(message);
  }

  /** Unlock and flag an error (turn failure, network problem…). */
  setError(message) {
    this._busy = false;
    this.input.disabled = false;
    clearInterval(this._elapsedTimer);
    this._elapsedTimer = null;
    this.statusEl.classList.remove("busy");
    this.statusEl.classList.add("error");
    this.statusText.textContent = message || "Something went wrong.";
    this._updateSendState();
    this.focus();
  }

  _renderStatus(message) {
    const secs = Math.round((Date.now() - this._startedAt) / 1000);
    this.statusText.textContent = `${message || "resolving…"} (${secs}s)`;
  }

  _updateSendState() {
    this.sendBtn.disabled = this._busy || this.input.value.trim().length === 0;
  }

  focus() {
    try {
      this.input.focus({ preventScroll: true });
    } catch {
      this.input.focus();
    }
  }
}
