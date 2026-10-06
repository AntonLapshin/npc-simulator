// render/objects/window.js — window showcase file.
import { linGrad, mulberry, poly, rrPath } from "../../core/utils.js";

export const Win = {
  name: "window",
  title: "Window",
  supportsDirection: false,
  variants: ["City", "Hills"],
  defaultProps: {
  asset: "window", id: "win", x: 0, y: 0, w: 180, h: 46, view: "city",
},

  draw(c, win) { 
  const x = win.x, y = win.y, w = win.w, h = win.h;
  c.save();
  rrPath(c, x, y, w, h, 5);
  c.clip();
  const sky = linGrad(c, 0, y, 0, y + h, [[0, "#8fd3ff"], [0.55, "#cfe9ff"], [1, "#ffe9c9"]]);
  c.fillStyle = sky || "#bfe4ff";
  c.fillRect(x, y, w, h);
  if (win.view === "city") {
    const rnd = mulberry(x * 7 + y);
    let cx = x - 10;
    while (cx < x + w) {
      const bw = 14 + rnd() * 22, bh = 10 + rnd() * (h - 14);
      c.fillStyle = "rgba(96,124,180," + (0.3 + rnd() * 0.28).toFixed(2) + ")";
      c.fillRect(cx, y + h - bh, bw, bh);
      c.fillStyle = "rgba(255,255,255,.30)";
      for (let wy = y + h - bh + 4; wy < y + h - 3; wy += 6)
        for (let wx = cx + 3; wx < cx + bw - 3; wx += 6) c.fillRect(wx, wy, 2, 2);
      cx += bw + 5 + rnd() * 9;
    }
  } else {
    c.fillStyle = "rgba(90,170,150,.45)";
    poly(c, [[x, y + h], [x + w * 0.22, y + h * 0.34], [x + w * 0.45, y + h], [x + w * 0.62, y + h * 0.5], [x + w * 0.85, y + h], [x + w, y + h * 0.62], [x + w, y + h]]);
    c.fillStyle = "rgba(255,255,255,.5)";
    poly(c, [[x + w * 0.22, y + h * 0.34], [x + w * 0.3, y + h * 0.52], [x + w * 0.14, y + h * 0.52]]);
  }
  c.fillStyle = "rgba(255,255,255,.20)";
  poly(c, [[x, y + h], [x + w * 0.35, y], [x + w * 0.52, y], [x + w * 0.17, y + h]]);
  c.restore();
  c.strokeStyle = "#f7f9fe";
  c.lineWidth = 4;
  rrPath(c, x, y, w, h, 5);
  c.stroke();
  c.strokeStyle = "rgba(60,70,110,.30)";
  c.lineWidth = 1;
  rrPath(c, x - 2, y - 2, w + 4, h + 4, 6);
  c.stroke();
  c.fillStyle = "#f7f9fe";
  c.fillRect(x + w / 2 - 1.5, y, 3, h);
  c.fillStyle = "rgba(255,255,255,.5)";
  c.fillRect(x, y + h * 0.34, w, 2);
},
  sortY() { 
  return -Infinity;
}
};
