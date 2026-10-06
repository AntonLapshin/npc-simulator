// render/objects/character.js — character showcase file (showcase pattern).
//
// Wraps render/character.js so people appear in the object gallery next to
// furniture. Rotatable via N/E/S/W (mapped to up/right/down/left).
import { drawCharacter } from "../character.js";
import { COMPASS_VARIANTS } from "./direction.js";


const TO_LEGACY = { N: "up", E: "right", S: "down", W: "left" };

export const Character = {
  name: "character",
  title: "Character",
  supportsDirection: true,
  variants: COMPASS_VARIANTS,
  defaultProps: {
  asset: "character",
  id: "noah",
  name: "Noah",
  color: "#4f7cff",
  look: {
    skin: "#f2cba6", skin2: "#e0b189",
    hair: "#3d2a20", hairStyle: "short",
    shirt: "#7fb6ff", shirt2: "#5b95e8",
    pants: "#39435c", shoes: "#1e2434",
  },
  prop: null,
  x: 0,
  y: 0,
  dir: "S",
  emotion: "neutral",
  visible: true,
  isUser: false,
},

  draw(c, a) { 
  const dir = TO_LEGACY[a.dir] || a.planDir || "down";
  drawCharacter(c, { ...a, dir }, { showNames: false });
},
  sortY(a) { 
  return a.y || 0;
}
};
