// render/assets.js — furniture/prop renderers (prototype §7).
//
// Each `draw*` receives the 2D context and an asset descriptor from
// STATIC_SCENE.assets. ASSET_DRAW maps `asset` type → renderer; unknown
// types are silently skipped (guarded by SceneRenderer.safeDraw upstream).

import { SQ, ell, ellShadow, flatRect, gemBox, poly, radGrad, rrPath, shade, solidBox } from "../core/utils.js";

/* DESK — slab (t) at height h on 4 legs + under-desk drawer pedestal */
export function drawDesk(c, a) {
  const x = a.x, y = a.y;
  const w = a.w || 170, d = a.d || 76, h = a.h || 44, t = a.t || 10;
  const top = a.color || "#f4ece0", edge = a.edge || "#c9b694";
  const legH = Math.max(4, h - t);
  const x0 = x - w / 2, y0 = y - d / 2, x1 = x + w / 2, y1 = y + d / 2;

  ellShadow(c, x, y1 - 2, w * 0.53, d * 0.46, 0.24);

  /* legs: each grows UPWARD from its own floor anchor */
  const lx = [x0 + 14, x1 - 22], ly = [y0 + 13, y1 - 13];
  c.fillStyle = "#93a0bb";
  c.fillRect(lx[0], ly[0] - legH, 8, legH);
  c.fillRect(lx[1], ly[0] - legH, 8, legH);
  c.fillStyle = "#78839f";
  c.fillRect(lx[0], ly[1] - legH, 8, legH);
  c.fillRect(lx[1], ly[1] - legH, 8, legH);
  c.fillStyle = "rgba(255,255,255,.20)";
  c.fillRect(lx[0], ly[1] - legH, 2, legH);
  c.fillRect(lx[1], ly[1] - legH, 2, legH);
  c.fillStyle = "#5d6883";
  c.fillRect(lx[0] - 1, ly[1] - 3, 10, 3);
  c.fillRect(lx[1] - 1, ly[1] - 3, 10, 3);

  /* drawer pedestal */
  const px = x1 - 42, py = y + 2;
  solidBox(c, px, py, 54, 56, legH, shade(top, -0.05), shade(edge, -0.22), 4);
  const pfTop = py + 28 - legH;
  c.fillStyle = "rgba(20,26,48,.16)";
  c.fillRect(px - 27, pfTop + legH * 0.36, 54, 1);
  c.fillRect(px - 27, pfTop + legH * 0.7, 54, 1);
  c.fillStyle = "#98a4be";
  c.fillRect(px - 10, pfTop + legH * 0.46, 20, 3);
  c.fillRect(px - 10, pfTop + legH * 0.8, 20, 3);

  /* slab */
  gemBox(c, x, y, w, d, h, t, top, shade(edge, -0.1), 8);
  c.strokeStyle = "rgba(120,100,70,.16)";
  c.lineWidth = 1;
  rrPath(c, x0 + 8, y0 - h + 7, w - 16, d - 14, 5);
  c.stroke();
}

