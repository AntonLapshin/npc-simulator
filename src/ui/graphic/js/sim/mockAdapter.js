// sim/mockAdapter.js — offline, deterministic simulation adapter.
//
// Mirrors the turn contract of the engine UI (textUI.ts): the user submits a
// free-form action, the user turn resolves, then NPCs auto-advance until it
// is the user's turn again. Every state change flows through turn events —
// the UI layer never mutates the world directly.
//
// This is a stand-in for the real LLM engines (proposal/selection/
// consequence): keyword-classified reply pools + small world patches, with
// the same progress/turn event stream, so the UI behaves identically when a
// real backend is wired in via httpAdapter.js.

import { Emitter } from "../core/emitter.js";
import { clamp, hashStr, mulberry } from "../core/utils.js";
import { FLOOR_BOUNDS } from "../data/staticScene.js";
import { extractQuoted } from "./textParse.js";

/** Deep copy — turn events carry immutable snapshots. */
const clone = (o) => JSON.parse(JSON.stringify(o));

/** Scenario → World (mirrors engine loadScenario: tick 0, empty history). */
export function scenarioToWorld(scenario) {
  const { presentation: _presentation, ...rest } = scenario;
  const world = clone(rest);
  world.tick = 0;
  world.turnIndex = 0;
  world.history = [];
  return world;
}

const MAX_HISTORY = 80;
const MAX_MEMORIES = 12;

/* ── reply pools ─────────────────────────────────────────────────────── */

const POOLS = {
  greeting: [
    { text: "Hey {user}! Welcome to the floor — great to finally meet you.", emotion: "happy" },
    { text: "Morning! I'm {name}. Make yourself at home.", emotion: "happy" },
    { text: "Hi hi! First-day vibes — I remember mine like it was yesterday.", emotion: "excited" },
  ],
  intro: [
    { text: "Nice to meet you! I'm {name} — {role}.", emotion: "happy" },
    { text: "{name}, {role}. I've heard good things already.", emotion: "confident" },
  ],
  question: [
    { text: "Good question — honestly, the docs on that live in the repo wiki.", emotion: "thinking" },
    { text: "Hmm… I'd say yes, but don't quote me on it.", emotion: "thinking" },
    { text: "Let me think… I believe it was decided at the last retro.", emotion: "thinking" },
  ],
  coffee: [
    { text: "The coffee machine is moody before ten — I'll show you the trick.", emotion: "happy" },
    { text: "Snack drawer, top shelf. Don't tell anyone I told you.", emotion: "excited" },
    { text: "Kitchen run! Want anything while I'm up?", emotion: "happy" },
  ],
  work: [
    { text: "Oh, you'll want the platform repo — I'll drop the link after standup.", emotion: "confident" },
    { text: "Careful with that test suite, it flakes on Tuesdays. Nobody knows why.", emotion: "annoyed" },
    { text: "I can walk you through our workflow after lunch — it's mostly civilized.", emotion: "happy" },
  ],
  help: [
    { text: "Of course! Happy to help — that's literally today's job description.", emotion: "happy" },
    { text: "Sure thing. Give me two minutes to save my spreadsheet.", emotion: "happy" },
  ],
  thanks: [
    { text: "Anytime! Ping us if you need anything at all.", emotion: "happy" },
    { text: "No worries — that's what teammates are for.", emotion: "happy" },
  ],
  bye: [
    { text: "See you tomorrow! First-day survival: complete.", emotion: "happy" },
    { text: "Later, {user}! Don't forget your badge.", emotion: "happy" },
  ],
  default: [
    { text: "Got it. Noted, processed, filed.", emotion: "confident" },
    { text: "Ha! Okay, I like your style.", emotion: "happy" },
    { text: "Makes sense to me.", emotion: "neutral" },
    { text: "Interesting — tell me more later, I need to finish this first.", emotion: "thinking" },
  ],
};

