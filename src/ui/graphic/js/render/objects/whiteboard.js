// render/objects/whiteboard.js — whiteboard decor showcase file.
import { rrPath, rgba } from "../../core/utils.js";

export const Whiteboard = {
  name: "whiteboard",
  title: "Whiteboard",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "whiteboard", id: "board", x: 0, y: 0, w: 132, h: 50, ink: "#4f7cff",
},

  draw(c, d) { 
  c.fillStyle = "rgba(20,26,48,.18)";
  rrPath(c, d.x + 3, d.y + 4, d.w, d.h, 5);
  c.fill();
  c.fillStyle = "#eef2fa";
  rrPath(c, d.x, d.y, d.w, d.h, 5);
  c.fill();
  c.strokeStyle = "#aab6d0";
  c.lineWidth = 2.4;
  rrPath(c, d.x, d.y, d.w, d.h, 5);
  c.stroke();
  c.save();
  rrPath(c, d.x + 4, d.y + 4, d.w - 8, d.h - 8, 3);
  c.clip();
  c.strokeStyle = rgba(d.ink, 0.55);
  c.lineWidth = 1.6;
  for (let i = 0; i < 4; i++) {
    c.beginPath();
    c.moveTo(d.x + 10, d.y + 11 + i * 7);
    c.lineTo(d.x + 10 + 38 + ((i * 23) % 46), d.y + 11 + i * 7);
    c.stroke();
  }
  c.strokeStyle = "rgba(255,93,122,.7)";
  c.beginPath();
  c.moveTo(d.x + 84, d.y + d.h - 10);
  const pts = [10, 20, 14, 26, 20, 32];
  for (let i = 0; i < pts.length; i++) c.lineTo(d.x + 84 + i * 9, d.y + d.h - 10 - pts[i]);
  c.stroke();
  c.fillStyle = "rgba(46,196,166,.55)";
  c.fillRect(d.x + 84, d.y + d.h - 11, 58, 2);
  c.restore();
},
  sortY() { 
  return -Infinity;
}
};
