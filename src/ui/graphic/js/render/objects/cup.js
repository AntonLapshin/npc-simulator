// render/objects/cup.js — mug/cup showcase file.
import { ell, rrPath } from "../../core/utils.js";

export const Cup = {
  name: "cup",
  title: "Mug",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: { asset: "cup", x: 0, y: 0, z: 0, color: "#ff5d7a" },

  draw(c, a) { 
  const x = a.x, Y = a.y - (a.z || 0), col = a.color || "#ffffff";
  c.fillStyle = "rgba(30,25,50,.20)";
  ell(c, x, Y + 1.5, 7.5, 3.2);
  c.fill();
  c.fillStyle = "#f7f4ee";
  rrPath(c, x - 5, Y - 11, 10, 12.5, 2.5);
  c.fill();
  c.fillStyle = col;
  rrPath(c, x - 5, Y - 11, 10, 4, 2.5);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.5)";
  c.fillRect(x - 3.8, Y - 9.5, 1.8, 9);
  c.strokeStyle = "#e2dbcd";
  c.lineWidth = 1.6;
  c.beginPath();
  c.arc(x + 6.2, Y - 6, 3.2, -1.2, 1.2);
  c.stroke();
  c.fillStyle = "rgba(120,80,50,.55)";
  ell(c, x, Y - 11, 4, 1.6);
  c.fill();
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return (a.y || 0) + 2;
}
};
