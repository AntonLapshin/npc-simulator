// render/objects/crates.js — stacked crates showcase file.
import { ellShadow, solidBox } from "../../core/utils.js";

export const Crates = {
  name: "crates",
  title: "Crates",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: { asset: "crates", x: 0, y: 0, color: "#c98a5e" },

  draw(c, a) { 
  const x = a.x, y = a.y;
  ellShadow(c, x + 4, y + 20, 42, 15, 0.22);
  solidBox(c, x - 16, y + 8, 32, 28, 28, "#d9a06a", "#b07c4c", 4);
  solidBox(c, x + 19, y + 4, 28, 26, 24, "#c98a5e", "#a26c44", 4);
  c.save();
  c.translate(0, -28);
  solidBox(c, x - 16, y + 8, 30, 26, 24, "#e0b483", "#b98d5f", 4);
  c.restore();
  c.strokeStyle = "rgba(90,60,30,.28)";
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(x - 30, y - 6);
  c.lineTo(x - 2, y - 6);
  c.stroke();
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return (a.y || 0) + 20;
}
};
