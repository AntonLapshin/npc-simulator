// render/objects/stool.js — stool showcase file.
import { ellShadow, gemBox, shade } from "../../core/utils.js";

export const Stool = {
  name: "stool",
  title: "Stool",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: { asset: "stool", x: 0, y: 0, color: "#ffb648" },

  draw(c, a) { 
  const x = a.x, y = a.y, col = a.color || "#ffb648";
  const sw = 30, sd = 26, sh = 24, st = 8;
  ellShadow(c, x, y + sd * 0.32, sw * 0.62, sd * 0.44, 0.22);
  const under = y + sd / 2 - sh + st, floorY = y + sd * 0.32;
  c.fillStyle = "#6f7c99";
  c.fillRect(x - 3, under - 4, 6, Math.max(1, floorY - under + 4));
  c.strokeStyle = "#6f7c99";
  c.lineWidth = 3.4;
  c.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const an = Math.PI * 0.25 + (i * Math.PI) / 2;
    c.beginPath();
    c.moveTo(x, floorY);
    c.lineTo(x + Math.cos(an) * 12, floorY + Math.sin(an) * 5);
    c.stroke();
  }
  c.lineCap = "butt";
  gemBox(c, x, y, sw, sd, sh, st, col, shade(col, -0.36), 7);
},
  sortY(a) { 
  return a.y + 13;
}
};
