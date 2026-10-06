// render/objects/plant.js — potted plant showcase file.
import { ellShadow, poly, rrPath, shade } from "../../core/utils.js";

export const Plant = {
  name: "plant",
  title: "Plant",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: { asset: "plant", x: 0, y: 0, s: 1.0, pot: "#2ec4a6" },

  draw(c, a) { 
  const x = a.x, y = a.y, s = a.s || 1;
  c.save();
  c.translate(x, y);
  c.scale(s, s);
  c.translate(-x, -y);
  ellShadow(c, x, y + 7, 21, 8.5, 0.26);
  c.fillStyle = a.pot || "#c98a5e";
  poly(c, [[x - 15, y - 24], [x + 15, y - 24], [x + 11, y + 6], [x - 11, y + 6]]);
  c.fillStyle = "rgba(255,255,255,.22)";
  poly(c, [[x - 15, y - 24], [x - 6, y - 24], [x - 8, y + 6], [x - 11, y + 6]]);
  c.fillStyle = "rgba(0,0,0,.14)";
  poly(c, [[x + 15, y - 24], [x + 8, y - 24], [x + 6, y + 6], [x + 11, y + 6]]);
  c.fillStyle = shade(a.pot || "#c98a5e", 0.26);
  rrPath(c, x - 17, y - 29, 34, 7, 3);
  c.fill();
  c.fillStyle = "#3c2a1e";
  rrPath(c, x - 13, y - 25.5, 26, 4, 2);
  c.fill();
  const leaves = [[-26, -46, 0.62], [24, -52, -0.55], [-8, -70, 0.12], [16, -34, -0.95], [-18, -32, 1.05], [2, -52, -0.1]];
  for (let i = 0; i < leaves.length; i++) {
    const L = leaves[i], lx = x + L[0] * 0.55, ly = y + L[1] * 0.72 - 6;
    c.save();
    c.translate(lx, ly);
    c.rotate(L[2]);
    c.fillStyle = i % 2 ? "#2f9e6a" : "#37b87c";
    poly(c, [[0, 0], [9, -13], [3, -30], [-6, -24], [-8, -9]]);
    c.fillStyle = "rgba(255,255,255,.24)";
    poly(c, [[0, 0], [9, -13], [3, -30]]);
    c.strokeStyle = "rgba(20,60,40,.28)";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(2, -26);
    c.stroke();
    c.restore();
  }
  c.restore();
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return (a.y || 0) + 8;
}
};
