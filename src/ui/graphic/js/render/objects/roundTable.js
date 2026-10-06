// render/objects/roundTable.js — round table showcase file.
import { SQ, ell, ellShadow, poly } from "../../core/utils.js";


/** Top ellipse centre is exactly (x, y-h). */

export const RoundTable = {
  name: "roundTable",
  title: "Round Table",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "roundTable", x: 0, y: 0, r: 74, h: 42, t: 9,
  color: "#f7f0e4", edge: "#c9b694",
},

  draw(c, a) { 
  const x = a.x, y = a.y, r = a.r || 70, h = a.h || 42, t = a.t || 9;
  const rx = r, ry = r * SQ, topCY = y - h;
  ellShadow(c, x, y + ry * 0.5, rx * 1.02, ry, 0.24);
  c.fillStyle = "#7f8ca8";
  ell(c, x, y + ry * 0.44, rx * 0.44, ry * 0.46);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.16)";
  ell(c, x - 7, y + ry * 0.36, rx * 0.2, ry * 0.2);
  c.fill();
  const pTop = topCY + t - 2, pBot = y + ry * 0.44;
  c.fillStyle = "#98a4be";
  c.fillRect(x - 7, pTop, 14, Math.max(1, pBot - pTop));
  c.fillStyle = "rgba(255,255,255,.28)";
  c.fillRect(x - 7, pTop, 4, Math.max(1, pBot - pTop));
  c.fillStyle = "rgba(0,0,0,.16)";
  c.fillRect(x + 3, pTop, 4, Math.max(1, pBot - pTop));
  c.fillStyle = a.edge || "#c9b694";
  ell(c, x, topCY + t, rx, ry);
  c.fill();
  c.fillRect(x - rx, topCY + t / 2, rx * 2, t);
  c.fillStyle = a.color || "#f7f0e4";
  ell(c, x, topCY, rx, ry);
  c.fill();
  c.save();
  ell(c, x, topCY, rx, ry);
  c.clip();
  c.fillStyle = "rgba(255,255,255,.30)";
  poly(c, [[x - rx, topCY - ry], [x + rx * 0.1, topCY - ry], [x - rx * 0.15, topCY + ry], [x - rx, topCY + ry]]);
  c.fillStyle = "rgba(0,0,0,.05)";
  poly(c, [[x + rx, topCY], [x + rx * 0.2, topCY + ry], [x + rx, topCY + ry]]);
  c.restore();
  c.strokeStyle = "rgba(60,45,25,.24)";
  c.lineWidth = 1.6;
  ell(c, x, topCY, rx, ry);
  c.stroke();
  c.strokeStyle = "rgba(255,255,255,.45)";
  c.lineWidth = 1.2;
  c.beginPath();
  c.ellipse(x, topCY, Math.max(1, rx - 3), Math.max(1, ry - 2), 0, Math.PI * 1.05, Math.PI * 1.75);
  c.stroke();
},
  sortY(a) { 
  return a.y + (a.r || 60) * SQ * 0.9;
}
};
