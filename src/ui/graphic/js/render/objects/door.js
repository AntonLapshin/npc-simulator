// render/objects/door.js — entrance door showcase file.
import { linGrad, shade } from "../../core/utils.js";

export const Door = {
  name: "door",
  title: "Door",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "door", id: "door", x: 0, y: 0, w: 130, h: 20,
  frame: "#8f6b45", label: "ENTRANCE",
},

  draw(c, d) { 
  if (d.h > d.w) {
    c.fillStyle = d.frame || "#8f6b45";
    c.fillRect(d.x, d.y, d.w, d.h);
    c.strokeStyle = "rgba(40,50,90,.35)";
    c.lineWidth = 1.5;
    c.strokeRect(d.x + 0.5, d.y + 0.5, d.w - 1, d.h - 1);
    return;
  }
  c.fillStyle = "#0a0f1c";
  c.fillRect(d.x, d.y + 2, d.w, d.h);
  const g = linGrad(c, 0, d.y - 46, 0, d.y + d.h, [[0, "rgba(120,150,220,.30)"], [1, "rgba(20,26,44,.9)"]]);
  if (g) {
    c.fillStyle = g;
    c.fillRect(d.x, d.y - 46, d.w, d.h + 46);
  }
  c.fillStyle = d.frame;
  c.fillRect(d.x - 9, d.y - 50, 9, d.h + 50);
  c.fillRect(d.x + d.w, d.y - 50, 9, d.h + 50);
  c.fillRect(d.x - 9, d.y - 56, d.w + 18, 9);
  c.fillStyle = shade(d.frame, 0.28);
  c.fillRect(d.x - 9, d.y - 56, d.w + 18, 3);
  c.fillStyle = "rgba(255,255,255,.55)";
  c.font = "700 9px Outfit, sans-serif";
  c.textAlign = "center";
  c.fillText(d.label, d.x + d.w / 2, d.y - 62);
  c.textAlign = "left";
},
  sortY() { 
  return -Infinity;
}
};