/* ROUND TABLE — top ellipse centre is exactly (x, y-h) */
export function drawRoundTable(c, a) {
  const x = a.x, y = a.y, r = a.r || 70, h = a.h || 42, t = a.t || 9;
  const rx = r, ry = r * SQ, topCY = y - h;
  ellShadow(c, x, y + ry * 0.5, rx * 1.02, ry, 0.24);
  c.fillStyle = "#7f8ca8";
  ell(c, x, y + ry * 0.44, rx * 0.44, ry * 0.46);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.16)";
  ell(c, x - 7, y + ry * 0.36, rx * 0.2, ry * 0.2);
  c.fill();
  const pTop = topCY + t - 2, pBot = y + ry * 0.44;
  c.fillStyle = "#98a4be";
  c.fillRect(x - 7, pTop, 14, Math.max(1, pBot - pTop));
  c.fillStyle = "rgba(255,255,255,.28)";
  c.fillRect(x - 7, pTop, 4, Math.max(1, pBot - pTop));
  c.fillStyle = "rgba(0,0,0,.16)";
  c.fillRect(x + 3, pTop, 4, Math.max(1, pBot - pTop));
  c.fillStyle = a.edge || "#c9b694";
  ell(c, x, topCY + t, rx, ry);
  c.fill();
  c.fillRect(x - rx, topCY + t / 2, rx * 2, t);
  c.fillStyle = a.color || "#f7f0e4";
  ell(c, x, topCY, rx, ry);
  c.fill();
  c.save();
  ell(c, x, topCY, rx, ry);
  c.clip();
  c.fillStyle = "rgba(255,255,255,.30)";
  poly(c, [[x - rx, topCY - ry], [x + rx * 0.1, topCY - ry], [x - rx * 0.15, topCY + ry], [x - rx, topCY + ry]]);
  c.fillStyle = "rgba(0,0,0,.05)";
  poly(c, [[x + rx, topCY], [x + rx * 0.2, topCY + ry], [x + rx, topCY + ry]]);
  c.restore();
  c.strokeStyle = "rgba(60,45,25,.24)";
  c.lineWidth = 1.6;
  ell(c, x, topCY, rx, ry);
  c.stroke();
  c.strokeStyle = "rgba(255,255,255,.45)";
  c.lineWidth = 1.2;
  c.beginPath();
  c.ellipse(x, topCY, Math.max(1, rx - 3), Math.max(1, ry - 2), 0, Math.PI * 1.05, Math.PI * 1.75);
  c.stroke();
}

/* CHAIR — dir = the way the sitter faces; backrest on the opposite side */
export function drawChair(c, a) {
  const x = a.x, y = a.y, dir = a.dir || "down", col = a.color || "#4f7cff";
  const sw = a.w || 34, sd = a.d || 32, sh = a.h || 26, st = 8, bh = a.bh || 60;
  ellShadow(c, x, y + sd * 0.3, sw * 0.68, sd * 0.48, 0.24);
  let bx = x, by = y, bw = sw + 3, bd = 11;
  if (dir === "down") by = y - sd / 2 + 5;
  else if (dir === "up") by = y + sd / 2 - 5;
  else if (dir === "left") {
    bx = x + sw / 2 - 5;
    bw = 11;
    bd = sd - 3;
  } else {
    bx = x - sw / 2 + 5;
    bw = 11;
    bd = sd - 3;
  }
  solidBox(c, bx, by, bw, bd, bh, shade(col, 0.14), shade(col, -0.38), 5);
  c.fillStyle = "rgba(255,255,255,.18)";
  if (bw > bd) {
    rrPath(c, bx - bw / 2 + 5, by - bd / 2 - bh + 6, bw - 10, bd * 0.45, 3);
    c.fill();
  } else {
    rrPath(c, bx - bw / 2 + 3, by - bd / 2 - bh + 7, bw * 0.45, bd - 14, 3);
    c.fill();
  }
  const under = y + sd / 2 - sh + st, floorY = y + sd * 0.3;
  c.fillStyle = "#6f7c99";
  c.fillRect(x - 3, under - 6, 6, Math.max(1, floorY - under + 6));
  c.strokeStyle = "#6f7c99";
  c.lineWidth = 3.4;
  c.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const an = Math.PI * 0.25 + (i * Math.PI) / 2;
    c.beginPath();
    c.moveTo(x, floorY);
    c.lineTo(x + Math.cos(an) * 13, floorY + Math.sin(an) * 5.5);
    c.stroke();
    c.fillStyle = "#4c5670";
    ell(c, x + Math.cos(an) * 13.5, floorY + Math.sin(an) * 5.8, 2.4, 2.4);
    c.fill();
  }
  c.lineCap = "butt";
  gemBox(c, x, y, sw, sd, sh, st, col, shade(col, -0.36), 7);
  c.strokeStyle = "rgba(255,255,255,.22)";
  c.lineWidth = 1.2;
  rrPath(c, x - sw / 2 + 6, y - sd / 2 - sh + 5, sw - 12, sd - 10, 4);
  c.stroke();
}

