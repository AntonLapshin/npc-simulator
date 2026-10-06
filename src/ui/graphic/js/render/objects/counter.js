// render/objects/counter.js — kitchen counter showcase file.
import { ellShadow, poly, rrPath, shade, solidBox } from "../../core/utils.js";


/** Solid carcass, worktop on top face, doors on front face. */

export const Counter = {
  name: "counter",
  title: "Counter",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "counter", x: 0, y: 0, w: 242, d: 58, h: 58,
  color: "#eaeef7", top: "#2b3550",
},

  draw(c, a) { 
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
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return a.y + (a.d || 0) / 2;
}
};
