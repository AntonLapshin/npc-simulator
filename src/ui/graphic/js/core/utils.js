// core/utils.js — math, color and canvas drawing helpers.
//
// Pure functions only (no DOM access), extracted verbatim in spirit from the
// prototype's §1 UTILITIES. Everything here is shared by the render modules.
//
// PROJECTION MODEL (kept from the prototype):
// • Floor maps 1:1 to screen (true plan). Height `h` extrudes STRAIGHT UP.
//     top face   : (x-w/2, y-d/2-h) … (x+w/2, y+d/2-h)
//     front face : (x-w/2, y+d/2-h) … (x+w/2, y+d/2-h+t)
// • t = top-slab thickness. t === h → SOLID box.
// • Props standing ON a surface use FLOOR coords inside the parent footprint
//   plus z = parent height → screen y = floorY - z.
// • Circles squash vertically by SQ = 0.5 (top AND footprint, consistently).
// • Painters order key = southern-most floor edge of the footprint.

/** Vertical squash factor for circles/ellipses in the 2.5D projection. */
export const SQ = 0.5;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const fin = (v) => typeof v === "number" && isFinite(v);

export function hex2rgb(h) {
  if (typeof h !== "string") return { r: 180, g: 180, b: 190 };
  h = h.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.substr(0, 2), 16);
  const g = parseInt(h.substr(2, 2), 16);
  const b = parseInt(h.substr(4, 2), 16);
  return { r: isNaN(r) ? 180 : r, g: isNaN(g) ? 180 : g, b: isNaN(b) ? 190 : b };
}

/** Lighten (amt > 0) or darken (amt < 0) a hex color; returns css rgb(). */
export function shade(hex, amt) {
  const { r, g, b } = hex2rgb(hex);
  const f = (c) => (amt >= 0 ? Math.round(c + (255 - c) * amt) : Math.round(c * (1 + amt)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

export function rgba(hex, a) {
  const { r, g, b } = hex2rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Deterministic PRNG (mulberry32) — stable textures across repaints. */
export function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rounded-rect path (guarded against non-finite geometry). */
export function rrPath(c, x, y, w, h, r) {
  if (!fin(x) || !fin(y) || !fin(w) || !fin(h)) return;
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export function poly(c, pts) {
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.closePath();
  c.fill();
}

export function ell(c, x, y, rx, ry) {
  if (rx > 0 && ry > 0 && fin(x) && fin(y)) c.beginPath(), c.ellipse(x, y, rx, ry, 0, 0, 6.2832);
}

/* guarded gradients — canvas throws NotSupportedError on non-finite args */
export function linGrad(c, x0, y0, x1, y1, stops) {
  if (!fin(x0) || !fin(y0) || !fin(x1) || !fin(y1)) return null;
  const g = c.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((s) => g.addColorStop(s[0], s[1]));
  return g;
}

export function radGrad(c, x0, y0, r0, x1, y1, r1, stops) {
  if (!fin(x0) || !fin(y0) || !fin(x1) || !fin(y1) || !(r0 >= 0) || !(r1 > 0)) return null;
  const g = c.createRadialGradient(x0, y0, r0, x1, y1, r1);
  stops.forEach((s) => g.addColorStop(s[0], s[1]));
  return g;
}

/** Soft elliptical ground shadow. */
export function ellShadow(c, x, y, rx, ry, a, col) {
  a = a === undefined ? 0.26 : a;
  col = col || "26,20,44";
  if (!(rx > 0) || !(ry > 0) || !fin(x) || !fin(y)) return;
  const g = radGrad(c, 0, 0, rx * 0.05, 0, 0, rx, [
    [0, `rgba(${col},${a})`],
    [0.55, `rgba(${col},${a * 0.5})`],
    [1, `rgba(${col},0)`],
  ]);
  if (!g) return;
  c.save();
  c.translate(x, y);
  c.scale(1, ry / rx);
  c.fillStyle = g;
  c.beginPath();
  c.arc(0, 0, rx, 0, 6.2832);
  c.fill();
  c.restore();
}

/** Faceted "gem" box: top slab of thickness t at height h over a front face. */
export function gemBox(c, x, y, w, d, h, t, top, side, r, alpha) {
  if (!fin(x) || !fin(y) || !(w > 0) || !(d > 0) || !(h > 0)) return;
  t = t === undefined || !(t > 0) ? h : Math.min(t, h);
  r = r === undefined ? 7 : r;
  alpha = alpha === undefined ? 1 : alpha;
  const x0 = x - w / 2, x1 = x + w / 2, ty0 = y - d / 2 - h, ty1 = y + d / 2 - h;
  c.save();
  c.globalAlpha = alpha;
  c.fillStyle = side; rrPath(c, x0, ty1, w, t, Math.min(r, t / 2)); c.fill();
  c.fillStyle = "rgba(255,255,255,.10)"; c.fillRect(x0, ty1, w, 1.5);
  c.fillStyle = "rgba(0,0,0,.16)"; c.fillRect(x0, ty1 + t - 1.6, w, 1.6);
  c.fillStyle = top; rrPath(c, x0, ty0, w, d, r); c.fill();
  c.save();
  rrPath(c, x0, ty0, w, d, r); c.clip();
  c.fillStyle = "rgba(255,255,255,.15)"; poly(c, [[x0, ty0], [x0 + w * 0.44, ty0], [x0, ty0 + d]]);
  c.fillStyle = "rgba(0,0,0,.06)"; poly(c, [[x1, ty0 + d * 0.38], [x1, ty0 + d], [x0 + w * 0.46, ty0 + d]]);
  c.restore();
  c.strokeStyle = "rgba(20,24,48,.15)"; c.lineWidth = 1.1; rrPath(c, x0, ty0, w, d, r); c.stroke();
  c.fillStyle = "rgba(255,255,255,.34)"; c.fillRect(x0 + r, ty0 + 1.3, Math.max(0, w - 2 * r), 1.4);
  c.restore();
}

/** Solid box (slab thickness === height). */
export function solidBox(c, x, y, w, d, h, top, side, r) {
  gemBox(c, x, y, w, d, h, h, top, side, r === undefined ? 6 : r);
}

/** Flat rect lying on a surface: floor coords + lift z. */
export function flatRect(c, fx, fy, fw, fh, z, color, r) {
  if (!(fw > 0) || !(fh > 0)) return;
  c.fillStyle = color;
  rrPath(c, fx, fy - (z || 0), fw, fh, r === undefined ? 4 : r);
  c.fill();
}

/** easeInOutQuad — used by movement tweens. */
export function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Deterministic 32-bit string hash (presentation fallbacks). */
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
