// render/objects/papers.js — scattered papers showcase file.
import { rrPath } from "../../core/utils.js";

export const Papers = {
  name: "papers",
  title: "Papers",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: { asset: "papers", x: 0, y: 0, z: 0 },

  draw(c, a) { 
  const x = a.x, Y = a.y - (a.z || 0);
  c.fillStyle = "rgba(30,25,50,.16)";
  rrPath(c, x - 13, Y - 6, 26, 15, 2);
  c.fill();
  c.save();
  c.translate(x - 4, Y - 2);
  c.rotate(-0.13);
  c.fillStyle = "#fdfcf7";
  rrPath(c, -13, -8, 26, 16, 2);
  c.fill();
  c.strokeStyle = "rgba(120,130,160,.5)";
  c.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    c.beginPath();
    c.moveTo(-9, -4 + i * 4);
    c.lineTo(4 + (i % 2) * 4, -4 + i * 4);
    c.stroke();
  }
  c.restore();
  c.save();
  c.translate(x + 7, Y + 2);
  c.rotate(0.2);
  c.fillStyle = "#ffffff";
  rrPath(c, -11, -8, 22, 15, 2);
  c.fill();
  c.fillStyle = "rgba(255,93,122,.55)";
  c.fillRect(-8, -5, 10, 2);
  c.fillRect(-8, -1, 14, 2);
  c.restore();
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return (a.y || 0) + 2;
}
};
