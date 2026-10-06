// render/objects/kettle.js — kettle showcase file.
import { ell, rrPath, shade } from "../../core/utils.js";

export const Kettle = {
  name: "kettle",
  title: "Kettle",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: { asset: "kettle", x: 0, y: 0, z: 0, color: "#ff5d7a" },

  draw(c, a) { 
  const x = a.x, Y = a.y - (a.z || 0), col = a.color || "#ff5d7a";
  c.fillStyle = "rgba(20,26,48,.2)";
  ell(c, x, Y + 1, 11, 4.4);
  c.fill();
  c.fillStyle = col;
  rrPath(c, x - 10, Y - 19, 20, 20, 6);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.35)";
  rrPath(c, x - 8, Y - 17, 5, 15, 3);
  c.fill();
  c.fillStyle = shade(col, -0.35);
  rrPath(c, x - 11, Y - 22, 22, 5, 2.5);
  c.fill();
  c.strokeStyle = shade(col, -0.3);
  c.lineWidth = 2.4;
  c.beginPath();
  c.arc(x, Y - 27, 7, Math.PI, 0);
  c.stroke();
  c.strokeStyle = shade(col, -0.4);
  c.lineWidth = 2.6;
  c.beginPath();
  c.moveTo(x + 9, Y - 14);
  c.lineTo(x + 15, Y - 19);
  c.stroke();
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return (a.y || 0) + 2;
}
};
