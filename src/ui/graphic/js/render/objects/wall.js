// render/objects/wall.js — wall segment showcase file.
import { linGrad, poly, shade } from "../../core/utils.js";

export const Wall = {
  name: "wall",
  title: "Wall",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "wall", id: "wall", x: 0, y: 0, w: 220, h: 20, height: 70,
  face: "#dfe5f2", top: "#f4f7fd", layer: "back",
},

  draw(c, w) { 
  const y0 = w.y + w.h - w.height, y1 = w.y + w.h;
  const g = linGrad(c, 0, y0, 0, y1, [[0, w.face], [1, shade(w.face, -0.14)]]);
  c.fillStyle = g || w.face;
  c.fillRect(w.x, y0, w.w, y1 - y0);
  c.fillStyle = w.top;
  c.fillRect(w.x, y0, w.w, 7);
  c.fillStyle = "rgba(255,255,255,.75)";
  c.fillRect(w.x, y0, w.w, 1.6);
  c.save();
  c.beginPath();
  c.rect(w.x, y0, w.w, y1 - y0);
  c.clip();
  c.fillStyle = "rgba(255,255,255,.09)";
  for (let i = -40; i < w.w; i += 90) poly(c, [[w.x + i, y1], [w.x + i + 34, y1], [w.x + i + 70, y0], [w.x + i + 36, y0]]);
  c.fillStyle = "rgba(30,40,80,.10)";
  c.fillRect(w.x, y1 - 5, w.w, 5);
  c.restore();
  c.strokeStyle = "rgba(40,50,90,.16)";
  c.lineWidth = 1;
  c.strokeRect(w.x + 0.5, y0 + 0.5, w.w - 1, y1 - y0 - 1);
},
  sortY() { 
  return -Infinity;
}
};
