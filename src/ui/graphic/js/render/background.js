// render/background.js — static background layer (backwards-compat layer).
//
// Refactored: wall/window/door/decor/rug/zone painters now live in their own
// files under `render/objects/` (showcase pattern). This module keeps the
// original API (`paintBackground`, `drawWall`, …) and composes the cached
// background from the object modules. No scene is hardcoded here — the scene
// descriptor is passed in (see js/data/scenes/officeFloor3.js).

import { linGrad, mulberry, rrPath, poly, rgba, shade, ell } from "../core/utils.js";
import { viewOptions } from "./viewOptions.js";
import { Wall } from "./objects/wall.js";
import { Win } from "./objects/window.js";
import { Door } from "./objects/door.js";
import { Whiteboard } from "./objects/whiteboard.js";
import { Clock } from "./objects/clock.js";
import { Poster } from "./objects/poster.js";
import { Rug } from "./objects/rug.js";
import { Zone } from "./objects/zone.js";

export const drawWall = Wall.draw;
export const drawWindow = Win.draw;
export const drawDoor = Door.draw;
export const drawWhiteboard = Whiteboard.draw;
export const drawClock = Clock.draw;
export const drawPoster = Poster.draw;
export const drawRug = Rug.draw;
export const drawZone = Zone.draw;

export function paintBackground(c, scene, dims) {
  const { w: W, h: H } = dims;
  c.clearRect(0, 0, W, H);
  const F = scene.floor;
  const base = linGrad(c, 0, 0, 0, H, [[0, "#0d1526"], [1, "#080d18"]]);
  c.fillStyle = base || "#0a1020";
  c.fillRect(0, 0, W, H);
  c.fillStyle = "rgba(0,0,0,.45)";
  rrPath(c, F.x - 16, F.y - 8, F.w + 32, F.h + 40, 26);
  c.fill();

  const cor = scene.corridor;
  if (cor && cor.w > 0 && cor.h > 0) {
    c.fillStyle = cor.color;
    c.fillRect(cor.x, cor.y, cor.w, cor.h);
    c.fillStyle = "rgba(255,255,255,.05)";
    for (let i = 0; i < 4; i++) c.fillRect(cor.x + 8 + i * 30, cor.y + 6, 18, cor.h - 12);
    c.fillStyle = "rgba(0,0,0,.5)";
    c.fillRect(cor.x, cor.y, cor.w, 4);
  }

  c.save();
  rrPath(c, F.x, F.y, F.w, F.h, 6);
  c.clip();
  c.fillStyle = F.base;
  c.fillRect(F.x, F.y, F.w, F.h);
  const rnd = mulberry(20240917);
  for (let y = F.y; y < F.y + F.h; y += F.plank) {
    const off = ((y - F.y) / F.plank) % 2 ? -70 : 0;
    for (let x = F.x + off; x < F.x + F.w; x += 150) {
      const v = (rnd() - 0.5) * 0.055;
      c.fillStyle = v > 0 ? shade(F.base, v * 1.6) : shade(F.tone, -v * 1.4);
      c.fillRect(x, y, 150, F.plank);
      c.strokeStyle = "rgba(150,120,80,.16)";
      c.lineWidth = 1;
      c.strokeRect(x + 0.5, y + 0.5, 149, F.plank - 1);
    }
  }
  (scene.lightPatches || []).forEach((lp) => {
    const gr = linGrad(c, 0, F.y, 0, F.y + 230, [
      [0, "rgba(255,244,205,.34)"],
      [0.55, "rgba(255,240,200,.13)"],
      [1, "rgba(255,240,200,0)"],
    ]);
    if (!gr) return;
    c.fillStyle = gr;
    poly(c, [[lp.x, F.y], [lp.x + lp.w, F.y], [lp.x + lp.w + 46, F.y + 232], [lp.x - 30, F.y + 232]]);
    c.strokeStyle = "rgba(255,255,255,.14)";
    c.lineWidth = 1.4;
    for (let i = 1; i < 3; i++) {
      const mx = lp.x + (lp.w * i) / 3;
      c.beginPath();
      c.moveTo(mx, F.y);
      c.lineTo(mx + 15, F.y + 232);
      c.stroke();
    }
  });
  (scene.floorDecals || []).forEach((d) => {
    if (d.asset === "rug") drawRug(c, d);
    else if (d.asset === "zone" && viewOptions.showZones) drawZone(c, d);
  });
  const ws = linGrad(c, 0, F.y, 0, F.y + 34, [
    [0, "rgba(60,40,20,.20)"],
    [1, "rgba(60,40,20,0)"],
  ]);
  if (ws) {
    c.fillStyle = ws;
    c.fillRect(F.x, F.y, F.w, 34);
  }
  const ws2 = linGrad(c, F.x, 0, F.x + 34, 0, [
    [0, "rgba(60,40,20,.16)"],
    [1, "rgba(60,40,20,0)"],
  ]);
  if (ws2) {
    c.fillStyle = ws2;
    c.fillRect(F.x, F.y, 34, F.h);
  }
  c.restore();

  (scene.walls || []).filter((w) => w.layer === "back").forEach((w) => drawWall(c, w));
  (scene.windows || []).forEach((win) => drawWindow(c, win));
  (scene.wallDecor || []).forEach((d) => {
    if (d.asset === "whiteboard") drawWhiteboard(c, d);
    else if (d.asset === "clock") drawClock(c, d);
    else if (d.asset === "poster") drawPoster(c, d);
  });
  if (scene.door && scene.door.w > 0 && scene.door.h > 0) drawDoor(c, scene.door);
}
