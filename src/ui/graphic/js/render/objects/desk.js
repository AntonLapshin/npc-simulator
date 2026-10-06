// render/objects/desk.js — desk showcase file (showcase pattern).
//
// Each object file owns its renderer + showcase metadata: `name`,
// `supportsDirection`, `defaultProps` and the variant list the gallery uses.
// The main scene composes these; showcase.html renders each in isolation.

import { ellShadow, gemBox, rrPath, shade, solidBox } from "../../core/utils.js";


/** Slab (t) at height h on 4 legs + under-desk drawer pedestal. */

/** Painters-order key: southern-most floor edge of the footprint. */

export const Desk = {
  name: "desk",
  title: "Desk",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "desk",
  x: 0,
  y: 0,
  w: 170,
  d: 76,
  h: 44,
  t: 10,
  color: "#f4ece0",
  edge: "#c9b694",
},

  draw(c, a) { 
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
},
  sortY(a) { 
  return a.y + (a.d || 0) / 2;
}
};