/** Per-actor flavour lines merged into the default pool (prototype cast). */
const FLAVOR = {
  maya: [
    { text: "From a team-lead perspective: welcome aboard. My desk is always open.", emotion: "confident" },
    { text: "Let me show you to your brand new desk whenever you're ready.", emotion: "proud" },
  ],
  priya: [
    { text: "Welcome aboard! I design things and raid the snack drawer.", emotion: "excited" },
    { text: "Ooh, I could make you a little welcome illustration for your desk.", emotion: "excited" },
  ],
  lena: [
    { text: "H-hi… I'm Lena. I sit right over there if you ever need anything.", emotion: "shy" },
    { text: "If you break the build, tell me first. I'll hide the evidence. Kidding. Mostly.", emotion: "shy" },
  ],
  dana: [
    { text: "Dana, ops. Badge, desk, laptop — all accounted for. Welcome to Northlight!", emotion: "proud" },
    { text: "Coffee's on the counter — the machine is moody before ten.", emotion: "happy" },
  ],
};

/** Ambient (unprompted) NPC behaviour when the user didn't address anyone. */
const AMBIENT = [
    { move: true, text: null, emotion: "neutral", state: "walking across the floor" },
    { move: true, text: null, emotion: "thinking", state: "pacing, deep in thought" },
    { move: false, kind: "thought", text: "…still can't believe they put the printer that close to the snack drawer.", emotion: "thinking" },
    { move: false, kind: "thought", text: "If I finish this now, I can leave exactly on time for once.", emotion: "happy" },
    { move: false, text: "stretches and glances around the floor", emotion: "neutral" },
    { move: false, text: "types something with suspicious enthusiasm", emotion: "confident" },
    { move: false, text: "refills a water bottle at the kitchen counter", emotion: "neutral" },
    { move: false, text: "rearranges sticky notes into a color gradient", emotion: "happy" },
];

/** Named spots for "go to the kitchen/lounge/…" style user actions. */
const SPOTS = {
  door: [500, 690], entrance: [500, 690],
  kitchen: [470, 250], counter: [500, 240], coffee: [460, 235],
  lounge: [250, 340], sofa: [170, 420], table: [250, 340],
  desk: [820, 360], desks: [820, 360], pod: [820, 360],
  printer: [330, 545], cabinet: [200, 500], window: [500, 150], windows: [500, 150],
  whiteboard: [850, 150], board: [850, 150],
};

