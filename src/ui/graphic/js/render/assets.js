// render/assets.js — furniture/prop renderers (backwards-compat layer).
//
// Refactored: each object now lives in its own file under
// `render/objects/` (one file per object, showcase pattern). This module
// keeps the original API (`ASSET_DRAW`, `drawAsset`, `assetSortY`, `draw*`)
// so the scene renderer, scenario builder and tests keep working unchanged.

import { ASSET_DRAW, drawAsset, assetSortY } from "./objects/index.js";
import { Desk } from "./objects/desk.js";
import { RoundTable } from "./objects/roundTable.js";
import { Chair } from "./objects/chair.js";
import { Stool } from "./objects/stool.js";
import { Laptop } from "./objects/laptop.js";
import { Cup } from "./objects/cup.js";
import { CupRow } from "./objects/cupRow.js";
import { Papers } from "./objects/papers.js";
import { Lamp } from "./objects/lamp.js";
import { DeskSign } from "./objects/deskSign.js";
import { Counter } from "./objects/counter.js";
import { CoffeeMachine } from "./objects/coffeeMachine.js";
import { Kettle } from "./objects/kettle.js";
import { WaterCooler } from "./objects/waterCooler.js";
import { Cabinet } from "./objects/cabinet.js";
import { Printer } from "./objects/printer.js";
import { Crates } from "./objects/crates.js";
import { Sofa } from "./objects/sofa.js";
import { Plant } from "./objects/plant.js";

export const drawDesk = Desk.draw;
export const drawRoundTable = RoundTable.draw;
export const drawChair = Chair.draw;
export const drawStool = Stool.draw;
export const drawLaptop = Laptop.draw;
export const drawCup = Cup.draw;
export const drawCupRow = CupRow.draw;
export const drawPapers = Papers.draw;
export const drawLamp = Lamp.draw;
export const drawDeskSign = DeskSign.draw;
export const drawCounter = Counter.draw;
export const drawCoffeeMachine = CoffeeMachine.draw;
export const drawKettle = Kettle.draw;
export const drawWaterCooler = WaterCooler.draw;
export const drawCabinet = Cabinet.draw;
export const drawPrinter = Printer.draw;
export const drawCrates = Crates.draw;
export const drawSofa = Sofa.draw;
export const drawPlant = Plant.draw;

export { ASSET_DRAW, drawAsset, assetSortY };
