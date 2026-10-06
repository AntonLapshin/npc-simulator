// render/character.js — character rendering (prototype §8): body, hair,
// faces per emotion, mood FX and the name plate. A visual actor is:
//   { id, name, color, look, prop, x, y, dir, emotion, visible, isUser }

import { ell, ellShadow, poly, rrPath, rgba, shade } from "../core/utils.js";

/**
 * Draw one character. `opts.showNames` toggles the name plate; the user's
 * actor gets a "· YOU" suffix so the player can always spot themselves.
 */
export function drawCharacter(c, ch, opts = {}) {
  const L = ch.look, x = ch.x, y = ch.y, dir = ch.dir || "down";
  const prof = dir === "left" || dir === "right";
  const hy = y - 56;
  ellShadow(c, x, y + 1, 16.5, 6.4, 0.3);
  c.fillStyle = L.pants;
  rrPath(c, x - 8.6, y - 19, 7.4, 19, 3);
  c.fill();
  rrPath(c, x + 1.2, y - 19, 7.4, 19, 3);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.14)";
  c.fillRect(x - 8.6, y - 19, 2, 17);
  c.fillStyle = L.shoes;
  rrPath(c, x - 10, y - 5, 9.4, 5.4, 2.4);
  c.fill();
  rrPath(c, x + 0.8, y - 5, 9.4, 5.4, 2.4);
  c.fill();
  if (dir !== "up") {
    if (L.hairStyle === "long") {
      c.fillStyle = shade(L.hair, -0.22);
      rrPath(c, x - 14, hy - 6, 28, 32, 12);
      c.fill();
    } else if (L.hairStyle === "ponytail") {
      c.fillStyle = shade(L.hair, -0.18);
      poly(c, [
        [x + (dir === "left" ? 9 : -9), hy - 2],
        [x + (dir === "left" ? 17 : -17), hy + 8],
        [x + (dir === "left" ? 13 : -13), hy + 26],
        [x + (dir === "left" ? 5 : -5), hy + 16],
      ]);
    }
  }
  const ty0 = y - 45, ty1 = y - 14;
  c.beginPath();
  c.moveTo(x - 9.4, ty1);
  c.lineTo(x - 13.4, ty0 + 9);
  c.quadraticCurveTo(x - 13.8, ty0 - 1, x - 6.4, ty0 - 2);
  c.lineTo(x + 6.4, ty0 - 2);
  c.quadraticCurveTo(x + 13.8, ty0 - 1, x + 13.4, ty0 + 9);
  c.lineTo(x + 9.4, ty1);
  c.closePath();
  c.fillStyle = L.shirt;
  c.fill();
  c.save();
  c.clip();
  c.fillStyle = "rgba(255,255,255,.20)";
  poly(c, [[x - 14, ty0 - 2], [x - 3, ty0 - 2], [x - 7, ty1 + 2], [x - 14, ty1 + 2]]);
  c.fillStyle = L.shirt2;
  c.fillRect(x - 15, ty1 - 6, 30, 7);
  c.fillStyle = "rgba(0,0,0,.10)";
  c.fillRect(x + 4, ty0, 12, ty1 - ty0);
  c.restore();
  c.fillStyle = shade(L.shirt, -0.28);
  poly(c, [[x - 5, ty0 - 2], [x + 5, ty0 - 2], [x, ty0 + 6]]);
  c.fillStyle = L.skin2;
  rrPath(c, x - 3.6, hy + 11, 7.2, 7, 2);
  c.fill();
  c.fillStyle = L.shirt2;
  if (dir !== "left") {
    rrPath(c, x + 10.4, ty0 + 3, 5.6, 24, 3);
    c.fill();
  }
  if (dir !== "right") {
    rrPath(c, x - 16, ty0 + 3, 5.6, 24, 3);
    c.fill();
  }
  c.fillStyle = L.skin;
  if (dir !== "left") {
    rrPath(c, x + 10.8, ty0 + 22, 4.8, 7, 2.4);
    c.fill();
  }
  if (dir !== "right") {
    rrPath(c, x - 15.6, ty0 + 22, 4.8, 7, 2.4);
    c.fill();
  }
  if (ch.prop === "cup") {
    c.fillStyle = "#f7f4ee";
    rrPath(c, x + 13, y - 30, 9, 11, 2);
    c.fill();
    c.fillStyle = ch.color;
    rrPath(c, x + 13, y - 30, 9, 3.6, 2);
    c.fill();
    c.fillStyle = "rgba(255,255,255,.45)";
    c.fillRect(x + 14.4, y - 28, 2, 7);
    c.fillStyle = "rgba(255,255,255,.26)";
    ell(c, x + 19, y - 34, 4, 6);
    c.fill();
  }
  if (ch.prop === "bag") {
    c.fillStyle = "#3a4560";
    rrPath(c, x - 27, y - 30, 14, 19, 3);
    c.fill();
    c.fillStyle = "#4f7cff";
    rrPath(c, x - 27, y - 30, 14, 6, 3);
    c.fill();
    c.strokeStyle = "#2a3247";
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x - 20, y - 31, 5, Math.PI, 0);
    c.stroke();
    c.fillStyle = "rgba(255,255,255,.22)";
    c.fillRect(x - 25, y - 22, 3, 9);
  }
  c.fillStyle = L.skin;
  rrPath(c, x - 12.6, hy - 13.5, 25.2, 27, 11.5);
  c.fill();
  c.save();
  rrPath(c, x - 12.6, hy - 13.5, 25.2, 27, 11.5);
  c.clip();
  c.fillStyle = "rgba(255,255,255,.16)";
  poly(c, [[x - 13, hy - 14], [x - 3, hy - 14], [x - 8, hy + 14], [x - 13, hy + 14]]);
  c.fillStyle = "rgba(0,0,0,.07)";
  c.fillRect(x + 5, hy - 14, 9, 28);
  c.restore();
  if (!prof) {
    c.fillStyle = L.skin2;
    ell(c, x - 13, hy + 2.5, 3.1, 3.1);
    c.fill();
    ell(c, x + 13, hy + 2.5, 3.1, 3.1);
    c.fill();
  }
  drawHair(c, x, hy, L, dir);
  if (dir !== "up") drawFace(c, x, hy, dir, ch.emotion, L);
  drawMoodFx(c, x, hy, ch.emotion);
  if (opts.showNames) {
    const nm = ((ch.name || "") + (ch.isUser ? " · YOU" : "")).toUpperCase();
    c.font = "800 9px Outfit, sans-serif";
    const w = c.measureText(nm).width + 13;
    c.fillStyle = "rgba(8,12,22,.62)";
    rrPath(c, x - w / 2, y + 6, w, 14, 7);
    c.fill();
    c.strokeStyle = rgba(ch.color, ch.isUser ? 0.9 : 0.55);
    c.lineWidth = ch.isUser ? 1.6 : 1;
    rrPath(c, x - w / 2, y + 6, w, 14, 7);
    c.stroke();
    c.fillStyle = ch.color;
    c.textAlign = "center";
    c.fillText(nm, x, y + 16.2);
    c.textAlign = "left";
  }
}