function classify(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(hi|hey|hello|yo|morning|good (morning|afternoon|evening))\b/.test(t)) return "greeting";
  if (/\b(bye|goodbye|see (you|ya)|later|good night|heading (out|off))\b/.test(t)) return "bye";
  if (/\b(thanks|thank you|cheers|appreciate)\b/.test(t)) return "thanks";
  if (/\b(i'?m|i am|my name is|name's|call me)\b/.test(t)) return "intro";
  if (/\b(coffee|tea|snack|lunch|food|hungry|water|kitchen|breakfast)\b/.test(t)) return "coffee";
  if (/\b(code|coding|bug|test|testing|deploy|release|build|repo|ticket|sprint|feature|design|review|branch|merge)\b/.test(t)) return "work";
  if (/\b(help|where|how do|how to|can you|could you|show me|point me)\b/.test(t)) return "help";
  if (/\?\s*$|\b(what|why|who|when|which|is it|do we|are we|does)\b/.test(t)) return "question";
  return "default";
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class MockAdapter extends Emitter {
  /**
   * @param {object} scenario Scenario JSON (with optional presentation)
   * @param {object} [opts] { stageDelayMs=420, seed }
   */
  constructor(scenario, opts = {}) {
    super();
    this.kind = "mock";
    this.label = "mock (offline)";
    this.scenario = scenario;
    this.stageDelayMs = opts.stageDelayMs ?? 420;
    this.rng = mulberry(opts.seed ?? hashStr(scenario.id + ":" + Date.now()));
    this.world = null;
    this.busy = false;
    /** actorId → short role label (cached; not part of the World schema) */
    this._roles = new Map(scenario.actors.map((a) => [a.id, guessRole(a)]));
  }

  /** @returns {Promise<{world, presentation}>} */
  async load() {
    this.world = scenarioToWorld(this.scenario);
    // Small-grid engine scenarios (e.g. 20×20 office-anton) use scene
    // units, not 1040×730 view pixels — movement must clamp to the scene.
    this._smallScene = (this.world.scene.width || 1040) <= 100 || (this.world.scene.height || 730) <= 100;
    return { world: clone(this.world), presentation: this.scenario.presentation || null };
  }

  _actor(id) {
    return this.world.actors.find((a) => a.id === id);
  }

  _currentActor() {
    return this._actor(this.world.order[this.world.turnIndex % this.world.order.length]);
  }

  _advance() {
    this.world.tick += 1;
    this.world.turnIndex = (this.world.turnIndex + 1) % this.world.order.length;
    if (this.world.history.length > MAX_HISTORY) {
      this.world.history.splice(0, this.world.history.length - MAX_HISTORY);
    }
  }

  _pick(arr) {
    return arr[Math.floor(this.rng() * arr.length) % arr.length];
  }

  _fill(tpl, user, npc) {
    return tpl
      .replaceAll("{user}", user.name)
      .replaceAll("{name}", npc.name)
      .replaceAll("{role}", (this._roles.get(npc.id) || guessRole(npc)).toLowerCase());
  }

  _movePointTo(x, y) {
    if (this._smallScene && this.world) {
      const W = this.world.scene.width, H = this.world.scene.height;
      return [clamp(x, 0.5, W - 0.5), clamp(y, 0.5, H - 0.5)];
    }
    return [clamp(x, FLOOR_BOUNDS.minX, FLOOR_BOUNDS.maxX), clamp(y, FLOOR_BOUNDS.minY, FLOOR_BOUNDS.maxY)];
  }

  /** Approach distance in the world's own units (view px vs grid cells). */
  _approachDist() {
    return this._smallScene ? 1.5 : 95;
  }

  /** A point `dist` px from `to`, approached from `from`. */
  _nearPoint(from, to, dist) {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const len = Math.hypot(dx, dy) || 1;
    return this._movePointTo(to[0] - (dx / len) * dist, to[1] - (dy / len) * dist);
  }

  _emitTurn(actor, actionText, speech, isUser) {
    this.emit("turn", {
      world: clone(this.world),
      actorId: actor.id,
      isUser,
      actionText,
      speech: speech || null,
      narrative: actionText,
    });
  }

  /**
   * Submit the user's free-form action, resolve it, then auto-advance all
   * NPC turns until control returns to the user (same flow as textUI's
   * runUserTurnAndNpcs).
   */
  async sendUserAction(text) {
    if (this.busy) throw new Error("A turn is already running");
    const action = String(text || "").trim();
    if (!action) throw new Error("Empty action");
    this.busy = true;
    try {
      const user = this._actor(this.world.userActorId);

      /* ── user turn (consequence only, like the engine) ─────────── */
      this.emit("progress", { actorId: user.id, stage: "consequence", message: `resolving ${user.name}'s action…` });
      await delay(this.stageDelayMs);

      const speechText = extractQuoted(action);
      let moveMatch = action.match(/\b(?:go|walk|move|head|run)\s+(?:to|toward|towards|over to)\s+(?:the\s+)?([\w\s]+?)(?:[.!]|$)/i);
      let userMoved = false;
      if (moveMatch) {
        const target = moveMatch[1].trim().toLowerCase();
        const named = this.world.actors.find((a) => a.id !== user.id && a.name.toLowerCase() === target);
        // Named view-pixel spots only exist for the bundled 1040×730 office;
        // small-grid scenarios move toward actors/objects instead.
        const spot = this._smallScene ? null : SPOTS[target.split(/\s+/)[0]];
        if (named) {
          [user.x, user.y] = this._nearPoint([user.x, user.y], [named.x, named.y], this._approachDist());
          userMoved = true;
        } else if (spot) {
          [user.x, user.y] = this._movePointTo(spot[0], spot[1]);
          userMoved = true;
        } else if (this._smallScene) {
          const obj = this.world.scene.objects.find(
            (o) => o.id.toLowerCase() === target || (o.name || "").toLowerCase() === target,
          );
          if (obj) {
            [user.x, user.y] = this._movePointTo(obj.x + obj.w / 2, obj.y + obj.h / 2);
            userMoved = true;
          }
        }
      }
      user.emotion = speechText ? "happy" : userMoved ? "neutral" : user.emotion;
      user.state = userMoved ? "moving around the office" : user.state;
      if (speechText) user.thoughts = `Said it out loud — "${speechText.slice(0, 60)}". Let's see how they take it.`;
      const userEntry = `${user.name}: ${action}`;
      this.world.history.push(userEntry);
      this._advance();
      this._emitTurn(user, userEntry, speechText ? { text: speechText, kind: "say" } : null, true);

      /* ── NPC turns until it is the user's turn again ───────────── */
      const maxNpcTurns = Math.max(0, this.world.order.length - 1);
      for (let i = 0; i < maxNpcTurns; i++) {
        const npc = this._currentActor();
        if (!npc || npc.id === this.world.userActorId) break;
        await this._runNpcTurn(npc, user, action);
      }
      return clone(this.world);
    } finally {
      this.busy = false;
    }
  }

  async _runNpcTurn(npc, user, userText) {
    const category = classify(userText);
    const addressed = mentions(userText, npc);
    const rng = this.rng();
    const responds = addressed || category !== "default" ? rng < 0.85 : rng < 0.3;

    this.emit("progress", { actorId: npc.id, stage: "proposal", message: `${npc.name} is thinking about what to do…` });
    await delay(this.stageDelayMs);
    this.emit("progress", { actorId: npc.id, stage: "selection", message: `${npc.name} is choosing an action…` });
    await delay(this.stageDelayMs * 0.6);

    let entry, speech = null;
    if (responds) {
      const pool = (FLAVOR[npc.id] && category === "default" ? [...POOLS.default, ...FLAVOR[npc.id]] : POOLS[category]) || POOLS.default;
      const tpl = this._pick(pool);
      const line = this._fill(tpl.text, user, npc);
      const dist = Math.hypot(user.x - npc.x, user.y - npc.y);
      let approach = "";
      const approachAt = this._smallScene ? 4 : 190;
      if (dist > approachAt) {
        const p = this._nearPoint([npc.x, npc.y], [user.x, user.y], this._approachDist());
        npc.x = p[0];
        npc.y = p[1];
        approach = `walks over to ${user.name} and `;
      }
      npc.dir = facing(npc, user);
      npc.emotion = tpl.emotion;
      npc.state = `talking with ${user.name}`;
      npc.thoughts = `${user.name} ${category === "greeting" ? "is introducing himself — be warm." : "said: “" + userText.slice(0, 70) + "”. Respond honestly, keep it light."}`;
      npc.memories.push(`${user.name} (${category}) — "${userText.slice(0, 60)}"`);
      if (npc.memories.length > MAX_MEMORIES) npc.memories.splice(0, npc.memories.length - MAX_MEMORIES);
      if (npc.relationships.length === 0) npc.relationships.push(`Met ${user.name} on his first day; seems friendly.`);
      speech = { text: line, kind: "say" };
      entry = `${npc.name}: ${approach}says "${line}"`;
    } else {
      const amb = this._pick(AMBIENT);
      if (amb.move) {
        const step = this._smallScene ? 3 : 160;
        const stepY = this._smallScene ? 2.5 : 130;
        const p = this._movePointTo(npc.x + (this.rng() - 0.5) * step, npc.y + (this.rng() - 0.5) * stepY);
        npc.dir = facing(npc, { x: p[0], y: p[1] });
        npc.x = p[0];
        npc.y = p[1];
      }
      if (amb.emotion) npc.emotion = amb.emotion;
      if (amb.state) npc.state = amb.state;
      if (amb.text) {
        const kind = amb.kind || "say";
        speech = { text: amb.text, kind };
        entry =
          kind === "thought"
            ? `${npc.name}: pauses, thinking "${amb.text}"`
            : `${npc.name}: ${amb.text}`;
      } else {
        entry = `${npc.name}: ${amb.state || "carries on with work"}`;
      }
      npc.thoughts = this._pick([
        "Back to it — this won't finish itself.",
        "Focus. One thing at a time.",
        "The new guy seems nice. Anyway, work.",
      ]);
    }

    this.emit("progress", { actorId: npc.id, stage: "consequence", message: `${npc.name} is acting…` });
    await delay(this.stageDelayMs * 0.5);
    this.world.history.push(entry);
    this._advance();
    this._emitTurn(npc, entry, speech, false);
  }
}

function mentions(text, actor) {
  const t = String(text || "").toLowerCase();
  const name = actor.name.toLowerCase();
  return t.includes(name) || t.includes("everyone") || t.includes("all of you") || t.includes("team");
}

function facing(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

/** Derive a short role label from the persona text (for {role} in replies). */
function guessRole(actor) {
  const m = String(actor.persona || "").match(/^([A-Za-z ]+?)[,.]/);
  return m ? m[1].trim() : "team member";
}
