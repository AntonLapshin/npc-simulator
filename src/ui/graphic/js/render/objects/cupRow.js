// render/objects/cupRow.js — row of three mugs showcase file.
import { Cup } from "./cup.js";


const COLS = ["#2ec4a6", "#ffb648", "#4f7cff"];

export const CupRow = {
  name: "cupRow",
  title: "Mug Row",
  supportsDirection: false,
  variants: ["Default"],
  defaultProps: { asset: "cupRow", x: 0, y: 0, z: 0 },

  draw(c, a) { 
  for (let i = 0; i < 3; i++) Cup.draw(c, { x: a.x - 16 + i * 16, y: a.y, z: a.z || 0, color: COLS[i] });
},
  sortY(a) { 
  if (typeof a.sort === "number") return a.sort;
  return (a.y || 0) + 2;
}
};
