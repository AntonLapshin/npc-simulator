// render/objects/deskSign.js — desk name-plate showcase file.
import { poly, rrPath } from "../../core/utils.js";

export const DeskSign = {
  name: "deskSign",
  title: "Desk Sign",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: { asset: "deskSign", x: 0, y: 0, z: 0, text: "NOAH" },

  draw(c, a) { 
  const x = a.x, Y = a.y - (a.z || 0);
  c.fillStyle = "rgba(30,25,50,.20)";
  rrPath(c, x - 22, Y - 2, 44, 7, 2);
  c.fill();
  c.fillStyle = "#1f9e85";
  poly(c, [[x - 22, Y], [x + 22, Y], [x + 17, Y - 18], [x - 17, Y - 18]]);
  c.fillStyle = "#2ec4a6";
  poly(c, [[x - 22, Y], [x + 2, Y], [x - 3, Y - 18], [x - 17, Y - 18]]);
  c.fillStyle = "rgba(255,255,255,.22)";
  c.fillRect(x - 17, Y - 18, 34, 2);
  c.fillStyle = "#06231d";
  c.font = "800 9px Outfit, sans-serif";
  c.textAlign = "center";
  c.fillText(a.text || "", x, Y - 5.5);
  c.textAlign = "left";
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return (a.y || 0) + 2;
}
};
