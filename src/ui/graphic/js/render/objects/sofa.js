// render/objects/sofa.js — sofa showcase file. Rotatable: N/E/S/W.
//
// dir = way the sitter faces. Backrest opposite, arms on the two ends.
// N/S map to the horizontal (down/up) builds, E/W to vertical (left/right).
import { ellShadow, flatRect, shade, solidBox } from "../../core/utils.js";
import { normDir, COMPASS_VARIANTS } from "./direction.js";



/** Showcase N/E/S/W → legacy plan-view orientation used by the painter. */
function toLegacy(compass) {
  if (compass === "N") return "up";
  if (compass === "S") return "down";
  if (compass === "E") return "right";
  return "left";
}

export const Sofa = {
  name: "sofa",
  title: "Sofa",
  supportsDirection: true,
  variants: COMPASS_VARIANTS,
  defaultProps: {
  asset: "sofa", x: 0, y: 0, w: 120, d: 60, dir: "S", color: "#9b6cf5",
},

  draw(c, a) { 
  const x = a.x, y = a.y, w = a.w || 120, d = a.d || 60;
  const dir = toLegacy(normDir(a.dir ?? a.direction, "S"));
  const col = a.color || "#9b6cf5";
  const sh = a.sh || 22, bh = a.bh || 48, ah = a.ah || 34, bt = a.bt || 16, at = a.at || 15;
  const horiz = dir === "down" || dir === "up";
  ellShadow(c, x, y + d / 2 - 2, w * 0.62, d * 0.52, 0.26);

  if (horiz) {
    const by = dir === "down" ? y - d / 2 + bt / 2 : y + d / 2 - bt / 2;
    solidBox(c, x, by, w, bt, bh, shade(col, 0.12), shade(col, -0.38), 7);
  } else {
    const bx = dir === "right" ? x - w / 2 + bt / 2 : x + w / 2 - bt / 2;
    solidBox(c, bx, y, bt, d, bh, shade(col, 0.12), shade(col, -0.38), 7);
  }
  solidBox(c, x, y, w, d, sh, shade(col, 0.26), shade(col, -0.3), 7);
  if (horiz) {
    solidBox(c, x - w / 2 + at / 2, y, at, d, ah, shade(col, 0.02), shade(col, -0.42), 6);
    solidBox(c, x + w / 2 - at / 2, y, at, d, ah, shade(col, 0.02), shade(col, -0.42), 6);
  } else {
    solidBox(c, x, y - d / 2 + at / 2, w, at, ah, shade(col, 0.02), shade(col, -0.42), 6);
    solidBox(c, x, y + d / 2 - at / 2, w, at, ah, shade(col, 0.02), shade(col, -0.42), 6);
  }
  const n = 3, gap = 4;
  let ax, ay, aw, ah2;
  if (horiz) {
    ax = x - w / 2 + at + 3;
    aw = w - at * 2 - 6;
    ay = dir === "down" ? y - d / 2 + bt + 3 : y - d / 2 + 3;
    ah2 = d - bt - 6;
    const cw = (aw - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      flatRect(c, ax + i * (cw + gap), ay, cw, ah2, sh, shade(col, 0.36), 6);
      flatRect(c, ax + i * (cw + gap) + 4, ay + 4, cw - 8, 6, sh, "rgba(255,255,255,.22)", 3);
    }
  } else {
    ay = y - d / 2 + at + 3;
    ah2 = d - at * 2 - 6;
    ax = dir === "right" ? x - w / 2 + bt + 3 : x - w / 2 + 3;
    aw = w - bt - 6;
    const cd = (ah2 - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      flatRect(c, ax, ay + i * (cd + gap), aw, cd, sh, shade(col, 0.36), 6);
      flatRect(c, ax + 4, ay + i * (cd + gap) + 4, 6, cd - 8, sh, "rgba(255,255,255,.22)", 3);
    }
  }
  const pz = bh - 14;
  for (let i = 0; i < 2; i++) {
    if (horiz) {
      const py = dir === "down" ? y - d / 2 + bt + 2 : y + d / 2 - bt - 16;
      flatRect(c, x - w / 4 - 8 + i * (w / 2 - 4), py, 20, 15, pz, i ? "#ffb648" : "#2ec4a6", 5);
    } else {
      const px = dir === "right" ? x - w / 2 + bt + 2 : x + w / 2 - bt - 17;
      flatRect(c, px, y - d / 4 - 10 + i * (d / 2 - 6), 15, 22, pz, i ? "#ffb648" : "#2ec4a6", 5);
    }
  }
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return a.y + (a.d || 0) / 2;
}
};
