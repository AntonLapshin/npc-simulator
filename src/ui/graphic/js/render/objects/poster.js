// render/objects/poster.js — poster decor showcase file.
import { poly, rrPath, rgba } from "../../core/utils.js";

export const Poster = {
  name: "poster",
  title: "Poster",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "poster", id: "poster", x: 0, y: 0, w: 36, h: 46, color: "#ff5d7a",
},

  draw(c, d) { 
  c.fillStyle = "rgba(20,26,48,.16)";
  rrPath(c, d.x + 2, d.y + 3, d.w, d.h, 4);
  c.fill();
  c.fillStyle = "#fbfcff";
  rrPath(c, d.x, d.y, d.w, d.h, 4);
  c.fill();
  c.save();
  rrPath(c, d.x + 3, d.y + 3, d.w - 6, d.h - 6, 2);
  c.clip();
  c.fillStyle = rgba(d.color, 0.85);
  poly(c, [[d.x + 3, d.y + d.h - 3], [d.x + d.w * 0.5, d.y + 6], [d.x + d.w - 3, d.y + d.h - 3]]);
  c.fillStyle = "rgba(255,255,255,.45)";
  poly(c, [[d.x + 3, d.y + d.h - 3], [d.x + d.w * 0.5, d.y + 6], [d.x + d.w * 0.36, d.y + d.h - 3]]);
  c.restore();
},
  sortY() { 
  return -Infinity;
}
};