export function drawHair(c, x, hy, L, dir) {
  const col = L.hair, st = L.hairStyle, prof = dir === "left" || dir === "right";
  const off = prof ? (dir === "left" ? -1.6 : 1.6) : 0;
  c.fillStyle = col;
  if (st === "short") {
    c.beginPath();
    c.moveTo(x - 13.4 + off, hy + 1);
    c.quadraticCurveTo(x - 14 + off, hy - 16, x + off, hy - 16.4);
    c.quadraticCurveTo(x + 14 + off, hy - 16, x + 13.4 + off, hy + 1);
    c.lineTo(x + 9 + off, hy - 3);
    c.quadraticCurveTo(x + off, hy - 9, x - 9 + off, hy - 3);
    c.closePath();
    c.fill();
    c.fillStyle = shade(col, -0.22);
    poly(c, [[x + 4 + off, hy - 15.4], [x + 13.4 + off, hy + 1], [x + 9 + off, hy - 3]]);
    c.fillStyle = "rgba(255,255,255,.18)";
    poly(c, [[x - 9 + off, hy - 12], [x - 2 + off, hy - 15.6], [x - 4 + off, hy - 8]]);
  } else if (st === "bun") {
    ell(c, x - 1 + off, hy - 17, 8.4, 8.4);
    c.fill();
    c.fillStyle = shade(col, 0.16);
    ell(c, x - 3.5, hy - 19.5, 3.4, 3.4);
    c.fill();
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(x - 13.2, hy + 3);
    c.quadraticCurveTo(x - 14, hy - 15, x, hy - 15.6);
    c.quadraticCurveTo(x + 14, hy - 15, x + 13.2, hy + 3);
    c.lineTo(x + 11, hy - 2);
    c.quadraticCurveTo(x + 4, hy - 9, x - 4, hy - 6);
    c.quadraticCurveTo(x - 9, hy - 4, x - 11, hy + 1);
    c.closePath();
    c.fill();
    c.fillStyle = "rgba(255,255,255,.15)";
    poly(c, [[x - 11, hy - 9], [x - 3, hy - 14], [x - 6, hy - 6]]);
  } else if (st === "long") {
    c.beginPath();
    c.moveTo(x - 14.6, hy + 16);
    c.quadraticCurveTo(x - 16, hy - 16, x, hy - 16.4);
    c.quadraticCurveTo(x + 16, hy - 16, x + 14.6, hy + 16);
    c.lineTo(x + 10, hy + 14);
    c.quadraticCurveTo(x + 12, hy - 4, x + 5, hy - 7);
    c.quadraticCurveTo(x, hy - 9, x - 5, hy - 7);
    c.quadraticCurveTo(x - 12, hy - 4, x - 10, hy + 14);
    c.closePath();
    c.fill();
    c.fillStyle = "rgba(255,255,255,.14)";
    poly(c, [[x - 12, hy - 8], [x - 4, hy - 15], [x - 7, hy - 4]]);
    c.fillStyle = shade(col, -0.24);
    rrPath(c, x - 15, hy + 8, 5, 14, 2.5);
    c.fill();
    rrPath(c, x + 10, hy + 8, 5, 14, 2.5);
    c.fill();
  } else if (st === "ponytail") {
    c.beginPath();
    c.moveTo(x - 13.4, hy + 2);
    c.quadraticCurveTo(x - 14, hy - 16, x, hy - 16.4);
    c.quadraticCurveTo(x + 14, hy - 16, x + 13.4, hy + 2);
    c.lineTo(x + 10, hy - 3);
    c.quadraticCurveTo(x + 2, hy - 10, x - 6, hy - 6);
    c.quadraticCurveTo(x - 10, hy - 3, x - 11, hy + 1);
    c.closePath();
    c.fill();
    c.fillStyle = "rgba(255,255,255,.20)";
    poly(c, [[x - 10, hy - 10], [x - 2, hy - 15], [x - 5, hy - 6]]);
    c.fillStyle = "#ffb648";
    c.fillRect(x + (dir === "left" ? 7 : -9), hy - 2, 3, 4);
  } else if (st === "curly") {
    const curls = [[-11, -8, 7.4], [-3, -14, 8.2], [6, -12, 7.8], [12, -4, 6.8], [-13, 1, 6.4], [13, 4, 6.2], [0, -17, 6.6]];
    for (let i = 0; i < curls.length; i++) {
      const p = curls[i];
      ell(c, x + p[0], hy + p[1], p[2], p[2]);
      c.fill();
    }
    c.fillStyle = "rgba(255,255,255,.16)";
    ell(c, x - 6, hy - 13, 3.2, 3.2);
    c.fill();
    ell(c, x + 4, hy - 15, 2.8, 2.8);
    c.fill();
    c.fillStyle = shade(col, -0.28);
    ell(c, x - 12, hy + 6, 5.6, 5.6);
    c.fill();
    ell(c, x + 12, hy + 7, 5.4, 5.4);
    c.fill();
  }
}

