// PLAN_V2 Phase 1: pure validation for the intent-call payload.
// No I/O — validateIntentValue never touches the network or the clock.
import { describe, expect, it } from "vitest";
import {
  FALLBACK_INTENT,
  MAX_INTENT_ACTION_CHARS,
  MAX_INTENT_QUOTE_CHARS,
  validateIntentValue,
} from "../../../src/core/intent.js";

describe("validateIntentValue", () => {
  it("accepts a good payload", () => {
    const v = validateIntentValue({
      action: "Dana walks to the window.",
      quote: "",
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value).toEqual({ action: "Dana walks to the window.", quote: "" });
    }
  });

  it("accepts a payload with speech", () => {
    const v = validateIntentValue({
      action: 'Dana says "Good morning, everyone."',
      quote: "Good morning, everyone.",
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.quote).toBe("Good morning, everyone.");
  });

  it("trims surrounding whitespace from the action", () => {
    const v = validateIntentValue({ action: "  Dana nods.  ", quote: "" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.action).toBe("Dana nods.");
  });

  it("accepts extra keys (the zod schema is strict; the pure check is lenient)", () => {
    const v = validateIntentValue({ action: "Dana nods.", quote: "", reasoning: "x" });
    expect(v.ok).toBe(true);
  });

  it("rejects non-objects", () => {
    for (const bad of [null, undefined, 42, "nope", ["Dana nods."]]) {
      const v = validateIntentValue(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toContain("JSON object");
    }
  });

  it("rejects missing, empty, or non-string actions", () => {
    for (const action of [undefined, "", "   ", 42, null]) {
      const v = validateIntentValue({ action, quote: "" });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toContain("intent.action");
    }
  });

  it("rejects a non-string quote", () => {
    for (const quote of [undefined, 42, null, ["hi"]]) {
      const v = validateIntentValue({ action: "Dana nods.", quote });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toContain("intent.quote");
    }
  });

  it("rejects over-long actions and quotes", () => {
    const longAction = validateIntentValue({
      action: `Dana ${"nods. ".repeat(200)}`,
      quote: "",
    });
    expect(longAction.ok).toBe(false);
    if (!longAction.ok) expect(longAction.error).toContain(String(MAX_INTENT_ACTION_CHARS));

    const longQuote = validateIntentValue({
      action: "Dana speaks.",
      quote: "x".repeat(MAX_INTENT_QUOTE_CHARS + 1),
    });
    expect(longQuote.ok).toBe(false);
    if (!longQuote.ok) expect(longQuote.error).toContain(String(MAX_INTENT_QUOTE_CHARS));
  });
});

describe("FALLBACK_INTENT", () => {
  it("is the deterministic wait-and-observe action", () => {
    expect(FALLBACK_INTENT).toEqual({
      action: "waits and observes the situation.",
      quote: "",
    });
  });

  it("passes validation itself", () => {
    expect(validateIntentValue(FALLBACK_INTENT).ok).toBe(true);
  });
});
