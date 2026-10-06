// render/objects/zone.js — dashed zone marker showcase file.
import { rrPath, rgba } from "../../core/utils.js";

export const Zone = {
  name: "zone",
  title: "Zone",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: {
  asset: "zone", id: "zone", x: 0, y: 0, w: 300, h: 200,
  color: "#ffb648", label: "DESK POD · A/B",
},

  draw(c, d) { 
  const x = d.x - d.w / 2, y = d.y - d.h / 2;
  c.save();
  c.setLineDash([9, 7]);
  c.strokeStyle = rgba(d.color, 0.42);
  c.lineWidth = 2;
  rrPath(c, x, y, d.w, d.h, 16);
  c.stroke();
  c.setLineDash([]);
  c.restore();
  c.fillStyle = rgba(d.color, 0.75);
  c.font = "800 10px Outfit, sans-serif";
  c.fillText(d.label, x + 12, y + 18);
},
  sortY() { 
  return -Infinity;
}
};