/**
 * Face per emotion. Unknown emotion strings (the engine's `emotion` field is
 * free-form) fall through to the neutral default — never throws.
 */
export function drawFace(c, x, hy, dir, emo, L) {
  const prof = dir === "left" || dir === "right";
  const fx = x + (prof ? (dir === "left" ? -4 : 4) : 0),
    ex = prof ? 4.2 : 4.7,
    ink = "#2b2340";
  c.lineCap = "round";
  c.lineJoin = "round";
  const blush = (a) => {
    c.fillStyle = "rgba(255,120,140," + a + ")";
    ell(c, fx - ex - 1.4, hy + 4.4, 3.1, 2);
    c.fill();
    ell(c, fx + ex + 1.4, hy + 4.4, 3.1, 2);
    c.fill();
  };
  const eyeDot = (px, py) => {
    c.fillStyle = ink;
    ell(c, px, py, 1.95, 1.95);
    c.fill();
    c.fillStyle = "rgba(255,255,255,.85)";
    ell(c, px - 0.6, py - 0.7, 0.85, 0.85);
    c.fill();
  };
  const eyeArc = (px, py, up) => {
    c.strokeStyle = ink;
    c.lineWidth = 1.9;
    c.beginPath();
    c.arc(px, py + (up ? 1.2 : -1.2), 2.9, up ? Math.PI * 1.15 : Math.PI * 0.15, up ? Math.PI * 1.85 : Math.PI * 0.85);
    c.stroke();
  };
  const eyeWide = (px, py) => {
    c.fillStyle = "#fff";
    ell(c, px, py, 3.1, 3.5);
    c.fill();
    c.fillStyle = ink;
    ell(c, px, py + 0.4, 1.8, 1.8);
    c.fill();
    c.fillStyle = "rgba(255,255,255,.9)";
    ell(c, px - 0.7, py - 0.5, 0.75, 0.75);
    c.fill();
    c.strokeStyle = "rgba(43,35,64,.5)";
    c.lineWidth = 1;
    ell(c, px, py, 3.1, 3.5);
    c.stroke();
  };
  const brow = (px, py, rot, len) => {
    len = len || 4.6;
    c.save();
    c.translate(px, py);
    c.rotate(rot);
    c.strokeStyle = shade(L.hair, -0.05);
    c.lineWidth = 1.9;
    c.beginPath();
    c.moveTo(-len, 0);
    c.lineTo(len, 0);
    c.stroke();
    c.restore();
  };
  const mouth = (fn) => {
    c.strokeStyle = ink;
    c.lineWidth = 1.8;
    fn();
    c.stroke();
  };
  switch (emo) {
    case "happy":
      eyeArc(fx - ex, hy + 0.6, true);
      eyeArc(fx + ex, hy + 0.6, true);
      brow(fx - ex, hy - 5.4, -0.06);
      brow(fx + ex, hy - 5.4, 0.06);
      mouth(() => {
        c.beginPath();
        c.arc(fx, hy + 5.2, 3.6, 0.15 * Math.PI, 0.85 * Math.PI);
      });
      blush(0.28);
      break;
    case "excited":
      c.fillStyle = ink;
      [[fx - ex, hy + 0.4], [fx + ex, hy + 0.4]].forEach((p) => {
        c.save();
        c.translate(p[0], p[1]);
        c.beginPath();
        for (let i = 0; i < 8; i++) {
          const a2 = (i * Math.PI) / 4, r2 = i % 2 ? 1.3 : 3.3;
          c.lineTo(Math.cos(a2) * r2, Math.sin(a2) * r2);
        }
        c.closePath();
        c.fill();
        c.restore();
      });
      brow(fx - ex, hy - 6.6, -0.14);
      brow(fx + ex, hy - 6.6, 0.14);
      c.fillStyle = "#7d3b4a";
      ell(c, fx, hy + 7, 4.1, 3.4);
      c.fill();
      c.fillStyle = "#fff";
      c.fillRect(fx - 3.6, hy + 4.1, 7.2, 1.9);
      blush(0.34);
      break;
    case "nervous":
      eyeWide(fx - ex, hy + 0.6);
      eyeWide(fx + ex, hy + 0.6);
      brow(fx - ex, hy - 5.8, 0.3);
      brow(fx + ex, hy - 5.8, -0.3);
      mouth(() => {
        c.beginPath();
        c.moveTo(fx - 4.2, hy + 7);
        for (let i = 0; i <= 4; i++) c.lineTo(fx - 4.2 + i * 2.1, hy + 7 + (i % 2 ? -1.5 : 1.5));
      });
      c.fillStyle = "#8fd3ff";
      poly(c, [[fx + 13, hy - 9], [fx + 16, hy - 4], [fx + 13, hy - 1], [fx + 10, hy - 4]]);
      c.fillStyle = "rgba(255,255,255,.7)";
      c.fillRect(fx + 11.4, hy - 7.4, 1.4, 3);
      break;
    case "surprised":
      eyeWide(fx - ex, hy + 0.2);
      eyeWide(fx + ex, hy + 0.2);
      brow(fx - ex, hy - 7.4, -0.1);
      brow(fx + ex, hy - 7.4, 0.1);
      c.fillStyle = "#6d3a48";
      ell(c, fx, hy + 7.4, 2.6, 3.2);
      c.fill();
      break;
    case "shy":
      eyeArc(fx - ex, hy + 1.4, false);
      eyeArc(fx + ex, hy + 1.4, false);
      brow(fx - ex, hy - 5.2, -0.2);
      brow(fx + ex, hy - 5.2, 0.2);
      mouth(() => {
        c.beginPath();
        c.arc(fx + 0.6, hy + 5.6, 2.4, 0.15 * Math.PI, 0.85 * Math.PI);
      });
      blush(0.55);
      break;
    case "confident":
      c.strokeStyle = ink;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(fx - ex - 2.6, hy + 0.6);
      c.lineTo(fx - ex + 2.6, hy + 0.6);
      c.stroke();
      c.beginPath();
      c.moveTo(fx + ex - 2.6, hy + 0.2);
      c.lineTo(fx + ex + 2.6, hy + 0.2);
      c.stroke();
      c.fillStyle = ink;
      ell(c, fx + ex, hy + 1.4, 1.5, 1.5);
      c.fill();
      brow(fx - ex, hy - 5.6, -0.05);
      brow(fx + ex, hy - 7.2, 0.22, 5);
      mouth(() => {
        c.beginPath();
        c.moveTo(fx - 3.4, hy + 6.6);
        c.quadraticCurveTo(fx + 2, hy + 8.6, fx + 4.4, hy + 5);
      });
      break;
    case "thinking":
      eyeDot(fx - ex - 1.2, hy - 0.6);
      eyeDot(fx + ex - 1.2, hy - 0.6);
      brow(fx - ex, hy - 6.2, 0.16);
      brow(fx + ex, hy - 5.2, -0.24);
      mouth(() => {
        c.beginPath();
        c.moveTo(fx - 2.4, hy + 7);
        c.lineTo(fx + 2.6, hy + 6.4);
      });
      c.fillStyle = "rgba(143,211,255,.9)";
      c.font = "800 10px Outfit, sans-serif";
      c.textAlign = "center";
      c.fillText("?", fx + 15, hy - 9);
      c.textAlign = "left";
      break;
    case "proud":
      eyeArc(fx - ex, hy + 0.6, true);
      eyeArc(fx + ex, hy + 0.6, true);
      brow(fx - ex, hy - 6, -0.1);
      brow(fx + ex, hy - 6, 0.1);
      mouth(() => {
        c.beginPath();
        c.arc(fx, hy + 4.8, 4, 0.1 * Math.PI, 0.9 * Math.PI);
      });
      blush(0.26);
      c.fillStyle = "rgba(255,209,102,.9)";
      poly(c, [
        [fx + 13, hy - 13], [fx + 15, hy - 9], [fx + 19, hy - 8], [fx + 15.6, hy - 5.4], [fx + 16.4, hy - 1.4],
        [fx + 13, hy - 3.6], [fx + 9.6, hy - 1.4], [fx + 10.4, hy - 5.4], [fx + 7, hy - 8], [fx + 11, hy - 9],
      ]);
      break;
    case "sad":
      eyeDot(fx - ex, hy + 1.2);
      eyeDot(fx + ex, hy + 1.2);
      brow(fx - ex, hy - 5, 0.34);
      brow(fx + ex, hy - 5, -0.34);
      mouth(() => {
        c.beginPath();
        c.arc(fx, hy + 9.6, 3.2, Math.PI * 1.2, Math.PI * 1.8);
      });
      break;
    case "annoyed":
      c.strokeStyle = ink;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(fx - ex - 2.6, hy + 1);
      c.lineTo(fx - ex + 2.6, hy + 0.2);
      c.stroke();
      c.beginPath();
      c.moveTo(fx + ex - 2.6, hy + 0.2);
      c.lineTo(fx + ex + 2.6, hy + 1);
      c.stroke();
      brow(fx - ex, hy - 5.4, 0.3);
      brow(fx + ex, hy - 5.4, -0.3);
      mouth(() => {
        c.beginPath();
        c.moveTo(fx - 3.4, hy + 7.4);
        c.lineTo(fx + 3.4, hy + 7.4);
      });
      break;
    default:
      eyeDot(fx - ex, hy + 0.6);
      eyeDot(fx + ex, hy + 0.6);
      brow(fx - ex, hy - 5.4, -0.04);
      brow(fx + ex, hy - 5.4, 0.04);
      mouth(() => {
        c.beginPath();
        c.moveTo(fx - 2.8, hy + 6.8);
        c.lineTo(fx + 2.8, hy + 6.8);
      });
  }
  if (prof) {
    c.fillStyle = L.skin2;
    const nx = fx + (dir === "left" ? -6.6 : 6.6);
    poly(c, [[nx, hy + 1.4], [nx + (dir === "left" ? -3 : 3), hy + 4], [nx, hy + 5]]);
  }
  c.lineCap = "butt";
}

export function drawMoodFx(c, x, hy, emo) {
  if (emo === "excited") {
    c.strokeStyle = "rgba(255,209,102,.9)";
    c.lineWidth = 1.8;
    c.lineCap = "round";
    const sp = [[-19, -16], [19, -20], [0, -27]];
    sp.forEach((p) => {
      c.beginPath();
      c.moveTo(x + p[0] * 0.72, hy + p[1] * 0.8);
      c.lineTo(x + p[0], hy + p[1]);
      c.stroke();
    });
    c.lineCap = "butt";
  }
  if (emo === "surprised") {
    c.fillStyle = "rgba(143,211,255,.9)";
    c.font = "800 13px Outfit, sans-serif";
    c.textAlign = "center";
    c.fillText("!", x + 17, hy - 14);
    c.textAlign = "left";
  }
}
