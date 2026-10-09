// Exhaustive unit tests for the pure speech core (Phase 2).
// Branch coverage is enumerated by hand: every rule below exercises a
// distinct branch of extractExactQuote / quoteContained / quoteCovers /
// reinsertQuote.
import { describe, expect, it } from "vitest";
import {
  extractExactQuote,
  normQuote,
  quoteContained,
  quoteCovers,
  reinsertQuote,
} from "../../../src/core/speech.js";

describe("extractExactQuote", () => {
  it("returns null when the action has no quotes", () => {
    expect(extractExactQuote("Dana walks to the desk.")).toBeNull();
    expect(extractExactQuote("")).toBeNull();
    expect(extractExactQuote("Say hello")).toBeNull();
  });

  it("extracts a double-quoted segment", () => {
    expect(extractExactQuote('Dana says "I need help with the API"')).toBe(
      "I need help with the API",
    );
  });

  it("extracts a single-quoted segment", () => {
    expect(extractExactQuote("Dana whispers 'meet me at noon today'")).toBe(
      "meet me at noon today",
    );
  });

  it("normalizes curly quotes before extraction", () => {
    expect(extractExactQuote("Dana says \u201cI need help\u201d")).toBe("I need help");
    expect(extractExactQuote("Dana says \u2018meet me at noon today\u2019")).toBe(
      "meet me at noon today",
    );
  });

  it("picks the FIRST segment when the action has multiple quotes (documented multi-quote rule)", () => {
    expect(extractExactQuote('Dana says "hi" then adds "bye"')).toBe("hi");
    expect(extractExactQuote('"first" and "second" and "third"')).toBe("first");
  });

  it("finds quotes at the string boundaries", () => {
    expect(extractExactQuote('"Hello there."')).toBe("Hello there.");
    expect(extractExactQuote('She shouts "stop!"')).toBe("stop!");
  });

  it("ignores empty quotes", () => {
    expect(extractExactQuote('Dana says ""')).toBeNull();
    expect(extractExactQuote("Dana says ''")).toBeNull();
  });

  it("ignores unclosed quotes", () => {
    expect(extractExactQuote('Dana says "I need help')).toBeNull();
  });

  it("handles apostrophes inside quotes", () => {
    expect(extractExactQuote('Dana says "don\'t go"')).toBe("don't go");
  });

  it("handles unicode content", () => {
    expect(extractExactQuote('Dana says "caf\u00e9 \u2615 break?"')).toBe("caf\u00e9 \u2615 break?");
  });

  it("a bare contraction never opens a single-quoted segment", () => {
    expect(extractExactQuote("Dana says don't go")).toBeNull();
  });
});

describe("quoteContained", () => {
  it("is true for a verbatim occurrence", () => {
    expect(
      quoteContained("I need help with the API", 'Dana says "I need help with the API", smiling.'),
    ).toBe(true);
  });

  it("is false when a word is altered", () => {
    expect(
      quoteContained("I need help with the API", 'Dana says "I need help with the backend".'),
    ).toBe(false);
  });

  it("is case-sensitive (character-for-character)", () => {
    expect(quoteContained("is this my spot?", 'Anton asks "Is this my spot?"')).toBe(false);
    expect(quoteContained("Is this my spot?", 'Anton asks "Is this my spot?"')).toBe(true);
  });

  it("treats curly and straight quote styles as equal", () => {
    expect(
      quoteContained("I need help", "Dana says \u201cI need help\u201d today."),
    ).toBe(true);
    expect(
      quoteContained("\u201cI need help\u201d", 'Dana says "I need help" today.'),
    ).toBe(true);
  });

  it("is false for punctuation differences", () => {
    expect(quoteContained("Hello, there", 'U says "Hello there"')).toBe(false);
    expect(quoteContained("Hello there", 'U says "Hello, there"')).toBe(false);
  });

  it("is false for an empty narrative or empty quote", () => {
    expect(quoteContained("hello", "")).toBe(false);
    expect(quoteContained("", "hello")).toBe(false);
  });

  it("finds the quote embedded in longer prose", () => {
    expect(
      quoteContained("desk", "U walks to N. U says something about the desk quietly."),
    ).toBe(true);
  });
});

describe("quoteCovers", () => {
  it("covers equal quotes (quote-style and case-insensitive)", () => {
    expect(quoteCovers("Hello", "hello")).toBe(true);
    expect(quoteCovers("\u201cHello\u201d", '"hello"')).toBe(true);
  });

  it("covers substring relations either way", () => {
    expect(quoteCovers("I need help with the API", "need help")).toBe(true);
    expect(quoteCovers("need help", "I need help with the API")).toBe(true);
  });

  it("does not cover unrelated quotes", () => {
    expect(quoteCovers("I need help with the API", "the servers are on fire")).toBe(false);
  });

  it("does not cover empty strings", () => {
    expect(quoteCovers("", "hello")).toBe(false);
    expect(quoteCovers("hello", "")).toBe(false);
  });
});

describe("normQuote", () => {
  it("canonicalizes quote style and collapses whitespace, preserving case", () => {
    expect(normQuote("  \u201cHello   world\u201d ")).toBe('"Hello world"');
    expect(normQuote("MiXeD")).toBe("MiXeD");
  });
});

describe("reinsertQuote", () => {
  const quote = "I need help with the API";

  it("returns the narrative unchanged when the quote is already present", () => {
    const n = `Dana says "${quote}", looking hopeful.`;
    expect(reinsertQuote(n, "Dana", quote)).toBe(n);
  });

  it("treats a curly-quoted occurrence as present", () => {
    const n = "Dana says \u201cI need help with the API\u201d today.";
    expect(reinsertQuote(n, "Dana", quote)).toBe(n);
  });

  it("appends to a clean paraphrase frame, keeping the model's prose", () => {
    expect(reinsertQuote("Dana asks for help with the API.", "Dana", quote)).toBe(
      `Dana asks for help with the API. Dana says "${quote}"`,
    );
  });

  it("appends to a quote-free frame", () => {
    expect(reinsertQuote("Dana looks around the office.", "Dana", quote)).toBe(
      `Dana looks around the office. Dana says "${quote}"`,
    );
  });

  it("replaces an empty narrative with the bare sentence", () => {
    expect(reinsertQuote("", "Dana", quote)).toBe(`Dana says "${quote}"`);
    expect(reinsertQuote("   ", "Dana", quote)).toBe(`Dana says "${quote}"`);
  });

  it("replaces a frame that invents dialogue", () => {
    expect(
      reinsertQuote('Dana says "I need help with the backend".', "Dana", quote),
    ).toBe(`Dana says "${quote}"`);
  });

  it("leaves a frame with the exact quote plus extra dialogue to the validator", () => {
    // The exact quote IS present, so the backstop does nothing — the
    // invented extra quote is the speech.invented_dialogue validator's
    // job, not the reinsertion's.
    const n = `Dana says "${quote}" and adds "the servers are on fire".`;
    expect(reinsertQuote(n, "Dana", quote)).toBe(n);
  });

  it("appends when the frame's quote is a covered truncation", () => {
    // "need help" is covered by the exact quote (substring) → clean frame.
    expect(reinsertQuote('Dana says "need help".', "Dana", quote)).toBe(
      `Dana says "need help". Dana says "${quote}"`,
    );
  });

  it("never mutates its inputs", () => {
    const n = "Dana looks around.";
    const frozen = n;
    reinsertQuote(n, "Dana", quote);
    expect(n).toBe(frozen);
  });
});
