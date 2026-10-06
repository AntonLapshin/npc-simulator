// render/avatar.js — small cast-panel portrait rendered with the same
// character code as the scene (prototype drawAvatar).

import { linGrad, rgba } from "../core/utils.js";
import { drawCharacter } from "./character.js";

export function drawAvatar(cv, ch) {
  const c = cv.getContext("2d");
  if (!c) return;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  const g = linGrad(c, 0, 0, 0, cv.height, [[0, rgba(ch.color, 0.2)], [1, "rgba(255,255,255,.02)"]]);
  c.fillStyle = g || "rgba(255,255,255,.04)";
  c.fillRect(0, 0, cv.width, cv.height);
  c.save();
  c.scale(1.32, 1.32);
  c.translate(-10, -16);
  const ghost = Object.assign({}, ch, { dir: "down", x: 34, y: 78, isUser: false });
  try {
    drawCharacter(c, ghost, { showNames: false });
  } catch (err) {
    console.error("[avatar]", err);
  }
  c.restore();
}
