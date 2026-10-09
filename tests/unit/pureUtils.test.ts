// Unit tests for low-level pure helpers extracted during the code-structure
// cleanup: shared utils, turn-level pure functions, and salvage donor
// extraction. No LLM calls, no engine wiring — pure input/output.
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { errorMessage } from "../../src/util/errors.js";
import { loadEnvFile } from "../../src/util/loadEnv.js";
import { stripSelectionPrefix } from "../../src/engine/turnOrchestrator.js";
import { isFallbackConsequence } from "../../src/engine/turnSalvage.js";
import { FALLBACK_CONSEQUENCE } from "../../src/llm/llmConsequenceEngine.js";
import { minimalRepairPrompt, parseErrorSignature } from "../../src/llm/complete.js";
import { suggestSimilarIds } from "../../src/engine/validate/textUtils.js";

describe("errorMessage", () => {
  it("unwraps Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  it("stringifies non-errors", () => {
    expect(errorMessage("raw")).toBe("raw");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(null)).toBe("null");
  });
});

describe("stripSelectionPrefix", () => {
  it("strips dotted candidate numbering", () => {
    expect(stripSelectionPrefix("3. Call out to Jeff")).toBe("Call out to Jeff");
  });
  it("strips parenthesized candidate numbering", () => {
    expect(stripSelectionPrefix("2) Nod quietly")).toBe("Nod quietly");
  });
  it("leaves plain actions untouched", () => {
    expect(stripSelectionPrefix("Walk to the desk")).toBe("Walk to the desk");
    expect(stripSelectionPrefix("")).toBe("");
  });
  it("tolerates leading whitespace and multi-digit numbers", () => {
    expect(stripSelectionPrefix("  10.  spaced out")).toBe("spaced out");
  });
});

describe("parseErrorSignature", () => {
  it("collapses digit runs so positions compare equal", () => {
    expect(parseErrorSignature("Unexpected token at position 37")).toBe(
      parseErrorSignature("Unexpected token at position 38"),
    );
  });
  it("lowercases and collapses whitespace", () => {
    expect(parseErrorSignature("Schema   MISMATCH at position 12")).toBe(
      "schema mismatch at position #",
    );
  });
});

describe("minimalRepairPrompt", () => {
  it("demands a bare JSON object first", () => {
    const p = minimalRepairPrompt();
    expect(p).toContain("Return ONLY the JSON object now.");
    expect(p).toContain("Begin your response with {");
  });
  it("embeds the schema text when given", () => {
    const p = minimalRepairPrompt('{"narrative": string}');
    expect(p).toContain("It must match this schema:");
    expect(p).toContain('{"narrative": string}');
  });
});

describe("isFallbackConsequence", () => {
  it("recognizes the canonical fallback", () => {
    expect(isFallbackConsequence(structuredClone(FALLBACK_CONSEQUENCE))).toBe(true);
  });
  it("rejects altered narratives", () => {
    expect(
      isFallbackConsequence({ ...structuredClone(FALLBACK_CONSEQUENCE), narrative: "x" }),
    ).toBe(false);
    expect(isFallbackConsequence({ narrative: "Custom.", reasoning: "r" })).toBe(false);
  });
});

describe("suggestSimilarIds", () => {
  it("ranks close matches first", () => {
    const out = suggestSimilarIds("anton_desk", ["anton_desk", "dana_desk", "mug"]);
    expect(out.split(", ")[0]).toBe('"anton_desk"');
  });
  it("returns up to k suggestions", () => {
    const out = suggestSimilarIds("x", ["a", "b", "c", "d", "e"], 3);
    expect(out.split(", ")).toHaveLength(3);
  });
});

describe("loadEnvFile", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["NPC_TEST_A", "NPC_TEST_B", "NPC_TEST_C"];
  for (const k of keys) saved[k] = process.env[k];
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function writeEnv(dir: string, content: string): string {
    writeFileSync(join(dir, ".env"), content, "utf-8");
    return dir;
  }

  it("loads KEY=value pairs, strips quotes and comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "envtest-"));
    try {
      writeEnv(dir, '# comment\nNPC_TEST_A=hello\nNPC_TEST_B="quoted value"\n\nNPC_TEST_C=\'single\'\n');
      expect(loadEnvFile(dir)).toBe(true);
      expect(process.env["NPC_TEST_A"]).toBe("hello");
      expect(process.env["NPC_TEST_B"]).toBe("quoted value");
      expect(process.env["NPC_TEST_C"]).toBe("single");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overrides existing variables", () => {
    const dir = mkdtempSync(join(tmpdir(), "envtest-"));
    try {
      process.env["NPC_TEST_A"] = "preset";
      writeEnv(dir, "NPC_TEST_A=fromfile\n");
      loadEnvFile(dir);
      expect(process.env["NPC_TEST_A"]).toBe("preset");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when no .env exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "envtest-"));
    try {
      expect(loadEnvFile(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