export function drawStool(c, a) {
  const x = a.x, y = a.y, col = a.color || "#ffb648";
  const sw = 30, sd = 26, sh = 24, st = 8;
  ellShadow(c, x, y + sd * 0.32, sw * 0.62, sd * 0.44, 0.22);
  const under = y + sd / 2 - sh + st, floorY = y + sd * 0.32;
  c.fillStyle = "#6f7c99";
  c.fillRect(x - 3, under - 4, 6, Math.max(1, floorY - under + 4));
  c.strokeStyle = "#6f7c99";
  c.lineWidth = 3.4;
  c.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const an = Math.PI * 0.25 + (i * Math.PI) / 2;
    c.beginPath();
    c.moveTo(x, floorY);
    c.lineTo(x + Math.cos(an) * 12, floorY + Math.sin(an) * 5);
    c.stroke();
  }
  c.lineCap = "butt";
  gemBox(c, x, y, sw, sd, sh, st, col, shade(col, -0.36), 7);
}

/* LAPTOP — base flat on the surface, lid hinged at the NORTH edge */
export function drawLaptop(c, a) {
  const x = a.x, Y = a.y - (a.z || 0);
  c.fillStyle = "rgba(24,28,54,.20)";
  rrPath(c, x - 19, Y - 5, 38, 14, 3);
  c.fill();
  c.fillStyle = "#2b3757";
  rrPath(c, x - 18, Y - 40, 36, 31, 3);
  c.fill();
  c.fillStyle = "#3b4c78";
  rrPath(c, x - 18, Y - 40, 36, 15, 3);
  c.fill();
  c.fillStyle = "rgba(150,200,255,.20)";
  rrPath(c, x - 15, Y - 37, 30, 25, 2);
  c.fill();
  c.save();
  c.translate(x, Y - 24);
  c.rotate(Math.PI / 4);
  c.fillStyle = "rgba(190,225,255,.85)";
  c.fillRect(-3.2, -3.2, 6.4, 6.4);
  c.restore();
  c.fillStyle = "rgba(170,220,255,.35)";
  c.fillRect(x - 18, Y - 40, 36, 1.6);
  c.fillStyle = "#b9c3d8";
  rrPath(c, x - 19, Y - 9, 38, 16, 3);
  c.fill();
  c.fillStyle = "#eef2fa";
  rrPath(c, x - 19, Y - 11, 38, 14, 3);
  c.fill();
  c.fillStyle = "#98a4be";
  rrPath(c, x - 14, Y - 8, 28, 8, 2);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.35)";
  for (let i = 0; i < 3; i++) c.fillRect(x - 13, Y - 7.4 + i * 2.6, 26, 1.1);
  c.fillStyle = "#c3ccdf";
  rrPath(c, x - 4.5, Y + 1, 9, 3.4, 1.5);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.5)";
  c.fillRect(x - 19, Y - 11, 38, 1.3);
}

export function drawCup(c, a) {
  const x = a.x, Y = a.y - (a.z || 0), col = a.color || "#ffffff";
  c.fillStyle = "rgba(30,25,50,.20)";
  ell(c, x, Y + 1.5, 7.5, 3.2);
  c.fill();
  c.fillStyle = "#f7f4ee";
  rrPath(c, x - 5, Y - 11, 10, 12.5, 2.5);
  c.fill();
  c.fillStyle = col;
  rrPath(c, x - 5, Y - 11, 10, 4, 2.5);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.5)";
  c.fillRect(x - 3.8, Y - 9.5, 1.8, 9);
  c.strokeStyle = "#e2dbcd";
  c.lineWidth = 1.6;
  c.beginPath();
  c.arc(x + 6.2, Y - 6, 3.2, -1.2, 1.2);
  c.stroke();
  c.fillStyle = "rgba(120,80,50,.55)";
  ell(c, x, Y - 11, 4, 1.6);
  c.fill();
}

export function drawCupRow(c, a) {
  const cols = ["#2ec4a6", "#ffb648", "#4f7cff"];
  for (let i = 0; i < 3; i++) drawCup(c, { x: a.x - 16 + i * 16, y: a.y, z: a.z || 0, color: cols[i] });
}

