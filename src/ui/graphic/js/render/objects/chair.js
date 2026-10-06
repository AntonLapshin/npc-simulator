// render/objects/chair.js — chair showcase file. Rotatable: N/E/S/W.
//
// Single-export pattern: one uniquely-named object per file (bundle-safe —
// tools/bundle.mjs concatenates modules into one scope, so generic `draw` /
// `name` exports would collide). The registry in ./index.js composes these
// into showcase files (AntonLapshin/showcase shape).

import { ell, ellShadow, gemBox, rrPath, shade, solidBox } from "../../core/utils.js";
import { normDir, COMPASS_VARIANTS } from "./direction.js";

export const Chair = {
  name: "chair",
  title: "Chair",
  supportsDirection: true,
  variants: COMPASS_VARIANTS,
  defaultProps: { asset: "chair", x: 0, y: 0, dir: "S", color: "#4f7cff" },

  /** dir = the way the sitter faces (N/S/E/W); backrest on the opposite side. */
  draw(c, a) {
    const x = a.x, y = a.y, dir = normDir(a.dir, "S"), col = a.color || "#4f7cff";
    const sw = a.w || 34, sd = a.d || 32, sh = a.h || 26, st = 8, bh = a.bh || 60;
    ellShadow(c, x, y + sd * 0.3, sw * 0.68, sd * 0.48, 0.24);
    let bx = x, by = y, bw = sw + 3, bd = 11;
    if (dir === "S") by = y - sd / 2 + 5;
    else if (dir === "N") by = y + sd / 2 - 5;
    else if (dir === "W") {
      bx = x + sw / 2 - 5;
      bw = 11;
      bd = sd - 3;
    } else {
      bx = x - sw / 2 + 5;
      bw = 11;
      bd = sd - 3;
    }
    solidBox(c, bx, by, bw, bd, bh, shade(col, 0.14), shade(col, -0.38), 5);
    c.fillStyle = "rgba(255,255,255,.18)";
    if (bw > bd) {
      rrPath(c, bx - bw / 2 + 5, by - bd / 2 - bh + 6, bw - 10, bd * 0.45, 3);
      c.fill();
    } else {
      rrPath(c, bx - bw / 2 + 3, by - bd / 2 - bh + 7, bw * 0.45, bd - 14, 3);
      c.fill();
    }
    const under = y + sd / 2 - sh + st, floorY = y + sd * 0.3;
    c.fillStyle = "#6f7c99";
    c.fillRect(x - 3, under - 6, 6, Math.max(1, floorY - under + 6));
    c.strokeStyle = "#6f7c99";
    c.lineWidth = 3.4;
    c.lineCap = "round";
    for (let i = 0; i < 4; i++) {
      const an = Math.PI * 0.25 + (i * Math.PI) / 2;
      c.beginPath();
      c.moveTo(x, floorY);
      c.lineTo(x + Math.cos(an) * 13, floorY + Math.sin(an) * 5.5);
      c.stroke();
      c.fillStyle = "#4c5670";
      ell(c, x + Math.cos(an) * 13.5, floorY + Math.sin(an) * 5.8, 2.4, 2.4);
      c.fill();
    }
    c.lineCap = "butt";
    gemBox(c, x, y, sw, sd, sh, st, col, shade(col, -0.36), 7);
    c.strokeStyle = "rgba(255,255,255,.22)";
    c.lineWidth = 1.2;
    rrPath(c, x - sw / 2 + 6, y - sd / 2 - sh + 5, sw - 12, sd - 10, 4);
    c.stroke();
  },

  sortY(a) {
    const d = a.d || 32;
    const dir = normDir(a.dir, "S");
    return dir === "S" ? a.y - d / 2 : dir === "N" ? a.y + d / 2 : a.y;
  },
};
