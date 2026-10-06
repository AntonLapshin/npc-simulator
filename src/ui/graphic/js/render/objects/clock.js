// render/objects/clock.js — wall clock showcase file.
import { ell } from "../../core/utils.js";

export const Clock = {
  name: "clock",
  title: "Clock",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: { asset: "clock", id: "clock", x: 0, y: 0, r: 15 },

  draw(c, d) { 
  c.fillStyle = "rgba(20,26,48,.18)";
  ell(c, d.x + 2, d.y + 3, d.r, d.r);
  c.fill();
  c.fillStyle = "#f7f9fe";
  ell(c, d.x, d.y, d.r, d.r);
  c.fill();
  c.strokeStyle = "#8c99b8";
  c.lineWidth = 2.4;
  ell(c, d.x, d.y, d.r, d.r);
  c.stroke();
  c.strokeStyle = "#2b3550";
  c.lineWidth = 2;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(d.x, d.y);
  c.lineTo(d.x, d.y - d.r * 0.6);
  c.stroke();
  c.beginPath();
  c.moveTo(d.x, d.y);
  c.lineTo(d.x + d.r * 0.55, d.y + d.r * 0.2);
  c.stroke();
  c.fillStyle = "#ff5d7a";
  ell(c, d.x, d.y, 1.8, 1.8);
  c.fill();
  c.lineCap = "butt";
},
  sortY() { 
  return -Infinity;
}
};
