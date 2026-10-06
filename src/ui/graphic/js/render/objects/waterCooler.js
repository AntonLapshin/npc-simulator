// render/objects/waterCooler.js — water cooler showcase file.
import { ellShadow, rrPath, solidBox } from "../../core/utils.js";

export const WaterCooler = {
  name: "waterCooler",
  title: "Water Cooler",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "waterCooler", x: 0, y: 0, w: 44, d: 42, h: 48,
},

  draw(c, a) { 
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
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return a.y + (a.d || 0) / 2;
}
};