export function drawPapers(c, a) {
  const x = a.x, Y = a.y - (a.z || 0);
  c.fillStyle = "rgba(30,25,50,.16)";
  rrPath(c, x - 13, Y - 6, 26, 15, 2);
  c.fill();
  c.save();
  c.translate(x - 4, Y - 2);
  c.rotate(-0.13);
  c.fillStyle = "#fdfcf7";
  rrPath(c, -13, -8, 26, 16, 2);
  c.fill();
  c.strokeStyle = "rgba(120,130,160,.5)";
  c.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    c.beginPath();
    c.moveTo(-9, -4 + i * 4);
    c.lineTo(4 + (i % 2) * 4, -4 + i * 4);
    c.stroke();
  }
  c.restore();
  c.save();
  c.translate(x + 7, Y + 2);
  c.rotate(0.2);
  c.fillStyle = "#ffffff";
  rrPath(c, -11, -8, 22, 15, 2);
  c.fill();
  c.fillStyle = "rgba(255,93,122,.55)";
  c.fillRect(-8, -5, 10, 2);
  c.fillRect(-8, -1, 14, 2);
  c.restore();
}

export function drawLamp(c, a) {
  const x = a.x, Y = a.y - (a.z || 0);
  c.fillStyle = "rgba(30,25,50,.18)";
  ell(c, x, Y + 2, 10, 4);
  c.fill();
  const glow = radGrad(c, x, Y - 20, 1, x, Y - 20, 26, [
    [0, "rgba(255,214,120,.40)"],
    [1, "rgba(255,214,120,0)"],
  ]);
  if (glow) {
    c.fillStyle = glow;
    ell(c, x, Y - 20, 26, 26);
    c.fill();
  }
  c.fillStyle = "#39445f";
  rrPath(c, x - 8, Y - 3, 16, 4, 2);
  c.fill();
  c.fillRect(x - 1.6, Y - 26, 3.2, 24);
  c.fillStyle = "#ffb648";
  poly(c, [[x - 11, Y - 26], [x + 11, Y - 26], [x + 6, Y - 40], [x - 6, Y - 40]]);
  c.fillStyle = "rgba(255,255,255,.4)";
  poly(c, [[x - 11, Y - 26], [x - 2, Y - 26], [x - 3, Y - 40], [x - 6, Y - 40]]);
  c.fillStyle = "#fff3cf";
  ell(c, x, Y - 26, 10, 3);
  c.fill();
}

export function drawDeskSign(c, a) {
  const x = a.x, Y = a.y - (a.z || 0);
  c.fillStyle = "rgba(30,25,50,.20)";
  rrPath(c, x - 22, Y - 2, 44, 7, 2);
  c.fill();
  c.fillStyle = "#1f9e85";
  poly(c, [[x - 22, Y], [x + 22, Y], [x + 17, Y - 18], [x - 17, Y - 18]]);
  c.fillStyle = "#2ec4a6";
  poly(c, [[x - 22, Y], [x + 2, Y], [x - 3, Y - 18], [x - 17, Y - 18]]);
  c.fillStyle = "rgba(255,255,255,.22)";
  c.fillRect(x - 17, Y - 18, 34, 2);
  c.fillStyle = "#06231d";
  c.font = "800 9px Outfit, sans-serif";
  c.textAlign = "center";
  c.fillText(a.text || "", x, Y - 5.5);
  c.textAlign = "left";
}

