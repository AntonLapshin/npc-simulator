// Exhaustive unit tests for the pure text predicates (src/core/text.ts).
// Phase 1 mandate: every core module gets a unit test file aiming at 100%
// line + branch coverage (no coverage tool installed — branches are
// enumerated deliberately below).
import { describe, expect, it } from "vitest";
import {
  extractDirectionHint,
  hasDisplacementToken,
  hasSpeechToken,
  hasStationaryWorkToken,
  maskNonLocomotion,
  maskResumedActivity,
  normalizeQuotes,
  parseActionQuotes,
  singleQuotedSegments,
} from "../../../src/core/text.js";

describe("normalizeQuotes", () => {
  it("canonicalizes curly quotes to ASCII", () => {
    expect(normalizeQuotes("“hello”")).toBe('"hello"');
    expect(normalizeQuotes("don’t")).toBe("don't");
    expect(normalizeQuotes("plain")).toBe("plain");
  });
});

describe("parseActionQuotes", () => {
  it("extracts double-quoted segments", () => {
    expect(parseActionQuotes('Say "good morning" loudly')).toEqual(["good morning"]);
  });

  it("extracts curly-quoted segments after normalization", () => {
    expect(parseActionQuotes("Say “good morning” loudly")).toEqual(["good morning"]);
  });

  it("handles apostrophes inside single-quoted dialogue", () => {
    expect(parseActionQuotes("Say, 'I'm ready to go.'")).toEqual(["I'm ready to go."]);
  });

  it("ignores bare contractions (no quote-led apostrophe)", () => {
    expect(parseActionQuotes("I don't know")).toEqual([]);
  });

  it("returns empty for quoteless text", () => {
    expect(parseActionQuotes("Walk to the door.")).toEqual([]);
  });
});

describe("singleQuotedSegments", () => {
  it("extracts comma-led single quotes", () => {
    expect(singleQuotedSegments("greets her: 'Good morning.'")).toEqual(["Good morning."]);
  });

  it("does not close early on possessives", () => {
    expect(singleQuotedSegments("looks at Tanya's desk")).toEqual([]);
  });
});

describe("maskResumedActivity", () => {
  it("masks return-to-<gerund> constructions", () => {
    const out = maskResumedActivity("He returns to typing his report.");
    expect(out).not.toMatch(/typing/);
  });

  it("masks return-focus constructions", () => {
    const out = maskResumedActivity("She returns focus to her laptop.");
    expect(out).not.toMatch(/focus/);
  });

  it("masks back-to-work nouns", () => {
    const out = maskResumedActivity("Back to work, everyone.");
    expect(out.toLowerCase()).not.toMatch(/work/);
  });

  it("leaves genuine locomotion alone", () => {
    expect(maskResumedActivity("Walk to the door.")).toMatch(/Walk to the door/);
  });
});

describe("maskNonLocomotion", () => {
  it("masks perception clauses to clause end", () => {
    const out = maskNonLocomotion("He glances over the notes, then walks away.");
    expect(out).not.toMatch(/glances/);
  });

  it("masks the go-the-extra-mile metaphor", () => {
    expect(maskNonLocomotion("Go the extra mile for the team.")).not.toMatch(/extra mile/);
  });
});

describe("hasDisplacementToken", () => {
  it("detects whole-body displacement verbs", () => {
    expect(hasDisplacementToken("Anton walks toward Tanya.")).toBe(true);
    expect(hasDisplacementToken("She runs to the door.")).toBe(true);
    expect(hasDisplacementToken("He teleports across the room.")).toBe(true);
  });

  it("detects head-to constructions and proximity phrases", () => {
    expect(hasDisplacementToken("Heads to the coffee machine.")).toBe(true);
    expect(hasDisplacementToken("Move closer to the window.")).toBe(true);
    expect(hasDisplacementToken("Step up to the counter.")).toBe(true);
  });

  it("rejects perception, speech, and stationary activity", () => {
    expect(hasDisplacementToken("She types furiously.")).toBe(false);
    expect(hasDisplacementToken("He glances at the monitor.")).toBe(false);
    expect(hasDisplacementToken("Say hello to everyone.")).toBe(false);
    expect(hasDisplacementToken("Sip the coffee slowly.")).toBe(false);
  });

  it("rejects body-part head and someone-else subordinate clauses", () => {
    expect(hasDisplacementToken("He shakes his head.")).toBe(false);
    expect(hasDisplacementToken("Anton watches as he enters the room.")).toBe(false);
  });

  it("rejects resumed activity and metaphor", () => {
    expect(hasDisplacementToken("Return to typing the report.")).toBe(false);
    expect(hasDisplacementToken("Go the extra mile for the team.")).toBe(false);
  });
});

describe("hasStationaryWorkToken", () => {
  it("detects fine-motor/observational verbs", () => {
    expect(hasStationaryWorkToken("She types furiously.")).toBe(true);
    expect(hasStationaryWorkToken("He stares blankly at the wall.")).toBe(true);
    expect(hasStationaryWorkToken("Sipping coffee by the window.")).toBe(true);
    expect(hasStationaryWorkToken("Scrolling through the feed.")).toBe(true);
  });

  it("ignores locomotion", () => {
    expect(hasStationaryWorkToken("Walk to the store.")).toBe(false);
  });
});

describe("hasSpeechToken", () => {
  it("detects quoted speech", () => {
    expect(hasSpeechToken('Say "good morning" to all.')).toBe(true);
  });

  it("detects bare question marks", () => {
    expect(hasSpeechToken("Is this my spot?")).toBe(true);
  });

  it("detects unquoted speech verbs", () => {
    expect(hasSpeechToken("Explain the deployment plan.")).toBe(true);
    expect(hasSpeechToken("Thank both engineers.")).toBe(true);
    expect(hasSpeechToken("Nod and start explaining.")).toBe(true);
  });

  it("rejects non-speech", () => {
    expect(hasSpeechToken("Walk to the door.")).toBe(false);
  });
});

describe("extractDirectionHint", () => {
  it("finds the first cardinal direction", () => {
    expect(extractDirectionHint("Take a few steps east, then stop.")).toBe("east");
    expect(extractDirectionHint("Walk NORTH toward the windows.")).toBe("north");
  });

  it("returns null when no direction is named", () => {
    expect(extractDirectionHint("Look around the room.")).toBeNull();
  });
});
