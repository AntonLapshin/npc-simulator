// sim/liveState.js — the visual state engine.
//
// The engine's World updates are instantaneous (an actor patch sets x/y);
// the UI wants motion. LiveState keeps a render-side copy of every actor,
// tweens position changes, tracks timed speech bubbles and the caption,
// and exposes a per-frame `frame(dt)` used by the app's rAF loop.
//
// It never mutates World objects — same rule the text UI follows.

import { clamp, easeInOut } from "../scene/ui.js";
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
      const pose = p.pose || "stand";
      const seated = seatViewXY(world, this.mapper, a.x, a.y, pose);
      this.actors.set(a.id, {
        id: a.id,
        name: a.name,
        color: p.color || "#8fa0c0",
        role: p.role || "",
        prop: p.prop ?? null,
        pose,
        look: p.look,
        x: seated ? seated.x : this.mapper.toViewX(a.x),
        y: seated ? seated.y : this.mapper.toViewY(a.y),
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
      const presNow = resolvePresentation(this._presentation, [a]).get(a.id);
      if (!v) {
        // actor appeared mid-session: materialise with derived presentation
        const pose0 = presNow?.pose || a.pose || "stand";
        const seated0 = seatViewXY(world, this.mapper, a.x, a.y, pose0);
        v = {
          id: a.id, name: a.name, color: presNow?.color || "#8fa0c0", role: "", prop: presNow?.prop ?? null, pose: pose0, look: presNow?.look,
          x: seated0 ? seated0.x : this.mapper.toViewX(a.x), y: seated0 ? seated0.y : this.mapper.toViewY(a.y), wx: a.x, wy: a.y,
          dir: "down", emotion: a.emotion || "neutral", visible: true,
          isUser: a.id === world.userActorId, tween: null,
        };
        this.actors.set(a.id, v);
        this.order.push(a.id);
      }
      const poseNow = presNow?.pose || a.pose || v.pose || "stand";
      const seated = seatViewXY(this.world, this.mapper, a.x, a.y, poseNow);
      const tx = seated ? seated.x : this.mapper.toViewX(a.x);
      const ty = seated ? seated.y : this.mapper.toViewY(a.y);
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
      // Appearance is data-driven from the actor: pose/prop/color/look
      // follow the world immediately (only positions tween).
      if (presNow) {
        v.pose = presNow.pose || v.pose || "stand";
        v.prop = presNow.prop ?? v.prop ?? null;
        v.color = presNow.color || v.color;
        v.look = presNow.look || v.look;
      }
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

/**
 * True for chair-like scene objects (same match as scenarioScene.js:
 * chair | stool | seat | bench on id + name — descriptions mention
 * contents and would misclassify, so they are ignored here too).
 */
function isSeatObject(o) {
  const hay = `${o.id || ""} ${o.name || ""}`.toLowerCase();
  return /chair|stool|seat|bench/.test(hay);
}

/** Half-open containment, mirroring engine geometry.pointInRect. */
function pointInSeat(x, y, o) {
  const w = o.w ?? 1;
  const h = o.h ?? 1;
  return x >= (o.x ?? 0) && x < (o.x ?? 0) + w && y >= (o.y ?? 0) && y < (o.y ?? 0) + h;
}

/**
 * View-space seat snap for sitters: when a pose=sit actor's world point
 * lies inside a chair rect, render at that chair's footprint CENTER so the
 * sit pose (seat plane y-26) lands on the chair asset. Without this, engine
 * points like (8, 7) map to the tile's top-left corner while the chair
 * asset centers on (8.5, 7.5) — half a tile off, reading as "outside the
 * chair". Returns null when no snap applies (stand pose, no chair, …).
 */
function seatViewXY(world, mapper, x, y, pose) {
  if (pose !== "sit" || !world || !mapper) return null;
  const objects = world.scene?.objects;
  if (!Array.isArray(objects)) return null;
  let best = null;
  let bestArea = Infinity;
  for (const o of objects) {
    if (!isSeatObject(o)) continue;
    if (!pointInSeat(x, y, o)) continue;
    const area = (o.w ?? 1) * (o.h ?? 1);
    if (area < bestArea) {
      bestArea = area;
      best = o;
    }
  }
  if (!best) return null;
  // Same center convention as scenarioScene assets + snapshot objects.
  return {
    x: mapper.toViewX((best.x || 0) + (best.w || 0) / 2),
    y: mapper.toViewY((best.y || 0) + (best.h || 0) / 2),
  };
}

/** Dominant-axis facing from a movement delta. */
export function deriveDir(dx, dy) {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}
