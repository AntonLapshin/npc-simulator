// render/background.js — static background layer (prototype §6).
//
// Painted once into an offscreen canvas by SceneRenderer and blitted every
// frame: floor planks, light patches, rugs/zones, back walls, windows,
// wall decor and the entrance door. `drawWall` is exported separately
// because front-layer walls must paint AFTER characters (painters order).

import { linGrad, mulberry, poly, rrPath, rgba, shade, ell } from "../core/utils.js";
import { viewOptions } from "./viewOptions.js";

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

export function drawWall(c, w) {
  const y0 = w.y + w.h - w.height, y1 = w.y + w.h;
  const g = linGrad(c, 0, y0, 0, y1, [[0, w.face], [1, shade(w.face, -0.14)]]);
  c.fillStyle = g || w.face;
  c.fillRect(w.x, y0, w.w, y1 - y0);
  c.fillStyle = w.top;
  c.fillRect(w.x, y0, w.w, 7);
  c.fillStyle = "rgba(255,255,255,.75)";
  c.fillRect(w.x, y0, w.w, 1.6);
  c.save();
  c.beginPath();
  c.rect(w.x, y0, w.w, y1 - y0);
  c.clip();
  c.fillStyle = "rgba(255,255,255,.09)";
  for (let i = -40; i < w.w; i += 90) poly(c, [[w.x + i, y1], [w.x + i + 34, y1], [w.x + i + 70, y0], [w.x + i + 36, y0]]);
  c.fillStyle = "rgba(30,40,80,.10)";
  c.fillRect(w.x, y1 - 5, w.w, 5);
  c.restore();
  c.strokeStyle = "rgba(40,50,90,.16)";
  c.lineWidth = 1;
  c.strokeRect(w.x + 0.5, y0 + 0.5, w.w - 1, y1 - y0 - 1);
}

export function drawWindow(c, win) {
  const x = win.x, y = win.y, w = win.w, h = win.h;
  c.save();
  rrPath(c, x, y, w, h, 5);
  c.clip();
  const sky = linGrad(c, 0, y, 0, y + h, [[0, "#8fd3ff"], [0.55, "#cfe9ff"], [1, "#ffe9c9"]]);
  c.fillStyle = sky || "#bfe4ff";
  c.fillRect(x, y, w, h);
  if (win.view === "city") {
    const rnd = mulberry(x * 7 + y);
    let cx = x - 10;
    while (cx < x + w) {
      const bw = 14 + rnd() * 22, bh = 10 + rnd() * (h - 14);
      c.fillStyle = "rgba(96,124,180," + (0.3 + rnd() * 0.28).toFixed(2) + ")";
      c.fillRect(cx, y + h - bh, bw, bh);
      c.fillStyle = "rgba(255,255,255,.30)";
      for (let wy = y + h - bh + 4; wy < y + h - 3; wy += 6)
        for (let wx = cx + 3; wx < cx + bw - 3; wx += 6) c.fillRect(wx, wy, 2, 2);
      cx += bw + 5 + rnd() * 9;
    }
  } else {
    c.fillStyle = "rgba(90,170,150,.45)";
    poly(c, [[x, y + h], [x + w * 0.22, y + h * 0.34], [x + w * 0.45, y + h], [x + w * 0.62, y + h * 0.5], [x + w * 0.85, y + h], [x + w, y + h * 0.62], [x + w, y + h]]);
    c.fillStyle = "rgba(255,255,255,.5)";
    poly(c, [[x + w * 0.22, y + h * 0.34], [x + w * 0.3, y + h * 0.52], [x + w * 0.14, y + h * 0.52]]);
  }
  c.fillStyle = "rgba(255,255,255,.20)";
  poly(c, [[x, y + h], [x + w * 0.35, y], [x + w * 0.52, y], [x + w * 0.17, y + h]]);
  c.restore();
  c.strokeStyle = "#f7f9fe";
  c.lineWidth = 4;
  rrPath(c, x, y, w, h, 5);
  c.stroke();
  c.strokeStyle = "rgba(60,70,110,.30)";
  c.lineWidth = 1;
  rrPath(c, x - 2, y - 2, w + 4, h + 4, 6);
  c.stroke();
  c.fillStyle = "#f7f9fe";
  c.fillRect(x + w / 2 - 1.5, y, 3, h);
  c.fillStyle = "rgba(255,255,255,.5)";
  c.fillRect(x, y + h * 0.34, w, 2);
}

