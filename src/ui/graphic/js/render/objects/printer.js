// render/objects/printer.js — office printer showcase file.
import { ell, ellShadow, rrPath, solidBox } from "../../core/utils.js";

export const Printer = {
  name: "printer",
  title: "Printer",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "printer", x: 0, y: 0, w: 92, d: 64, h: 46, color: "#dfe5f0",
},

  draw(c, a) { 
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
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return a.y + (a.d || 0) / 2;
}
};
