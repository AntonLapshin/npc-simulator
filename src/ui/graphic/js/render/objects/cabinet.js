// render/objects/cabinet.js — storage cabinet showcase file.
import { ellShadow, rrPath, shade, solidBox } from "../../core/utils.js";

export const Cabinet = {
  name: "cabinet",
  title: "Cabinet",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "cabinet", x: 0, y: 0, w: 190, d: 60, h: 68, color: "#5b6b8c",
},

  draw(c, a) { 
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
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return a.y + (a.d || 0) / 2;
}
};