export function drawDoor(c, d) {
  // Top-view: doors set into vertical (west/east) walls are seen edge-on —
  // paint a simple vertical slab in the wall line, no camera-facing frame.
  if (d.h > d.w * 1.5) {
    c.fillStyle = "#0a0f1c";
    c.fillRect(d.x, d.y, d.w, d.h);
    c.fillStyle = d.frame || "#8f6b45";
    c.fillRect(d.x + 2, d.y + 1, Math.max(4, d.w - 4), Math.max(2, d.h - 2));
    c.fillStyle = "rgba(255,255,255,.28)";
    c.fillRect(d.x + 2, d.y + 1, Math.max(2, d.w - 4), 2);
    c.strokeStyle = "rgba(40,50,90,.35)";
    c.lineWidth = 1.5;
    c.strokeRect(d.x + 1, d.y + 0.5, d.w - 1, d.h - 1);
    // centre leaf seam to read as a door, still flat top-view
    c.fillStyle = "rgba(20,26,44,.5)";
    c.fillRect(d.x + d.w / 2 - 0.75, d.y + 3, 1.5, Math.max(1, d.h - 6));
    return;
  }
  c.fillStyle = "#0a0f1c";
  c.fillRect(d.x, d.y + 2, d.w, d.h);
  const g = linGrad(c, 0, d.y - 46, 0, d.y + d.h, [[0, "rgba(120,150,220,.30)"], [1, "rgba(20,26,44,.9)"]]);
  if (g) {
    c.fillStyle = g;
    c.fillRect(d.x, d.y - 46, d.w, d.h + 46);
  }
  c.fillStyle = d.frame;
  c.fillRect(d.x - 9, d.y - 50, 9, d.h + 50);
  c.fillRect(d.x + d.w, d.y - 50, 9, d.h + 50);
  c.fillRect(d.x - 9, d.y - 56, d.w + 18, 9);
  c.fillStyle = shade(d.frame, 0.28);
  c.fillRect(d.x - 9, d.y - 56, d.w + 18, 3);
  c.fillStyle = "rgba(255,255,255,.55)";
  c.font = "700 9px Outfit, sans-serif";
  c.textAlign = "center";
  c.fillText(d.label, d.x + d.w / 2, d.y - 62);
  c.textAlign = "left";
}

export function drawWhiteboard(c, d) {
  c.fillStyle = "rgba(20,26,48,.18)";
  rrPath(c, d.x + 3, d.y + 4, d.w, d.h, 5);
  c.fill();
  c.fillStyle = "#eef2fa";
  rrPath(c, d.x, d.y, d.w, d.h, 5);
  c.fill();
  c.strokeStyle = "#aab6d0";
  c.lineWidth = 2.4;
  rrPath(c, d.x, d.y, d.w, d.h, 5);
  c.stroke();
  c.save();
  rrPath(c, d.x + 4, d.y + 4, d.w - 8, d.h - 8, 3);
  c.clip();
  c.strokeStyle = rgba(d.ink, 0.55);
  c.lineWidth = 1.6;
  for (let i = 0; i < 4; i++) {
    c.beginPath();
    c.moveTo(d.x + 10, d.y + 11 + i * 7);
    c.lineTo(d.x + 10 + 38 + ((i * 23) % 46), d.y + 11 + i * 7);
    c.stroke();
  }
  c.strokeStyle = "rgba(255,93,122,.7)";
  c.beginPath();
  c.moveTo(d.x + 84, d.y + d.h - 10);
  const pts = [10, 20, 14, 26, 20, 32];
  for (let i = 0; i < pts.length; i++) c.lineTo(d.x + 84 + i * 9, d.y + d.h - 10 - pts[i]);
  c.stroke();
  c.fillStyle = "rgba(46,196,166,.55)";
  c.fillRect(d.x + 84, d.y + d.h - 11, 58, 2);
  c.restore();
}

