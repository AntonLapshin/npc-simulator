// PLAN_V2 Phase 2: golden set — action sentence → expected ActionSemantics
// through LayaSemanticJudge.classify with a SCRIPTED fake Laya client
// (deterministic answers per question, no network).
//
// The sentences are real turn-log language (experiments/stage logs and
// long-standing judge fixtures), not invented toys. The scripted answers
// stand in for the decision model's judgement; what the test genuinely
// exercises is the judge's translation layer: one batched decide over the
// 5 judge questions, deterministic quote extraction from the raw sentence,
// and roster/landmark name → id resolution (including the none-tokens).

import { describe, expect, it } from "vitest";
import type { Action, ActionSemantics, World } from "../../src/types.js";
import type { LayaAnswer } from "../../src/decision/decisionTypes.js";
import { LayaClient } from "../../src/decision/layaClient.js";
import { LayaSemanticJudge } from "../../src/decision/layaSemanticJudge.js";
import { parseActionQuotes } from "../../src/core/text.js";
import { loadScenario } from "../../src/engine/scenarioLoader.js";

/**
 * Scripted LayaClient: answers come from a per-question-id script instead
 * of the network (same pattern as tests/unit/decision/engines.test.ts).
 * Records the question ids and raw state of every decide call.
 */
function scriptedClient(
  script: Record<string, LayaAnswer>,
  onCall?: (ids: string[], state: string) => void,
): LayaClient {
  return new LayaClient({
    baseUrl: "http://stub",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const state = (body.state as { document?: string } | undefined)?.document ?? "";
      const ids = Object.keys(body.questions ?? {});
      onCall?.(ids, state);
      const answers: Record<string, unknown> = {};
      for (const id of ids) {
        const a = script[id];
        if (!a) throw new Error(`no scripted answer for "${id}"`);
        answers[id] =
          a.type === "choice"
            ? {
                type: "choice",
                choice: a.winner,
                probabilities: a.probabilities,
                confidence: a.confidence,
              }
            : a.type === "noul"
              ? { type: "noul", noul: a.pTrue }
              : {
                  type: "score",
                  score: a.expected,
                  probabilities: a.distribution,
                  confidence: 0.5,
                };
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch,
  });
}

function choice(winner: string, p: number, options: string[]): LayaAnswer {
  const probabilities: Record<string, number> = {};
  for (const o of options)
    probabilities[o] = o === winner ? p : (1 - p) / Math.max(1, options.length - 1);
  return { type: "choice", winner, probabilities, confidence: p };
}

const ACTOR_NAMES = ["Anton", "Tanya", "Dana"];
const ADDRESSEE_OPTIONS = [...ACTOR_NAMES, "nobody in particular"];
const DESTINATION_OPTIONS = ["desk", "coffee machine", "whiteboard", ...ACTOR_NAMES, "stays put / nowhere"];
const CONTACT_OPTIONS = [...ACTOR_NAMES, "no physical contact"];

function makeWorld(): World {
  const actor = (id: string, name: string, x: number, y: number) => ({
    id,
    name,
    persona: `${name} persona.`,
    x,
    y,
    state: "standing",
    emotion: "calm",
    goal: "Idle.",
    memories: [] as string[],
    beliefs: [] as string[],
    relationships: [] as string[],
  });
  const obj = (id: string, name: string, x: number, y: number) => ({
    id,
    name,
    description: `A ${name}.`,
    x,
    y,
    w: 1,
    h: 1,
    passable: false,
    blocksVision: false,
    blocksSound: false,
  });
  return loadScenario({
    version: 1,
    id: "golden",
    title: "Golden office",
    narrative: "A small office.",
    userActorId: "anton",
    order: ["anton", "tanya", "dana"],
    scene: {
      width: 12,
      height: 12,
      objects: [obj("o-desk", "desk", 2, 2), obj("o-coffee", "coffee machine", 8, 2), obj("o-board", "whiteboard", 5, 8)],
    },
    actors: [actor("anton", "Anton", 1, 1), actor("tanya", "Tanya", 4, 4), actor("dana", "Dana", 7, 7)],
  });
}

type GoldenRow = {
  actorId: string;
  text: string;
  moves: boolean;
  speaks: boolean;
  /** Scripted addressee winner (name) — omitted = "nobody in particular". */
  addressee?: string;
  /** Scripted destination winner (actor or object name) — omitted = "stays put / nowhere". */
  destination?: string;
  /** Scripted contact winner (actor name) — omitted = "no physical contact". */
  contact?: string;
  /** Expected quoted speech (hand-verified against parseActionQuotes). */
  quotes: string[];
};

// Sentences 1–14, 11: real action text from the Stage-1/2/3 turn logs
// (logs/text_mv15s9wp.jsonl, logs/text_mv16adni.jsonl). Sentences 15–23:
// long-standing judge fixtures from the existing test suite (real
// regression language). Sentence 24: a put-down (manipulation, no
// semantics beyond stillness).
const ROWS: GoldenRow[] = [
  {
    actorId: "anton",
    text: "Ask Tanya 'Do you know where my desk is?' while fiddling with his laptop bag",
    moves: false, speaks: true, addressee: "Tanya",
    quotes: ["Do you know where my desk is?"],
  },
  {
    actorId: "tanya",
    text: "Tell Anton his desk is with the lamp and offer to help set up his laptop.",
    moves: false, speaks: true, addressee: "Anton",
    quotes: [],
  },
  {
    actorId: "dana",
    text: "Tell Anton his desk is with the name plate, then return to screening",
    moves: false, speaks: true, addressee: "Anton",
    quotes: [],
  },
  {
    actorId: "anton",
    text: "Approach Tanya's desk and say, 'Hey Tanya, I'm Anton, your referral. Can you help me find my desk? I'm a bit lost.'",
    moves: true, speaks: true, addressee: "Tanya", destination: "desk",
    quotes: ["Hey Tanya, I'm Anton, your referral. Can you help me find my desk? I'm a bit lost."],
  },
  {
    actorId: "tanya",
    text: "Walk over to Anton's desk to check if he needs help setting up his laptop or adjusting the lamp.",
    moves: true, speaks: false, destination: "desk",
    quotes: [],
  },
  {
    actorId: "tanya",
    text: "Ask Anton if he needs help setting up his laptop or adjusting the lamp.",
    moves: false, speaks: true, addressee: "Anton",
    quotes: [],
  },
  {
    actorId: "anton",
    text: "Say, 'Sorry to bother, but I'm trying to find my desk. Any chance you've seen a name plate with my name?' to Dana.",
    moves: false, speaks: true, addressee: "Dana",
    quotes: ["Sorry to bother, but I'm trying to find my desk. Any chance you've seen a name plate with my name?"],
  },
  {
    actorId: "anton",
    text: "Approach Tanya's desk by moving toward her position to introduce myself and ask for help finding my desk.",
    moves: true, speaks: false, destination: "desk",
    quotes: [],
  },
  {
    actorId: "tanya",
    text: "Pause my test plan briefly to introduce myself to Anton and ask if he needs anything.",
    moves: false, speaks: true, addressee: "Anton",
    quotes: [],
  },
  {
    actorId: "anton",
    text: "Move toward my desk (anton_desk) to confirm its location and check the setup",
    moves: true, speaks: false, destination: "desk",
    quotes: [],
  },
  {
    actorId: "anton",
    text: "Anton walks toward the coffee machine to grab a coffee, muttering, 'First day, first coffee — here's to hoping this doesn't end in a disaster.'",
    moves: true, speaks: true, destination: "coffee machine",
    quotes: ["First day, first coffee — here's to hoping this doesn't end in a disaster."],
  },
  {
    actorId: "dana",
    text: "Dana continues furiously typing on his laptop, muttering, 'Need to finish this by Friday... can't afford delays,' his eyes barely glancing away from the screen.",
    moves: false, speaks: true,
    quotes: ["Need to finish this by Friday... can't afford delays,"],
  },
  {
    actorId: "dana",
    text: "Ignore Anton entirely and continue screening",
    moves: false, speaks: false,
    quotes: [],
  },
  {
    actorId: "tanya",
    text: "I'll pause my test plan to explain the onboarding steps: set up your laptop, grab a coffee, then meet with Dana for formal paperwork.",
    moves: false, speaks: true,
    quotes: [],
  },
  {
    actorId: "anton",
    text: 'Anton walks to the whiteboard and tells Dana: "Look at this diagram."',
    moves: true, speaks: true, addressee: "Dana", destination: "whiteboard",
    quotes: ["Look at this diagram."],
  },
  {
    actorId: "dana",
    text: "Sighs, rubs temples, and mutters 'Just a few more minutes...' before returning to staring at the monitor, trying to refocus.",
    moves: false, speaks: true,
    quotes: ["Just a few more minutes..."],
  },
  {
    actorId: "anton",
    text: "Anton keeps typing.",
    moves: false, speaks: false,
    quotes: [],
  },
  {
    actorId: "tanya",
    text: "Mutters about the deadline.",
    moves: false, speaks: true,
    quotes: [],
  },
  {
    actorId: "anton",
    text: "Extend a hand to Dana for a firm handshake.",
    moves: false, speaks: false, contact: "Dana",
    quotes: [],
  },
  {
    actorId: "tanya",
    text: "Walk over to Dana and shake his hand.",
    moves: true, speaks: false, destination: "Dana", contact: "Dana",
    quotes: [],
  },
  {
    actorId: "dana",
    text: "Pick up the laptop from the desk.",
    moves: false, speaks: false,
    quotes: [],
  },
  {
    actorId: "anton",
    text: "Call out a friendly 'Hey!' as he sees Tanya, then return to typing.",
    moves: false, speaks: true, addressee: "Tanya",
    quotes: ["Hey!"],
  },
  {
    actorId: "tanya",
    text: "Nod at Anton and smile.",
    moves: false, speaks: false,
    quotes: [],
  },
  {
    actorId: "dana",
    text: "Put the laptop down on the desk.",
    moves: false, speaks: false,
    quotes: [],
  },
];

const ACTOR_IDS: Record<string, string> = { Anton: "anton", Tanya: "tanya", Dana: "dana" };
const OBJECT_IDS: Record<string, string> = {
  desk: "o-desk",
  "coffee machine": "o-coffee",
  whiteboard: "o-board",
};

function scriptFor(row: GoldenRow): Record<string, LayaAnswer> {
  return {
    q_moves: { type: "noul", pTrue: row.moves ? 0.92 : 0.05 },
    q_speaks: { type: "noul", pTrue: row.speaks ? 0.95 : 0.05 },
    q_addressee: choice(row.addressee ?? "nobody in particular", 0.9, ADDRESSEE_OPTIONS),
    q_destination: choice(row.destination ?? "stays put / nowhere", 0.88, DESTINATION_OPTIONS),
    q_contact: choice(row.contact ?? "no physical contact", 0.97, CONTACT_OPTIONS),
  };
}

function expectedSemantics(row: GoldenRow): ActionSemantics {
  const s: ActionSemantics = {
    moves: row.moves,
    speaks: row.speaks,
    quotedSpeech: row.quotes,
  };
  if (row.addressee !== undefined) s.addresseeActorId = ACTOR_IDS[row.addressee];
  if (row.destination !== undefined) {
    const actorId = ACTOR_IDS[row.destination];
    if (actorId !== undefined) s.destinationActorId = actorId;
    else s.destinationObjectId = OBJECT_IDS[row.destination];
  }
  if (row.contact !== undefined) s.contactActorId = ACTOR_IDS[row.contact];
  return s;
}

describe("PLAN_V2 Phase 2 golden set: sentence → ActionSemantics", () => {
  it(`classifies all ${ROWS.length} golden sentences exactly (one batched decide each)`, async () => {
    const world = makeWorld();
    let failures = 0;
    for (const row of ROWS) {
      const action: Action = { actorId: row.actorId, text: row.text };
      let seenIds: string[] = [];
      let seenState = "";
      const client = scriptedClient(scriptFor(row), (ids, state) => {
        seenIds = ids;
        seenState = state;
      });
      const judge = new LayaSemanticJudge({ client });
      const semantics = await judge.classify(world, action);
      // One batched decide over exactly the 5 judge questions.
      expect(seenIds.sort()).toEqual(
        ["q_addressee", "q_contact", "q_destination", "q_moves", "q_speaks"].sort(),
      );
      // The parser sees the single action sentence — never scene state.
      expect(seenState).toContain(`Action: ${row.text}`);
      try {
        expect(semantics).toEqual(expectedSemantics(row));
      } catch (err) {
        failures++;
        // Re-throw with the row attached so a failure names its sentence.
        throw new Error(`golden row failed [${row.actorId}] "${row.text}": ${(err as Error).message}`);
      }
      expect(failures).toBe(0);
    }
  });

  it("hardcoded quote expectations match the deterministic extractor (the set is self-consistent)", () => {
    for (const row of ROWS) {
      expect(parseActionQuotes(row.text)).toEqual(row.quotes);
    }
  });
});