/* kitchen counter — solid carcass, worktop on top face, doors on front face */
export function drawCounter(c, a) {
  const x = a.x, y = a.y, w = a.w, d = a.d, h = a.h;
  ellShadow(c, x, y + d / 2 - 2, w * 0.52, d * 0.5, 0.22);
  solidBox(c, x, y, w, d, h, a.color, shade(a.color, -0.34), 6);
  const ty0 = y - d / 2 - h, ty1 = y + d / 2 - h, fy1 = y + d / 2;
  c.fillStyle = a.top || "#2b3550";
  rrPath(c, x - w / 2 + 4, ty0 + 4, w - 8, d - 8, 4);
  c.fill();
  c.save();
  rrPath(c, x - w / 2 + 4, ty0 + 4, w - 8, d - 8, 4);
  c.clip();
  c.fillStyle = "rgba(255,255,255,.12)";
  poly(c, [[x - w / 2, ty0], [x - w / 2 + w * 0.4, ty0], [x - w / 2 + w * 0.18, ty0 + d], [x - w / 2, ty0 + d]]);
  c.restore();
  c.strokeStyle = "rgba(255,255,255,.18)";
  c.lineWidth = 1.2;
  rrPath(c, x - w / 2 + 4, ty0 + 4, w - 8, d - 8, 4);
  c.stroke();
  const doors = 4, dw = (w - 24) / doors;
  for (let i = 0; i < doors; i++) {
    const dx = x - w / 2 + 12 + i * dw;
    c.fillStyle = "rgba(255,255,255,.10)";
    rrPath(c, dx, ty1 + 6, dw - 6, fy1 - ty1 - 14, 3);
    c.fill();
    c.strokeStyle = "rgba(40,50,80,.18)";
    c.lineWidth = 1;
    rrPath(c, dx, ty1 + 6, dw - 6, fy1 - ty1 - 14, 3);
    c.stroke();
    c.fillStyle = "#8d99b5";
    rrPath(c, dx + dw / 2 - 11, ty1 + 13, 22, 3.2, 1.6);
    c.fill();
  }
  c.fillStyle = "rgba(0,0,0,.14)";
  c.fillRect(x - w / 2, fy1 - 3, w, 3);
}

export function drawCoffeeMachine(c, a) {
  const x = a.x, Y = a.y - (a.z || 0);
  c.fillStyle = "rgba(20,26,48,.22)";
  rrPath(c, x - 21, Y - 8, 42, 14, 3);
  c.fill();
  solidBox(c, x, Y - 4, 42, 24, 40, "#39445f", "#232c42", 5);
  c.fillStyle = "#8fd3ff";
  rrPath(c, x - 15, Y - 38, 18, 14, 3);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.5)";
  rrPath(c, x - 13, Y - 36, 5, 10, 2);
  c.fill();
  c.fillStyle = "#ff5d7a";
  ell(c, x + 13, Y - 31, 3.2, 3.2);
  c.fill();
  c.fillStyle = "#2ec4a6";
  ell(c, x + 13, Y - 23, 3.2, 3.2);
  c.fill();
  c.fillStyle = "#c8d0e0";
  rrPath(c, x - 9, Y - 16, 20, 7, 2);
  c.fill();
  c.fillStyle = "#6b4a2f";
  rrPath(c, x - 5, Y - 15, 12, 4, 1.5);
  c.fill();
}

export function drawKettle(c, a) {
  const x = a.x, Y = a.y - (a.z || 0), col = a.color || "#ff5d7a";
  c.fillStyle = "rgba(20,26,48,.2)";
  ell(c, x, Y + 1, 11, 4.4);
  c.fill();
  c.fillStyle = col;
  rrPath(c, x - 10, Y - 19, 20, 20, 6);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.35)";
  rrPath(c, x - 8, Y - 17, 5, 15, 3);
  c.fill();
  c.fillStyle = shade(col, -0.35);
  rrPath(c, x - 11, Y - 22, 22, 5, 2.5);
  c.fill();
  c.strokeStyle = shade(col, -0.3);
  c.lineWidth = 2.4;
  c.beginPath();
  c.arc(x, Y - 27, 7, Math.PI, 0);
  c.stroke();
  c.strokeStyle = shade(col, -0.4);
  c.lineWidth = 2.6;
  c.beginPath();
  c.moveTo(x + 9, Y - 14);
  c.lineTo(x + 15, Y - 19);
  c.stroke();
}

