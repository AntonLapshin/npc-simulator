// render/sceneRenderer.js — canvas host & frame pipeline (prototype §5 + §11).
//
// Owns the visible canvas and the cached background layer. The app calls
// `render(state)` whenever the live state is dirty; a rAF loop lives in
// app.js (it also advances tweens), so the renderer stays stateless.
//
// state = {
//   chars:   [{ id,name,color,look,prop,x,y,dir,emotion,visible,isUser }],
//   bubbles: [{ x,y,text,kind,name,color,alpha? }],
//   objects: [{ id,name,x,y,w,h,passable,blocksVision }] | undefined
//            — world scene objects with no matching static asset (generic box)
// }

import { radGrad, rrPath, shade, solidBox } from "../core/utils.js";
import { paintBackground, drawWall } from "./background.js";
import { drawAsset, assetSortY } from "./assets.js";
import { drawCharacter } from "./character.js";
import { drawBubble } from "./bubble.js";
import { viewOptions } from "./viewOptions.js";

export class SceneRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} staticScene STATIC_SCENE layout
   */
  constructor(canvas, staticScene) {
    this.canvas = canvas;
    this.scale = 1;
    this.ctx = canvas.getContext("2d");
    this.bg = document.createElement("canvas");
    this.bgx = this.bg.getContext("2d");
    this._failed = new Set();
    this._ready = Boolean(this.ctx && this.bgx);
    if (!this._ready) console.warn("[SceneRenderer] 2D context unavailable — rendering disabled");
    this.setScene(staticScene);
  }

  /**
   * Swap the painted scenery (e.g. after loading a scenario whose objects
   * define their own room). Recomputes the already-painted id set and
   * repaints the cached background.
   */
  setScene(staticScene) {
    this.scene = staticScene;
    this.dims = staticScene.meta.world; // {w,h} canvas world units
    this.knownObjectIds = new Set((staticScene.assets || []).map((a) => a.id));
    if (staticScene.door?.id) this.knownObjectIds.add(staticScene.door.id);
    (staticScene.walls || []).forEach((w) => w.id && this.knownObjectIds.add(w.id));
    (staticScene.windows || []).forEach((w) => w.id && this.knownObjectIds.add(w.id));
    (staticScene.wallDecor || []).forEach((w) => w.id && this.knownObjectIds.add(w.id));
    (staticScene.floorDecals || []).forEach((w) => w.id && this.knownObjectIds.add(w.id));
    if (this._ready && this.canvas.width) this.repaintBackground();
  }

  get ready() {
    return this._ready;
  }

  /** Fit backing store to the CSS size (devicePixelRatio-aware). */
  resize() {
    if (!this._ready) return;
    try {
      const cw = this.canvas.clientWidth || 900;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const px = Math.max(2, Math.round(cw * dpr));
      this.scale = px / this.dims.w;
      this.canvas.width = px;
      this.canvas.height = Math.round((px * this.dims.h) / this.dims.w);
      this.bg.width = this.canvas.width;
      this.bg.height = this.canvas.height;
      this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      this.bgx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      this.repaintBackground();
    } catch (err) {
      console.error("[resize]", err);
    }
  }

  repaintBackground() {
    if (!this._ready) return;
    try {
      paintBackground(this.bgx, this.scene, this.dims);
    } catch (err) {
      console.error("[background]", err);
    }
  }

  /** Zones are part of the cached background → repaint + re-render. */
  setZones(on) {
    viewOptions.showZones = on;
    this.repaintBackground();
  }

  setNames(on) {
    viewOptions.showNames = on;
  }

  _safeDraw(key, fn) {
    try {
      fn();
    } catch (err) {
      if (!this._failed.has(key)) {
        this._failed.add(key);
        console.error("[draw:" + key + "]", err);
      }
    }
  }

  /** Paint one full frame from a live-state snapshot. */
  render(state) {
    if (!this._ready) return;
    const ctx = this.ctx;
    const { w: W, h: H } = this.dims;
    try {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(this.bg, 0, 0, W, H);

      /* painters order: southern-most floor edge wins */
      const list = [];
      (this.scene.assets || []).forEach((a) => list.push({ k: assetSortY(a), t: "a", o: a }));
      (this.scene.walls || []).filter((w) => w.layer === "front").forEach((w) => list.push({ k: w.y + w.h, t: "w", o: w }));
      (state.objects || []).forEach((o) => {
        if (!this.knownObjectIds.has(o.id)) list.push({ k: o.y + (o.h || 0) / 2, t: "o", o });
      });
      state.chars.filter((c) => c.visible !== false).forEach((c) => list.push({ k: c.y, t: "c", o: c }));
      list.sort((p, q) => p.k - q.k);

      list.forEach((it) => {
        const key = it.t + ":" + (it.o.id || it.o.name || "?");
        this._safeDraw(key, () => {
          if (it.t === "a") drawAsset(ctx, it.o);
          else if (it.t === "c") drawCharacter(ctx, it.o, { showNames: viewOptions.showNames });
          else if (it.t === "o") drawWorldObject(ctx, it.o);
          else drawWall(ctx, it.o);
        });
      });

      const placed = [];
      state.bubbles
        .slice()
        .sort((a, b) => a.y - b.y)
        .forEach((b, i) => {
          this._safeDraw("bubble" + i, () => drawBubble(ctx, b, placed, this.dims));
        });

      const vg = radGrad(ctx, W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.92, [
        [0, "rgba(0,0,0,0)"],
        [1, "rgba(4,7,16,.55)"],
      ]);
      if (vg) {
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, W, H);
      }
    } catch (err) {
      console.error("[render]", err);
    }
  }
}

/**
 * Generic fallback for world scene objects that have no painted static
 * asset (foreign scenarios): a labelled translucent box on the floor.
 */
function drawWorldObject(c, o) {
  const w = Math.max(12, o.w || 40), h = Math.max(12, o.h || 40);
  const boxH = o.blocksVision ? 46 : o.passable ? 6 : 26;
  const top = o.passable ? "#6d7b9c" : o.blocksVision ? "#5b6b8c" : "#7f8ca8";
  solidBox(c, o.x, o.y, w, h, boxH, shade(top, 0.2), shade(top, -0.3), 5);
  if (o.name) {
    c.font = "700 8px Outfit, sans-serif";
    c.fillStyle = "rgba(8,12,22,.6)";
    const tw = c.measureText(o.name).width + 8;
    rrPath(c, o.x - tw / 2, o.y - boxH - h / 2 - 14, tw, 12, 6);
    c.fill();
    c.fillStyle = "rgba(233,238,251,.85)";
    c.textAlign = "center";
    c.fillText(o.name, o.x, o.y - boxH - h / 2 - 5);
    c.textAlign = "left";
  }
}