export function drawClock(c, d) {
  c.fillStyle = "rgba(20,26,48,.18)";
  ell(c, d.x + 2, d.y + 3, d.r, d.r);
  c.fill();
  c.fillStyle = "#f7f9fe";
  ell(c, d.x, d.y, d.r, d.r);
  c.fill();
  c.strokeStyle = "#8c99b8";
  c.lineWidth = 2.4;
  ell(c, d.x, d.y, d.r, d.r);
  c.stroke();
  c.strokeStyle = "#2b3550";
  c.lineWidth = 2;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(d.x, d.y);
  c.lineTo(d.x, d.y - d.r * 0.6);
  c.stroke();
  c.beginPath();
  c.moveTo(d.x, d.y);
  c.lineTo(d.x + d.r * 0.55, d.y + d.r * 0.2);
  c.stroke();
  c.fillStyle = "#ff5d7a";
  ell(c, d.x, d.y, 1.8, 1.8);
  c.fill();
  c.lineCap = "butt";
}

export function drawPoster(c, d) {
  c.fillStyle = "rgba(20,26,48,.16)";
  rrPath(c, d.x + 2, d.y + 3, d.w, d.h, 4);
  c.fill();
  c.fillStyle = "#fbfcff";
  rrPath(c, d.x, d.y, d.w, d.h, 4);
  c.fill();
  c.save();
  rrPath(c, d.x + 3, d.y + 3, d.w - 6, d.h - 6, 2);
  c.clip();
  c.fillStyle = rgba(d.color, 0.85);
  poly(c, [[d.x + 3, d.y + d.h - 3], [d.x + d.w * 0.5, d.y + 6], [d.x + d.w - 3, d.y + d.h - 3]]);
  c.fillStyle = "rgba(255,255,255,.45)";
  poly(c, [[d.x + 3, d.y + d.h - 3], [d.x + d.w * 0.5, d.y + 6], [d.x + d.w * 0.36, d.y + d.h - 3]]);
  c.restore();
}

export function drawRug(c, d) {
  const x = d.x - d.w / 2, y = d.y - d.h / 2;
  c.fillStyle = "rgba(40,26,12,.16)";
  rrPath(c, x + 3, y + 5, d.w, d.h, 20);
  c.fill();
  c.fillStyle = rgba(d.color, 0.3);
  rrPath(c, x, y, d.w, d.h, 20);
  c.fill();
  c.strokeStyle = rgba(d.trim, 0.55);
  c.lineWidth = 3;
  rrPath(c, x + 8, y + 8, d.w - 16, d.h - 16, 14);
  c.stroke();
  c.save();
  rrPath(c, x, y, d.w, d.h, 20);
  c.clip();
  c.fillStyle = "rgba(255,255,255,.10)";
  for (let i = -d.h; i < d.w; i += 34) poly(c, [[x + i, y + d.h], [x + i + 14, y + d.h], [x + i + 14 + d.h, y], [x + i + d.h, y]]);
  c.restore();
  c.strokeStyle = "rgba(255,255,255,.20)";
  c.lineWidth = 1.4;
  rrPath(c, x, y, d.w, d.h, 20);
  c.stroke();
}

export function drawZone(c, d) {
  const x = d.x - d.w / 2, y = d.y - d.h / 2;
  c.save();
  c.setLineDash([9, 7]);
  c.strokeStyle = rgba(d.color, 0.42);
  c.lineWidth = 2;
  rrPath(c, x, y, d.w, d.h, 16);
  c.stroke();
  c.setLineDash([]);
  c.restore();
  c.fillStyle = rgba(d.color, 0.75);
  c.font = "800 10px Outfit, sans-serif";
  c.fillText(d.label, x + 12, y + 18);
}
