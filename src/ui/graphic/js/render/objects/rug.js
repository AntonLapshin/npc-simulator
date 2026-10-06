// render/objects/rug.js — floor rug showcase file.
import { poly, rrPath, rgba } from "../../core/utils.js";

export const Rug = {
  name: "rug",
  title: "Rug",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "rug", id: "rug", x: 0, y: 0, w: 290, h: 215,
  color: "#4f7cff", trim: "#9b6cf5",
},

  draw(c, d) { 
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
},
  sortY() { 
  return -Infinity;
}
};