export function drawWaterCooler(c, a) {
  const x = a.x, y = a.y, w = a.w, d = a.d, h = a.h || 48;
  ellShadow(c, x, y + d / 2, w * 0.62, d * 0.52, 0.22);
  solidBox(c, x, y, w, d, h, "#e6ebf6", "#b6c0d6", 6);
  const ty0 = y - d / 2 - h, fy0 = y + d / 2 - h;
  c.fillStyle = "#8d99b5";
  rrPath(c, x - w / 2 + 6, ty0 + 6, w - 12, d - 12, 3);
  c.fill();
  c.fillStyle = "rgba(140,205,255,.55)";
  rrPath(c, x - 13, ty0 - 38, 26, 40, 9);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.45)";
  rrPath(c, x - 9, ty0 - 34, 7, 30, 4);
  c.fill();
  c.fillStyle = "#8fd3ff";
  rrPath(c, x - 14, ty0 - 43, 28, 8, 3);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.4)";
  rrPath(c, x - 12, ty0 - 42, 10, 3, 1.5);
  c.fill();
  c.fillStyle = "#4f7cff";
  rrPath(c, x - 11, fy0 + 12, 9, 7, 2);
  c.fill();
  c.fillStyle = "#ff5d7a";
  rrPath(c, x + 2, fy0 + 12, 9, 7, 2);
  c.fill();
  c.fillStyle = "#98a4be";
  rrPath(c, x - 13, fy0 + 26, 26, 10, 3);
  c.fill();
}

export function drawCabinet(c, a) {
  const x = a.x, y = a.y, w = a.w, d = a.d, h = a.h || 68;
  ellShadow(c, x, y + d / 2 - 2, w * 0.52, d * 0.5, 0.26);
  solidBox(c, x, y, w, d, h, shade(a.color, 0.26), a.color, 5);
  const ty0 = y - d / 2 - h, fy0 = y + d / 2 - h, fy1 = y + d / 2;
  c.fillStyle = "rgba(255,255,255,.16)";
  rrPath(c, x - w / 2 + 6, ty0 + 5, w - 12, d - 10, 3);
  c.fill();
  const n = 3, dw = (w - 22) / n;
  for (let i = 0; i < n; i++) {
    const dx = x - w / 2 + 11 + i * dw;
    c.fillStyle = "rgba(255,255,255,.10)";
    rrPath(c, dx, fy0 + 7, dw - 6, fy1 - fy0 - 16, 3);
    c.fill();
    c.strokeStyle = "rgba(15,22,44,.22)";
    c.lineWidth = 1;
    rrPath(c, dx, fy0 + 7, dw - 6, fy1 - fy0 - 16, 3);
    c.stroke();
    c.fillStyle = "#dbe2f0";
    rrPath(c, dx + dw / 2 - 11, fy0 + 15, 22, 3.4, 1.7);
    c.fill();
  }
  solidBox(c, x - w / 4, y - 6, 52, d - 16, 20, "#e0b483", "#b98d5f", 3);
  solidBox(c, x + w / 4 - 6, y - 2, 46, d - 18, 15, "#d9a06a", "#b07c4c", 3);
}

export function drawPrinter(c, a) {
  const x = a.x, y = a.y, w = a.w, d = a.d, h = a.h || 46;
  ellShadow(c, x, y + d / 2 - 2, w * 0.55, d * 0.5, 0.24);
  solidBox(c, x, y, w, d, h, a.color, "#a8b3ca", 5);
  const ty0 = y - d / 2 - h, fy0 = y + d / 2 - h;
  c.fillStyle = "#39445f";
  rrPath(c, x - w / 2 + 11, ty0 + 9, w - 22, d * 0.45, 3);
  c.fill();
  c.fillStyle = "#ffffff";
  rrPath(c, x - 17, ty0 + 5, 34, 11, 2);
  c.fill();
  c.strokeStyle = "rgba(120,130,160,.5)";
  c.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    c.beginPath();
    c.moveTo(x - 13, ty0 + 8 + i * 3);
    c.lineTo(x + 9, ty0 + 8 + i * 3);
    c.stroke();
  }
  c.fillStyle = "#8d99b5";
  rrPath(c, x - w / 2 + 9, fy0 + 13, w - 18, 15, 3);
  c.fill();
  c.fillStyle = "#2ec4a6";
  ell(c, x + w / 2 - 15, fy0 + 8, 3, 3);
  c.fill();
  c.fillStyle = "#39445f";
  rrPath(c, x - w / 2 + 12, fy0 + 5, 26, 7, 2);
  c.fill();
}

