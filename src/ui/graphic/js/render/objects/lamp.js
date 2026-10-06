// render/objects/lamp.js — desk lamp showcase file.
import { ell, poly, radGrad, rrPath } from "../../core/utils.js";

export const Lamp = {
  name: "lamp",
  title: "Desk Lamp",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: { asset: "lamp", x: 0, y: 0, z: 0 },

  draw(c, a) { 
  const x = a.x, Y = a.y - (a.z || 0);
  c.fillStyle = "rgba(30,25,50,.18)";
  ell(c, x, Y + 2, 10, 4);
  c.fill();
  const glow = radGrad(c, x, Y - 20, 1, x, Y - 20, 26, [
    [0, "rgba(255,214,120,.40)"],
    [1, "rgba(255,214,120,0)"],
  ]);
  if (glow) {
    c.fillStyle = glow;
    ell(c, x, Y - 20, 26, 26);
    c.fill();
  }
  c.fillStyle = "#39445f";
  rrPath(c, x - 8, Y - 3, 16, 4, 2);
  c.fill();
  c.fillRect(x - 1.6, Y - 26, 3.2, 24);
  c.fillStyle = "#ffb648";
  poly(c, [[x - 11, Y - 26], [x + 11, Y - 26], [x + 6, Y - 40], [x - 6, Y - 40]]);
  c.fillStyle = "rgba(255,255,255,.4)";
  poly(c, [[x - 11, Y - 26], [x - 2, Y - 26], [x - 3, Y - 40], [x - 6, Y - 40]]);
  c.fillStyle = "#fff3cf";
  ell(c, x, Y - 26, 10, 3);
  c.fill();
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return (a.y || 0) + 2;
}
};
