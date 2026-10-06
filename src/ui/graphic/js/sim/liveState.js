// sim/liveState.js — the visual state engine.
//
// The engine's World updates are instantaneous (an actor patch sets x/y);
// the UI wants motion. LiveState keeps a render-side copy of every actor,
// tweens position changes, tracks timed speech bubbles and the caption,
// and exposes a per-frame `frame(dt)` used by the app's rAF loop.
//
// It never mutates World objects — same rule the text UI follows.

import { clamp, easeInOut } from "../core/utils.js";
import { makeMapper, resolvePresentation } from "./presentation.js";
import { parseSpeechFromAction } from "./textParse.js";

const BUBBLE_FADE = 0.6; // seconds of fade-out before expiry

export class LiveState {
  constructor() {
    /** @type {Map<string, object>} visual actor by id */
    this.actors = new Map();
    this.order = [];
    this.userActorId = "";
    this.world = null;
    this.mapper = null;
    this.bubbles = [];
    this.caption = "";
    this.time = 0;
    this.lastSpeechBy = new Map(); // actorId → bubble text (for cast panel lines)
  }

  /** (Re)initialise from a freshly loaded world. */
  init(world, presentation) {
    this.world = world;
    this._presentation = presentation || null;
    this._sceneW = world.scene.width;
    this._sceneH = world.scene.height;
    this.userActorId = world.userActorId;
    this.order = [...world.order];
    this.mapper = makeMapper(world.scene.width, world.scene.height, 1040, 730);
    this.actors.clear();
    this.bubbles = [];
    this.lastSpeechBy.clear();
    const pres = resolvePresentation(presentation, world.actors);
    for (const a of world.actors) {
      const p = pres.get(a.id) || {};
      this.actors.set(a.id, {
        id: a.id,
        name: a.name,
        color: p.color || "#8fa0c0",
        role: p.role || "",
        prop: p.prop ?? null,
        look: p.look,
        x: this.mapper.toViewX(a.x),
        y: this.mapper.toViewY(a.y),
        wx: a.x,
        wy: a.y,
        dir: "down",
        emotion: a.emotion || "neutral",
        visible: true,
        isUser: a.id === world.userActorId,
        tween: null,
      });
    }
    this.caption = world.narrative || "";
  }

  /**
   * Diff a new world snapshot onto the visual state.
   * Position changes become tweens; emotion/state update immediately.
   */
  applyWorld(world, { immediate = false } = {}) {
    if (!this.mapper || world.scene.width !== this._sceneW || world.scene.height !== this._sceneH) {
      // scene changed (new world loaded) → full re-init with same presentation
      this.init(world, this._presentation);
      return;
    }
    this.world = world;
    const seen = new Set();
    for (const a of world.actors) {
      seen.add(a.id);
      let v = this.actors.get(a.id);
      if (!v) {
        // actor appeared mid-session: materialise with derived presentation
        const pres = resolvePresentation(null, [a]).get(a.id);
        v = {
          id: a.id, name: a.name, color: pres.color, role: "", prop: null, look: pres.look,
          x: this.mapper.toViewX(a.x), y: this.mapper.toViewY(a.y), wx: a.x, wy: a.y,
          dir: "down", emotion: a.emotion || "neutral", visible: true,
          isUser: a.id === world.userActorId, tween: null,
        };
        this.actors.set(a.id, v);
        this.order.push(a.id);
      }
      const tx = this.mapper.toViewX(a.x), ty = this.mapper.toViewY(a.y);
      const moved = Math.abs(tx - (v.tween ? v.tween.x1 : v.x)) > 0.5 || Math.abs(ty - (v.tween ? v.tween.y1 : v.y)) > 0.5;
      if (moved && !immediate) {
        const sx = v.tween ? v.tween.x1 : v.x;
        const sy = v.tween ? v.tween.y1 : v.y;
        const dist = Math.hypot(tx - sx, ty - sy);
        v.dir = deriveDir(tx - sx, ty - sy) || v.dir;
        v.tween = {
          x0: v.x, y0: v.y, x1: tx, y1: ty, t: 0,
          dur: clamp(0.35 + dist / 620, 0.35, 1.25),
        };
      } else if (moved) {
        v.x = tx;
        v.y = ty;
        v.tween = null;
      }
      v.wx = a.x;
      v.wy = a.y;
      v.emotion = a.emotion || v.emotion;
      v.name = a.name;
      v.visible = true;
    }
    for (const [id, v] of this.actors) if (!seen.has(id)) v.visible = false;
  }

