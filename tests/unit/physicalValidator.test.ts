import { describe, expect, it } from "vitest";
import {
  renderRetryFeedback,
  validateRenderProse,
  type RenderFacts,
} from "../../src/engine/validate/render.js";
import { makeTinyWorld, errorText } from "../helpers.js";
import type { ConsequenceResult } from "../../src/types.js";

type Prose = Pick<ConsequenceResult, "narrative" | "thoughts">;

function facts(over: Partial<RenderFacts> = {}): RenderFacts {
  return {
    exactQuote: null,
    moved: false, destinationActorId: null,
    pose: null,
    effectivePose: "stand",
    x: 1,
    y: 1,
    engineManipulation: null,
    ...over,
  };
}

function prose(narrative: string, thoughts?: string): Prose {
  return { narrative, ...(thoughts !== undefined ? { thoughts } : {}) };
}

describe("validateRenderProse (Phase 4: prose-only contract)", () => {
  it("accepts clean prose with no engine movement", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Wave at N." },
      prose("U waves at N.", "Hope N noticed."),
      facts(),
    );
    expect(errors).toEqual([]);
  });

  it("rejects placeholder and action-echo narratives", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Do a little dance." };
    expect(
      errorText(
        validateRenderProse(world, action, prose("Nothing changes."), facts()),
      ),
    ).toMatch(/narrative\.placeholder/);
    expect(
      errorText(
        validateRenderProse(world, action, prose("Do a little dance."), facts()),
      ),
    ).toMatch(/narrative\.echoes_action/);
  });

  it("requires the engine-dictated exact quote verbatim", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: '"Greeting all!"' };
    const f = facts({ exactQuote: "Greeting all!" });
    expect(
      validateRenderProse(world, action, prose('U says "Greeting all!" to the room.'), f),
    ).toEqual([]);
    const bad = validateRenderProse(
      world,
      action,
      prose("U greets everyone warmly.", "Nervous."),
      f,
    );
    expect(errorText(bad)).toMatch(/speech\.exact_quote_missing/);
  });

  it("rejects first-person narrative voice", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Point at the door." },
      prose("I point at the door."),
      facts(),
    );
    expect(errorText(errors)).toMatch(/narrative\./);
  });

  it("rejects observer-as-subject prose", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "n")!.name = "Nadia";
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Wave at Nadia." },
      prose("Nadia waves back at U."),
      facts(),
    );
    expect(errorText(errors)).toMatch(/narrative\.observer_as_subject/);
  });

  it("rejects unknown actors in prose", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Greet the newcomer." },
      prose("U greets Zara warmly."),
      facts(),
    );
    expect(errorText(errors)).toMatch(/narrative\.unknown_actor/);
  });

  it("rejects narrated locomotion the engine did not execute", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Walk across the room." };
    const errors = validateRenderProse(
      world,
      action,
      prose("U walks across the room."),
      facts({ moved: false }),
    );
    expect(errorText(errors)).toMatch(/movement\.narrated_without_move/);
    // Engine move grounds the same prose.
    expect(
      validateRenderProse(world, action, prose("U walks across the room."), facts({ moved: true, x: 3, y: 1 })),
    ).toEqual([]);
  });

  it("rejects narrated pose changes the engine did not execute", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Stretch." };
    const errors = validateRenderProse(
      world,
      action,
      prose("U stands up and stretches."),
      facts({ pose: null }),
    );
    expect(errorText(errors)).toMatch(/movement\.pose_change_ungrounded/);
    expect(
      validateRenderProse(world, action, prose("U stands up and stretches."), facts({ pose: "stand" })),
    ).toEqual([]);
  });

  it("rejects engine movement on explicit stay actions", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Stay where you are." },
      prose("U stays put."),
      facts({ moved: true, x: 2, y: 1 }),
    );
    expect(errorText(errors)).toMatch(/movement\.unexpected_move/);
  });

  it("rejects phantom manipulation prose", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Look around." },
      prose("U picks up the laptop and opens it."),
      facts({ engineManipulation: null }),
    );
    expect(errorText(errors)).toMatch(/object\.phantom_manipulation/);
  });

  it("grounds thoughts: no invented people, no ungrounded claims", () => {
    const world = makeTinyWorld();
    const action = { actorId: "u", text: "Think." };
    const bad = validateRenderProse(
      world,
      action,
      prose("U thinks.", "Zara asked about this earlier."),
      facts(),
    );
    expect(errorText(bad)).toMatch(/thoughts\.unknown_proper_noun/);
    expect(
      validateRenderProse(world, action, prose("U thinks.", "Staying focused."), facts()),
    ).toEqual([]);
  });

  it("enforces pronoun discipline when the actor sets pronouns", () => {
    const world = makeTinyWorld();
    world.actors.find((a) => a.id === "u")!.pronouns = "he/him";
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: "Greet the room." },
      prose("U smiles as she says hello."),
      facts(),
    );
    expect(errorText(errors)).toMatch(/pronoun_mismatch/);
  });

  it("renderRetryFeedback leads with the first error", () => {
    const world = makeTinyWorld();
    const errors = validateRenderProse(
      world,
      { actorId: "u", text: '"Hi!"' },
      prose("U greets everyone warmly."),
      facts({ exactQuote: "Hi!" }),
    );
    expect(errors.length).toBeGreaterThan(0);
    const fb = renderRetryFeedback(errors);
    expect(fb).toContain(`[${errors[0]!.code}]`);
    expect(fb).toMatch(/Return corrected JSON only/);
    expect(renderRetryFeedback([])).toMatch(/Return corrected JSON only/);
  });
});