export function drawCrates(c, a) {
  const x = a.x, y = a.y;
  ellShadow(c, x + 4, y + 20, 42, 15, 0.22);
  solidBox(c, x - 16, y + 8, 32, 28, 28, "#d9a06a", "#b07c4c", 4);
  solidBox(c, x + 19, y + 4, 28, 26, 24, "#c98a5e", "#a26c44", 4);
  c.save();
  c.translate(0, -28);
  solidBox(c, x - 16, y + 8, 30, 26, 24, "#e0b483", "#b98d5f", 4);
  c.restore();
  c.strokeStyle = "rgba(90,60,30,.28)";
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(x - 30, y - 6);
  c.lineTo(x - 2, y - 6);
  c.stroke();
}

/* SOFA — dir = way the sitter faces. Backrest opposite, arms on the two ends. */
export function drawSofa(c, a) {
  const x = a.x, y = a.y, w = a.w || 120, d = a.d || 60, dir = a.dir || "down", col = a.color || "#9b6cf5";
  const sh = a.sh || 22, bh = a.bh || 48, ah = a.ah || 34, bt = a.bt || 16, at = a.at || 15;
  const horiz = dir === "down" || dir === "up";
  ellShadow(c, x, y + d / 2 - 2, w * 0.62, d * 0.52, 0.26);

  if (horiz) {
    const by = dir === "down" ? y - d / 2 + bt / 2 : y + d / 2 - bt / 2;
    solidBox(c, x, by, w, bt, bh, shade(col, 0.12), shade(col, -0.38), 7);
  } else {
    const bx = dir === "right" ? x - w / 2 + bt / 2 : x + w / 2 - bt / 2;
    solidBox(c, bx, y, bt, d, bh, shade(col, 0.12), shade(col, -0.38), 7);
  }
  solidBox(c, x, y, w, d, sh, shade(col, 0.26), shade(col, -0.3), 7);
  if (horiz) {
    solidBox(c, x - w / 2 + at / 2, y, at, d, ah, shade(col, 0.02), shade(col, -0.42), 6);
    solidBox(c, x + w / 2 - at / 2, y, at, d, ah, shade(col, 0.02), shade(col, -0.42), 6);
  } else {
    solidBox(c, x, y - d / 2 + at / 2, w, at, ah, shade(col, 0.02), shade(col, -0.42), 6);
    solidBox(c, x, y + d / 2 - at / 2, w, at, ah, shade(col, 0.02), shade(col, -0.42), 6);
  }
  const n = 3, gap = 4;
  let ax, ay, aw, ah2;
  if (horiz) {
    ax = x - w / 2 + at + 3;
    aw = w - at * 2 - 6;
    ay = dir === "down" ? y - d / 2 + bt + 3 : y - d / 2 + 3;
    ah2 = d - bt - 6;
    const cw = (aw - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      flatRect(c, ax + i * (cw + gap), ay, cw, ah2, sh, shade(col, 0.36), 6);
      flatRect(c, ax + i * (cw + gap) + 4, ay + 4, cw - 8, 6, sh, "rgba(255,255,255,.22)", 3);
    }
  } else {
    ay = y - d / 2 + at + 3;
    ah2 = d - at * 2 - 6;
    ax = dir === "right" ? x - w / 2 + bt + 3 : x - w / 2 + 3;
    aw = w - bt - 6;
    const cd = (ah2 - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      flatRect(c, ax, ay + i * (cd + gap), aw, cd, sh, shade(col, 0.36), 6);
      flatRect(c, ax + 4, ay + i * (cd + gap) + 4, 6, cd - 8, sh, "rgba(255,255,255,.22)", 3);
    }
  }
  const pz = bh - 14;
  for (let i = 0; i < 2; i++) {
    if (horiz) {
      const py = dir === "down" ? y - d / 2 + bt + 2 : y + d / 2 - bt - 16;
      flatRect(c, x - w / 4 - 8 + i * (w / 2 - 4), py, 20, 15, pz, i ? "#ffb648" : "#2ec4a6", 5);
    } else {
      const px = dir === "right" ? x - w / 2 + bt + 2 : x + w / 2 - bt - 17;
      flatRect(c, px, y - d / 4 - 10 + i * (d / 2 - 6), 15, 22, pz, i ? "#ffb648" : "#2ec4a6", 5);
    }
  }
}