  /**
   * Handle one completed turn. `ev` = adapter turn event:
   * { world, actorId, isUser, actionText, speech?, narrative? }
   */
  applyTurn(ev) {
    this.applyWorld(ev.world);
    const speech = ev.speech || parseSpeechFromAction(ev.actionText || "");
    if (speech && speech.text) this.addBubble(ev.actorId, speech.text, speech.kind || "say");
    const cap = ev.narrative || ev.actionText;
    if (cap) this.setCaption(cap);
  }

  /** Show a speech/thought bubble anchored to an actor. */
  addBubble(actorId, text, kind = "say") {
    const v = this.actors.get(actorId);
    if (!v || !text) return;
    // one bubble per speaker: replace any previous one
    this.bubbles = this.bubbles.filter((b) => b.actorId !== actorId);
    const dur = clamp(2.4 + text.length * 0.055, 2.6, 9);
    this.bubbles.push({ actorId, text, kind, name: v.name, color: v.color, t: 0, dur });
    this.lastSpeechBy.set(actorId, { text, kind });
  }

  setCaption(text) {
    this.caption = text || "";
  }

  /** Advance tweens/bubbles; returns true when a re-render is needed. */
  frame(dt) {
    this.time += dt;
    let dirty = false;
    for (const v of this.actors.values()) {
      const tw = v.tween;
      if (!tw) continue;
      tw.t += dt;
      const k = easeInOut(clamp(tw.t / tw.dur, 0, 1));
      v.x = tw.x0 + (tw.x1 - tw.x0) * k;
      v.y = tw.y0 + (tw.y1 - tw.y0) * k;
      dirty = true;
      if (tw.t >= tw.dur) {
        v.x = tw.x1;
        v.y = tw.y1;
        v.tween = null;
      }
    }
    if (this.bubbles.length) {
      for (const b of this.bubbles) b.t += dt;
      const before = this.bubbles.length;
      this.bubbles = this.bubbles.filter((b) => b.t < b.dur);
      if (this.bubbles.length !== before) dirty = true;
      else dirty = true; // alpha may be fading
    }
    return dirty;
  }

  /** Snapshot for SceneRenderer.render(). */
  snapshot() {
    const chars = this.order
      .map((id) => this.actors.get(id))
      .filter(Boolean)
      .concat([...this.actors.values()].filter((v) => !this.order.includes(v.id)));
    const bubbles = this.bubbles
      .filter((b) => {
        const v = this.actors.get(b.actorId);
        return v && v.visible;
      })
      .map((b) => {
        const v = this.actors.get(b.actorId);
        const remain = b.dur - b.t;
        return {
          x: v.x,
          y: v.y,
          text: b.text,
          kind: b.kind,
          name: b.name,
          color: b.color,
          alpha: remain < BUBBLE_FADE ? clamp(remain / BUBBLE_FADE, 0, 1) : 1,
        };
      });
    // World scene objects use engine coordinates (top-left x/y rects in
    // scene units, e.g. a 20×20 room) while the renderer paints in 1040×730
    // view units with x/y as the footprint CENTER. Map them here so foreign
    // scenarios (office-anton, …) show their walls/desks at the right place
    // and scale instead of collapsing into the top-left corner.
    const objects = (this.world ? this.world.scene.objects : []).map((o) =>
      this.mapper
        ? {
            ...o,
            x: this.mapper.toViewX((o.x || 0) + (o.w || 0) / 2),
            y: this.mapper.toViewY((o.y || 0) + (o.h || 0) / 2),
            w: Math.max(8, (o.w || 0) * this.mapper.kx),
            h: Math.max(8, (o.h || 0) * this.mapper.ky),
          }
        : { ...o },
    );
    return { chars, bubbles, objects };
  }

  /** Latest bubble text for an actor (cast panel status line). */
  lastSpeech(actorId) {
    return this.lastSpeechBy.get(actorId) || null;
  }

  visualActor(id) {
    return this.actors.get(id) || null;
  }
}

/** Dominant-axis facing from a movement delta. */
export function deriveDir(dx, dy) {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}
