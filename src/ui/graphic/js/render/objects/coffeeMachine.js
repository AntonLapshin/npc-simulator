// render/objects/coffeeMachine.js — coffee machine showcase file.
import { ell, rrPath, solidBox } from "../../core/utils.js";

export const CoffeeMachine = {
  name: "coffeeMachine",
  title: "Coffee Machine",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: { asset: "coffeeMachine", x: 0, y: 0, z: 0 },

  draw(c, a) { 
  const x = a.x, Y = a.y - (a.z || 0);
  c.fillStyle = "rgba(20,26,48,.22)";
  rrPath(c, x - 21, Y - 8, 42, 14, 3);
  c.fill();
  solidBox(c, x, Y - 4, 42, 24, 40, "#39445f", "#232c42", 5);
  c.fillStyle = "#8fd3ff";
  rrPath(c, x - 15, Y - 38, 18, 14, 3);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.5)";
  rrPath(c, x - 13, Y - 36, 5, 10, 2);
  c.fill();
  c.fillStyle = "#ff5d7a";
  ell(c, x + 13, Y - 31, 3.2, 3.2);
  c.fill();
  c.fillStyle = "#2ec4a6";
  ell(c, x + 13, Y - 23, 3.2, 3.2);
  c.fill();
  c.fillStyle = "#c8d0e0";
  rrPath(c, x - 9, Y - 16, 20, 7, 2);
  c.fill();
  c.fillStyle = "#6b4a2f";
  rrPath(c, x - 5, Y - 15, 12, 4, 1.5);
  c.fill();
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return (a.y || 0) + 2;
}
};
