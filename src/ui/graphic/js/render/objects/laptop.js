// render/objects/laptop.js — laptop showcase file. Rotatable: N/S.
import { rrPath } from "../../core/utils.js";
import { normDir } from "./direction.js";

/** Screen faces N or S (180° rotated pair). E/W map to the nearest face. */


function drawBody(c, x, Y) {
  c.fillStyle = "rgba(24,28,54,.20)";
  rrPath(c, x - 19, Y - 5, 38, 14, 3);
  c.fill();
  c.fillStyle = "#2b3757";
  rrPath(c, x - 18, Y - 40, 36, 31, 3);
  c.fill();
  c.fillStyle = "#3b4c78";
  rrPath(c, x - 18, Y - 40, 36, 15, 3);
  c.fill();
  c.fillStyle = "rgba(150,200,255,.20)";
  rrPath(c, x - 15, Y - 37, 30, 25, 2);
  c.fill();
  c.save();
  c.translate(x, Y - 24);
  c.rotate(Math.PI / 4);
  c.fillStyle = "rgba(190,225,255,.85)";
  c.fillRect(-3.2, -3.2, 6.4, 6.4);
  c.restore();
  c.fillStyle = "rgba(170,220,255,.35)";
  c.fillRect(x - 18, Y - 40, 36, 1.6);
  c.fillStyle = "#b9c3d8";
  rrPath(c, x - 19, Y - 9, 38, 16, 3);
  c.fill();
  c.fillStyle = "#eef2fa";
  rrPath(c, x - 19, Y - 11, 38, 14, 3);
  c.fill();
  c.fillStyle = "#98a4be";
  rrPath(c, x - 14, Y - 8, 28, 8, 2);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.35)";
  for (let i = 0; i < 3; i++) c.fillRect(x - 13, Y - 7.4 + i * 2.6, 26, 1.1);
  c.fillStyle = "#c3ccdf";
  rrPath(c, x - 4.5, Y + 1, 9, 3.4, 1.5);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.5)";
  c.fillRect(x - 19, Y - 11, 38, 1.3);
}

export const Laptop = {
  name: "laptop",
  title: "Laptop",
  supportsDirection: true,
  variants: ["N", "S", "E", "W"],
  defaultProps: { asset: "laptop", x: 0, y: 0, z: 0, dir: "S" },

  draw(c, a) { 
  const x = a.x, Y = a.y - (a.z || 0);
  const dir = normDir(a.dir, "S");
  // E/W have no distinct side profile for a top-down laptop: face the
  // nearest screen side so the showcase still demonstrates rotation.
  const facing = dir === "E" || dir === "W" ? "S" : dir;
  if (facing === "N") {
    c.save();
    c.translate(x, Y - 16);
    c.rotate(Math.PI);
    c.translate(-x, -(Y - 16));
    drawBody(c, x, Y);
    c.restore();
    return;
  }
  drawBody(c, x, Y);
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return (a.y || 0) + 5;
}
};
