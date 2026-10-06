// data/officeScenario.js — the default scenario in the engine's World format.
//
// Shape mirrors `Scenario` from the simulator's types.ts:
//   { version, id, title, narrative, userActorId, order, scene, actors }
// The same JSON can be loaded by the engine (loadScenario) — the UI never
// mutates it, adapters turn it into a World.
//
// Two UI-only conventions on top of the engine format:
//  • `presentation` — visual metadata (colors, roles, props, looks) keyed by
//    actor id. The engine ignores it; if absent, the UI derives deterministic
//    looks from actor ids (see sim/presentation.js).
//  • Scene object `id`s that match a STATIC_SCENE asset id are considered
//    "already painted" by the scenery renderer (no generic fallback box).
//    Object x/y are footprint CENTERS in world coordinates (1040×730 here).

export const OFFICE_SCENARIO = {
  version: 1,
  id: "office_first_day",
  title: "First Day — Northlight Studio",
  narrative:
    "Monday · 9:02 AM — Northlight Studio, floor 3. Noah walks in on his first day; the team is scattered between the desk pods, the lounge and the kitchen.",
  userActorId: "noah",
  order: ["noah", "maya", "priya", "lena", "dana"],

  scene: {
    width: 1040,
    height: 730,
    objects: [
      { id: "tbl_lounge", name: "lounge round table", description: "A round white table with four chairs around it, scattered with notes and cups.", x: 205, y: 272, w: 148, h: 118, passable: false, blocksVision: false, blocksSound: false },
      { id: "sofa", name: "purple sofa", description: "A three-seat sofa against the west wall, facing east.", x: 112, y: 402, w: 66, h: 172, passable: false, blocksVision: true, blocksSound: false },
      { id: "counter", name: "kitchen counter", description: "The kitchen counter with the moody coffee machine, a kettle and a row of cups.", x: 520, y: 158, w: 242, h: 58, passable: false, blocksVision: false, blocksSound: false },
      { id: "cooler", name: "water cooler", description: "A bubbling water cooler between the kitchen and the lounge.", x: 372, y: 170, w: 44, h: 42, passable: false, blocksVision: false, blocksSound: false },
      { id: "cabinet", name: "storage cabinet", description: "A low grey cabinet topped with cardboard crates of office supplies.", x: 160, y: 546, w: 190, h: 60, passable: false, blocksVision: true, blocksSound: false },
      { id: "printer", name: "office printer", description: "The communal printer by the south wall. It jams when it senses fear.", x: 330, y: 600, w: 92, h: 64, passable: false, blocksVision: false, blocksSound: false },
      { id: "deskA1", name: "desk A1 (Maya)", description: "Maya's desk in pod A: laptop, mug, tidy cable management.", x: 660, y: 280, w: 170, h: 76, passable: false, blocksVision: false, blocksSound: false },
      { id: "deskA2", name: "desk A2 (Noah)", description: "A brand-new desk with a NOAH sign, a laptop and a lamp. Still smells like unboxing.", x: 860, y: 280, w: 170, h: 76, passable: false, blocksVision: false, blocksSound: false },
      { id: "deskB1", name: "desk B1", description: "An empty desk in pod B, reserved for the next hire.", x: 660, y: 500, w: 170, h: 76, passable: false, blocksVision: false, blocksSound: false },
      { id: "deskB2", name: "desk B2 (Lena)", description: "Lena's QA desk in pod B: two monitors' worth of sticky notes and a purple mug.", x: 860, y: 500, w: 170, h: 76, passable: false, blocksVision: false, blocksSound: false },
      { id: "crates", name: "cardboard crates", description: "Stacked crates of old release swag near the cabinet.", x: 296, y: 524, w: 70, h: 50, passable: false, blocksVision: false, blocksSound: false },
      { id: "door1", name: "entrance door", description: "The glass entrance door at the south side of the floor, leading to the corridor.", x: 500, y: 670, w: 130, h: 20, passable: true, blocksVision: false, blocksSound: true },
    ],
  },

  actors: [
    {
      id: "noah",
      name: "Noah",
      persona:
        "New hire, frontend developer. Eager, polite and a little nervous; wants to make a good first impression and learn the codebase.",
      x: 500,
      y: 690,
      state: "standing by the entrance with a bag over one shoulder",
      emotion: "nervous",
      goal: "introduce yourself to the team and settle in at the new desk",
      thoughts: "Okay… deep breath. First day, brand new team. Everyone seems friendly so far.",
      memories: ["Signed the offer two weeks ago; starts today at Northlight Studio."],
      beliefs: ["Arriving a few minutes early is the right call."],
      relationships: [],
    },
    {
      id: "maya",
      name: "Maya",
      persona:
        "Team lead, Platform. Confident and warm; she owns onboarding for the new hire and keeps an eye on everyone's workload.",
      x: 660,
      y: 216,
      state: "at her desk in pod A, reviewing the sprint board",
      emotion: "neutral",
      goal: "get Noah settled in and introduce him to the team",
      thoughts: "New starter today. I should show him the desk pod and the coffee machine before standup.",
      memories: ["Approved Noah's hiring plan last month."],
      beliefs: ["A good first day sets the tone for everything after."],
      relationships: ["Leads the platform team Noah just joined."],
    },
    {
      id: "priya",
      name: "Priya",
      persona:
        "Product designer. Bubbly, extroverted snack-drawer raider; loves welcoming people and over-shares design trivia.",
      x: 296,
      y: 278,
      state: "at the lounge table, sketching on paper with a cold cup of coffee",
      emotion: "happy",
      goal: "finish the lounge redesign mockups before lunch",
      thoughts: "If the new person sits near the window, the lounge redesign is going to sell itself.",
      memories: ["Raided the snack drawer twice before 9 AM."],
      beliefs: ["Design reviews are better with coffee."],
      relationships: [],
    },
    {
      id: "lena",
      name: "Lena",
      persona:
        "QA engineer. Shy and precise; speaks softly, types furiously, and knows every flaky test by name.",
      x: 664,
      y: 436,
      state: "at her desk in pod B, stepping through a failing regression suite",
      emotion: "neutral",
      goal: "stabilise the flaky regression suite before the release cut",
      thoughts: "Two more flakes to quarantine, then I can look up and pretend to be a normal person.",
      memories: ["Filed eleven bug reports last week; three were her own typos."],
      beliefs: ["If it isn't tested, it isn't done."],
      relationships: [],
    },
    {
      id: "dana",
      name: "Dana",
      persona:
        "Ops manager. Cheerful, caffeinated, knows where everything is and who to ask; unofficial welcome committee.",
      x: 424,
      y: 214,
      state: "by the kitchen counter, waiting for the coffee machine to finish gurgling",
      emotion: "happy",
      goal: "keep the office running — badges, coffee, and the new hire's desk setup",
      thoughts: "Badge is printed, desk is labeled. The machine is moody before ten, as always.",
      memories: ["Ordered the NOAH desk sign on Friday."],
      beliefs: ["Most office problems are solved by coffee or a label maker."],
      relationships: [],
    },
  ],

  /* ── UI-only visual metadata (ignored by the engine) ─────────────── */
  presentation: {
    scene: { name: "Northlight Studio · Floor 3", staticScene: "office_floor3" },
    actors: {
      noah: {
        color: "#4f7cff",
        role: "New hire · Frontend",
        prop: "bag",
        look: { skin: "#f2cba6", skin2: "#e0b189", hair: "#3d2a20", hairStyle: "short", shirt: "#7fb6ff", shirt2: "#5b95e8", pants: "#39435c", shoes: "#1e2434" },
      },
      maya: {
        color: "#2ec4a6",
        role: "Team lead · Platform",
        prop: null,
        look: { skin: "#c98a5e", skin2: "#b0744a", hair: "#22191a", hairStyle: "bun", shirt: "#2ec4a6", shirt2: "#1f9e85", pants: "#2b3550", shoes: "#1a2032" },
      },
      priya: {
        color: "#9b6cf5",
        role: "Product designer",
        prop: null,
        look: { skin: "#e2a97c", skin2: "#c98f63", hair: "#2b1f22", hairStyle: "long", shirt: "#9b6cf5", shirt2: "#7d51d3", pants: "#3a3357", shoes: "#221d33" },
      },
      lena: {
        color: "#ffb648",
        role: "QA engineer",
        prop: null,
        look: { skin: "#ffe0cb", skin2: "#eec7ae", hair: "#b5502f", hairStyle: "ponytail", shirt: "#ffb648", shirt2: "#e2952c", pants: "#4a6fa5", shoes: "#26313f" },
      },
      dana: {
        color: "#ff5d7a",
        role: "Ops manager",
        prop: "cup",
        look: { skin: "#8d5a3b", skin2: "#78492e", hair: "#191315", hairStyle: "curly", shirt: "#ff5d7a", shirt2: "#dd3f5e", pants: "#2c3444", shoes: "#171d29" },
      },
    },
  },
};
