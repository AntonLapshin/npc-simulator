// sim/httpAdapter.js — real-backend adapter (integration point).
//
// Expected HTTP contract (thin wrapper around the engine's runTurn loop):
//   GET  {base}/health   → 200 when the server is up (probe/fallback)
//   GET  {base}/world    → { world, presentation?, debug? } (or a bare World)
//   POST {base}/action   → body { text } → { world, events?, debug? }
//        `events` (optional): array of per-turn events
//          { actorId, isUser, actionText, speech?, narrative?, world?,
//            story?, tick? }
//        `story` is the text-UI style debug trace for that turn (server
//        sends it only when started with --debug); replayed in order so the
//        UI animates each turn, with the story appended to the Timeline.
//        Without `events` the adapter synthesises a single turn event from
//        the world diff.
//
// Emitter events (same as MockAdapter):
//   "progress" { actorId, stage, message }
//   "turn"     { world, actorId, isUser, actionText, speech, narrative,
//                story?, tick? }

import { Emitter } from "../core/emitter.js";
import { parseSpeechFromAction } from "./textParse.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpAdapter extends Emitter {
  /** @param {{baseUrl: string, timeoutMs?: number, replayGapMs?: number}} opts */
  constructor({ baseUrl, timeoutMs = 180000, replayGapMs = 450 }) {
    super();
    this.kind = "http";
    // "" means same-origin (page served by the engine server): requests go
    // to relative paths (/health, /world, /action) on the serving origin.
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.label = this.baseUrl || "engine (same origin)";
    this.timeoutMs = timeoutMs;
    this.replayGapMs = replayGapMs;
    this.world = null;
    this.busy = false;
    this.debug = false;
    this._sse = null;
  }

  /** Quick availability check used by main.js to fall back to mocks. */
  static async probe(baseUrl, timeoutMs = 2500) {
    const url = String(baseUrl).replace(/\/+$/, "") + "/health";
    try {
      const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
      return res.ok;
    } catch {
      return false;
    }
  }

  async _json(path, init) {
    const res = await fetchWithTimeout(this.baseUrl + path, init, this.timeoutMs);
    if (!res.ok) throw new Error(`${init?.method || "GET"} ${path} failed: HTTP ${res.status}`);
    return res.json();
  }

  /** @returns {Promise<{world, presentation, debug}>} */
  async load() {
    const data = await this._json("/world", { method: "GET" });
    const world = data.world || data;
    if (!world || !Array.isArray(world.actors)) throw new Error("Malformed world payload");
    this.world = world;
    // Debug mode comes from the server (npm start -- --debug): prefer the
    // explicit /world flag, fall back to the injected __NPC_ENGINE__ marker,
    // then to ?debug=1 for ad-hoc static hosting.
    let debug = Boolean(data.debug);
    try {
      if (!debug && typeof window !== "undefined" && window.__NPC_ENGINE__) {
        debug = Boolean(window.__NPC_ENGINE__.debug);
      }
      if (!debug && typeof window !== "undefined") {
        debug = new URLSearchParams(window.location.search).get("debug") === "1";
      }
    } catch {
      // Non-browser contexts (tests) — ignore.
    }
    this.debug = debug;
    this._subscribeProgress();
    return { world, presentation: data.presentation || null, debug };
  }

  /** Stream live turn progress (proposal/selection/consequence) via SSE. */
  _subscribeProgress() {
    try {
      if (typeof EventSource === "undefined") return;
      if (this._sse) return;
      const url = (this.baseUrl || "") + "/events";
      const src = new EventSource(url);
      this._sse = src;
      src.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data);
          if (ev && ev.message) this.emit("progress", ev);
        } catch {
          // Ignore malformed progress frames.
        }
      };
      src.onerror = () => {
        try {
          src.close();
        } catch {
          // Ignore close errors.
        }
        this._sse = null;
      };
    } catch {
      // SSE is best-effort (tests, file:// preview); POST still works.
    }
  }

  /** Resolve the user's action server-side and replay the resulting turns. */
  async sendUserAction(text) {
    if (this.busy) throw new Error("A turn is already running");
    const action = String(text || "").trim();
    if (!action) throw new Error("Empty action");
    this.busy = true;
    try {
      this.emit("progress", { actorId: this.world?.userActorId, stage: "consequence", message: "waiting for the engine…" });
      const data = await this._json("/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: action }),
      });
      const finalWorld = data.world;
      if (!finalWorld) throw new Error("Malformed action response (no world)");
      if (typeof data.debug === "boolean") this.debug = data.debug;

      if (Array.isArray(data.events) && data.events.length) {
        for (const ev of data.events) {
          this.emit("progress", { actorId: ev.actorId, stage: "turn", message: `${ev.actorId} acted` });
          this.emit("turn", normaliseTurn(ev, finalWorld));
          if (ev.world) this.world = ev.world;
          await sleep(this.replayGapMs);
        }
      } else {
        this.emit("turn", turnFromDiff(finalWorld, action));
      }
      this.world = finalWorld;
      return finalWorld;
    } finally {
      this.busy = false;
    }
  }
}

/** Normalise a server-supplied turn event (keeps the --debug story trace). */
function normaliseTurn(ev, fallbackWorld) {
  const actionText = ev.actionText || ev.text || "";
  return {
    world: ev.world || fallbackWorld,
    actorId: ev.actorId,
    isUser: Boolean(ev.isUser),
    actionText,
    speech: ev.speech || parseSpeechFromAction(actionText),
    narrative: ev.narrative || actionText,
    story: typeof ev.story === "string" ? ev.story : null,
    tick: Number.isInteger(ev.tick) ? ev.tick : null,
  };
}

/**
 * Synthesise a turn event from the final world when the server sends no
 * per-turn events: the last history entry drives the caption/bubble, and
 * its "Name:" prefix (the engine's history convention) picks the actor.
 */
function turnFromDiff(after, userText) {
  const lastEntry = (after.history || []).at(-1) || `you: ${userText}`;
  const actorIdMatch = /^([^:]+):/.exec(lastEntry);
  let actorId = after.userActorId;
  if (actorIdMatch) {
    const byName = after.actors.find((a) => a.name === actorIdMatch[1].trim());
    if (byName) actorId = byName.id;
  }
  return {
    world: after,
    actorId,
    isUser: actorId === after.userActorId,
    actionText: lastEntry,
    speech: parseSpeechFromAction(lastEntry),
    narrative: lastEntry,
    story: null,
    tick: null,
  };
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
