// render/bubble.js — speech & thought bubbles (prototype §9).
//
// Bubbles are collision-placed above speakers; `placed` accumulates rects
// so simultaneous bubbles never overlap. `dims` = {w,h} of the canvas world.

import { clamp, ell, poly, rrPath, rgba } from "../core/utils.js";

export function wrapText(c, text, maxW) {
  const words = String(text || "").split(" "), lines = [];
  let cur = "";
  words.forEach((w) => {
    const t = cur ? cur + " " + w : w;
    if (c.measureText(t).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  });
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/**
 * b = { x, y, text, kind ('say'|'thought'), name, color, alpha? }
 * alpha lets the app fade bubbles out before they expire.
 */
export function drawBubble(c, b, placed, dims) {
  const fs = 13.5, lh = 18, padX = 13, padY = 11, maxW = 205;
  c.save();
  if (typeof b.alpha === "number" && b.alpha < 1) c.globalAlpha = clamp(b.alpha, 0, 1);
  c.font = "600 " + fs + "px Outfit, sans-serif";
  const lines = wrapText(c, b.text, maxW);
  let tw = 0;
  lines.forEach((l) => {
    tw = Math.max(tw, c.measureText(l).width);
  });
  tw = Math.min(maxW, tw);
  const nameH = 15, bw = tw + padX * 2, bh = lines.length * lh + padY * 1.5 + 4;
  const headY = b.y - 72, cands = [], rightFirst = b.x < dims.w * 0.58;
  if (rightFirst)
    cands.push([b.x + 16, headY - bh - 16], [b.x - bw - 16, headY - bh - 16], [b.x + 16, headY - bh - 56], [b.x - bw - 16, headY - bh - 56], [b.x - bw / 2, headY - bh - 92]);
  else
    cands.push([b.x - bw - 16, headY - bh - 16], [b.x + 16, headY - bh - 16], [b.x - bw - 16, headY - bh - 56], [b.x + 16, headY - bh - 56], [b.x - bw / 2, headY - bh - 92]);
  let bx = cands[0][0], by = cands[0][1];
  for (let i = 0; i < cands.length; i++) {
    const cd = cands[i], r = { x: cd[0], y: cd[1], w: bw, h: bh + nameH };
    if (r.x < 6 || r.x + r.w > dims.w - 6 || r.y < 6) continue;
    let hit = false;
    for (let j = 0; j < placed.length; j++) {
      const p = placed[j];
      if (!(r.x + r.w < p.x || p.x + p.w < r.x || r.y + r.h < p.y || p.y + p.h < r.y)) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      bx = cd[0];
      by = cd[1];
      break;
    }
  }
  bx = clamp(bx, 8, dims.w - bw - 8);
  by = clamp(by, 8, dims.h - bh - nameH - 8);
  placed.push({ x: bx, y: by, w: bw, h: bh + nameH });
  const thought = b.kind === "thought";
  if (!thought) {
    const tx = clamp(b.x, bx + 12, bx + bw - 12), ty = by + bh;
    c.fillStyle = "#fffdf6";
    poly(c, [[tx - 9, ty - 1], [tx + 9, ty - 1], [b.x + (b.x > bx + bw / 2 ? 4 : -4), Math.min(b.y - 64, ty + 26)]]);
    c.strokeStyle = "rgba(30,38,66,.20)";
    c.lineWidth = 1.4;
    c.stroke();
  } else {
    const dx = b.x > bx + bw / 2 ? 1 : -1, dots = [[10, 7], [19, 14], [26, 20]];
    dots.forEach((p) => {
      c.fillStyle = "#f4f8ff";
      ell(c, bx + bw / 2 + dx * p[0], by + bh + p[1], p[2] / 2.4 + 1.6, p[2] / 2.4 + 1.6);
      c.fill();
      c.strokeStyle = "rgba(30,38,66,.18)";
      c.lineWidth = 1.3;
      c.stroke();
    });
  }
  c.save();
  c.shadowColor = "rgba(6,10,22,.42)";
  c.shadowBlur = 18;
  c.shadowOffsetY = 7;
  c.fillStyle = thought ? "#f4f8ff" : "#fffdf6";
  rrPath(c, bx, by, bw, bh, 13);
  c.fill();
  c.restore();
  c.strokeStyle = rgba(b.color, 0.55);
  c.lineWidth = 2;
  rrPath(c, bx, by, bw, bh, 13);
  c.stroke();
  c.save();
  rrPath(c, bx, by, bw, bh, 13);
  c.clip();
  c.fillStyle = "rgba(255,255,255,.55)";
  c.fillRect(bx, by, bw, 3);
  c.fillStyle = rgba(b.color, 0.07);
  c.fillRect(bx, by + bh - 16, bw, 16);
  c.restore();
  c.font = "800 9.5px Outfit, sans-serif";
  const nw = c.measureText(b.name.toUpperCase()).width + 15;
  c.fillStyle = b.color;
  rrPath(c, bx + 11, by - 7.5, nw, nameH, 7.5);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.30)";
  rrPath(c, bx + 12, by - 7, nw - 2, 5, 3);
  c.fill();
  c.fillStyle = "#08111f";
  c.textAlign = "center";
  c.fillText(b.name.toUpperCase(), bx + 11 + nw / 2, by + 3.4);
  c.textAlign = "left";
  c.font = (thought ? "500 " : "600 ") + fs + "px Outfit, sans-serif";
  c.fillStyle = thought ? "#4c5c80" : "#25304d";
  lines.forEach((l, i) => c.fillText(l, bx + padX, by + padY + 11 + i * lh));
  c.restore();
}