export function drawPlant(c, a) {
  const x = a.x, y = a.y, s = a.s || 1;
  c.save();
  c.translate(x, y);
  c.scale(s, s);
  c.translate(-x, -y);
  ellShadow(c, x, y + 7, 21, 8.5, 0.26);
  c.fillStyle = a.pot || "#c98a5e";
  poly(c, [[x - 15, y - 24], [x + 15, y - 24], [x + 11, y + 6], [x - 11, y + 6]]);
  c.fillStyle = "rgba(255,255,255,.22)";
  poly(c, [[x - 15, y - 24], [x - 6, y - 24], [x - 8, y + 6], [x - 11, y + 6]]);
  c.fillStyle = "rgba(0,0,0,.14)";
  poly(c, [[x + 15, y - 24], [x + 8, y - 24], [x + 6, y + 6], [x + 11, y + 6]]);
  c.fillStyle = shade(a.pot || "#c98a5e", 0.26);
  rrPath(c, x - 17, y - 29, 34, 7, 3);
  c.fill();
  c.fillStyle = "#3c2a1e";
  rrPath(c, x - 13, y - 25.5, 26, 4, 2);
  c.fill();
  const leaves = [[-26, -46, 0.62], [24, -52, -0.55], [-8, -70, 0.12], [16, -34, -0.95], [-18, -32, 1.05], [2, -52, -0.1]];
  for (let i = 0; i < leaves.length; i++) {
    const L = leaves[i], lx = x + L[0] * 0.55, ly = y + L[1] * 0.72 - 6;
    c.save();
    c.translate(lx, ly);
    c.rotate(L[2]);
    c.fillStyle = i % 2 ? "#2f9e6a" : "#37b87c";
    poly(c, [[0, 0], [9, -13], [3, -30], [-6, -24], [-8, -9]]);
    c.fillStyle = "rgba(255,255,255,.24)";
    poly(c, [[0, 0], [9, -13], [3, -30]]);
    c.strokeStyle = "rgba(20,60,40,.28)";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(2, -26);
    c.stroke();
    c.restore();
  }
  c.restore();
}

/** asset type → renderer registry. */
export const ASSET_DRAW = {
  desk: drawDesk,
  roundTable: drawRoundTable,
  chair: drawChair,
  stool: drawStool,
  laptop: drawLaptop,
  cup: drawCup,
  cupRow: drawCupRow,
  papers: drawPapers,
  lamp: drawLamp,
  deskSign: drawDeskSign,
  counter: drawCounter,
  coffeeMachine: drawCoffeeMachine,
  kettle: drawKettle,
  waterCooler: drawWaterCooler,
  cabinet: drawCabinet,
  printer: drawPrinter,
  crates: drawCrates,
  sofa: drawSofa,
  plant: drawPlant,
};

export function drawAsset(c, a) {
  const fn = ASSET_DRAW[a.asset];
  if (fn) fn(c, a);
}

/** Painters-order key: southern-most floor edge of the footprint. */
export function assetSortY(a) {
  if (typeof a.sort === "number") return a.sort;
  if (a.asset === "chair") {
    const d = a.d || 32;
    return a.dir === "down" ? a.y - d / 2 : a.dir === "up" ? a.y + d / 2 : a.y;
  }
  if (a.asset === "roundTable") return a.y + (a.r || 60) * SQ * 0.9;
  if (a.asset === "plant") return a.y + 8;
  return a.y + (a.d || 0) / 2;
}
