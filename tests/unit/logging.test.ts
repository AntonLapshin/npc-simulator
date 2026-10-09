import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/logging/logger.js";
import { MockIntentEngine } from "../../src/mocks/mockIntentEngine.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import { buildNarrateContext } from "../../src/engine/contextBuilder.js";
import { makeTinyWorld } from "../helpers.js";

describe("logging", () => {
  it("intent logs prompt and parsed response", async () => {
    const logger = new Logger({ sessionId: "t1", writeToFile: false });
    const engine = new MockIntentEngine(logger, { u: { action: "Wave.", quote: "" } });
    const world = makeTinyWorld();
    await engine.intent(world, "u");
    const events = logger.store.events();
    expect(events).toContain("intent_started");
    expect(events).toContain("intent_completed");
    const completed = logger.store.byEvent("intent_completed")[0]!;
    expect(typeof completed.prompt).toBe("string");
    expect(completed.parsedResponse).toMatchObject({ action: "Wave." });
  });

  it("consequence logs prompt and parsed response", async () => {
    const logger = new Logger({ sessionId: "t3", writeToFile: false });
    const engine = new MockConsequenceEngine(logger);
    const world = makeTinyWorld();
    await engine.resolve(world, { actorId: "u", text: "Wave." });
    const completed = logger.store.byEvent("consequence_completed")[0]!;
    expect(typeof completed.prompt).toBe("string");
    expect(completed.parsedResponse).toBeDefined();
  });

  it("every module log entry has id, sessionId, timestamp, tick, turnIndex", async () => {
    const logger = new Logger({ sessionId: "t4", writeToFile: false });
    const intent = new MockIntentEngine(logger);
    const consequence = new MockConsequenceEngine(logger);
    const world = makeTinyWorld();
    await intent.intent(world, "u");
    await consequence.resolve(world, { actorId: "u", text: "x" });
    for (const entry of logger.store.all()) {
      expect(typeof entry.id).toBe("string");
      expect(entry.sessionId).toBe("t4");
      expect(typeof entry.timestamp).toBe("string");
      expect(typeof entry.tick).toBe("number");
      expect(typeof entry.turnIndex).toBe("number");
      expect(typeof entry.module).toBe("string");
      expect(typeof entry.event).toBe("string");
    }
  });
});

describe("NPC_LOG_PROMPTS (F29)", () => {
  afterEach(() => {
    delete process.env["NPC_LOG_PROMPTS"];
  });

  function llmEntry() {
    return {
      module: "consequence",
      event: "consequence_completed",
      tick: 1,
      turnIndex: 0,
      prompt: "FULL SYSTEM + USER PROMPT",
      rawResponse: "RAW MODEL OUTPUT",
      parsedResponse: { narrative: "x" },
      reasoning: "because reasons",
      promptChars: 1234,
      promptTokensEstimate: 308,
      durationMs: 42,
      input: { model: "test-model", backend: "test-backend" },
    };
  }

  it("strips prompt/response bodies from llm-call records when NPC_LOG_PROMPTS=0", () => {
    process.env["NPC_LOG_PROMPTS"] = "0";
    const logger = new Logger({ sessionId: "noprompts", writeToFile: false });
    const entry = logger.log(llmEntry());
    expect(entry.prompt).toBeUndefined();
    expect(entry.rawResponse).toBeUndefined();
    expect(entry.parsedResponse).toBeUndefined();
    expect(entry.reasoning).toBeUndefined();
    // Metadata is kept.
    expect(entry.promptChars).toBe(1234);
    expect(entry.promptTokensEstimate).toBe(308);
    expect(entry.durationMs).toBe(42);
    expect(entry.input).toMatchObject({ model: "test-model", backend: "test-backend" });
  });

  it("keeps prompt bodies by default (NPC_LOG_PROMPTS unset)", () => {
    const logger = new Logger({ sessionId: "prompts", writeToFile: false });
    const entry = logger.log(llmEntry());
    expect(entry.prompt).toBe("FULL SYSTEM + USER PROMPT");
    expect(entry.rawResponse).toBe("RAW MODEL OUTPUT");
  });

  it("does not strip non-llm modules even when NPC_LOG_PROMPTS=0", () => {
    process.env["NPC_LOG_PROMPTS"] = "0";
    const logger = new Logger({ sessionId: "noprompts2", writeToFile: false });
    const entry = logger.log({
      module: "turn",
      event: "turn_started",
      tick: 1,
      turnIndex: 0,
      prompt: "not an llm call",
    });
    expect(entry.prompt).toBe("not an llm call");
  });

  it("logPromptBodies option overrides the env var", () => {
    process.env["NPC_LOG_PROMPTS"] = "0";
    const logger = new Logger({ sessionId: "override", writeToFile: false, logPromptBodies: true });
    expect(logger.log(llmEntry()).prompt).toBe("FULL SYSTEM + USER PROMPT");
  });
});

describe("log rotation (F29)", () => {
  it("rotates the JSONL file at the size cap, keeping 3 rotations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "npc-logs-"));
    const logger = new Logger({
      sessionId: "rotate",
      logDir: dir,
      maxLogFileBytes: 300, // tiny cap to force several rotations quickly
    });
    for (let i = 0; i < 40; i++) {
      logger.log({
        module: "consequence",
        event: "consequence_completed",
        tick: i,
        turnIndex: 0,
        promptChars: 99999,
        durationMs: i,
      });
    }
    await logger.flush();
    const names = readdirSync(dir).sort();
    expect(names).toContain("rotate.jsonl");
    expect(names).toContain("rotate.jsonl.1");
    // Never more than live file + 3 rotations.
    expect(names.filter((n) => n.startsWith("rotate.jsonl"))).toHaveLength(4);
    expect(names).not.toContain("rotate.jsonl.4");
    // The live file still receives new entries after rotation.
    const live = readFileSync(join(dir, "rotate.jsonl"), "utf-8").trim().split("\n");
    expect(live.length).toBeGreaterThan(0);
    const last = JSON.parse(live[live.length - 1]!);
    expect(last.tick).toBe(39);
  });

  it("does not rotate below the size cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "npc-logs-"));
    const logger = new Logger({ sessionId: "norotate", logDir: dir });
    logger.log({ module: "turn", event: "turn_started", tick: 0, turnIndex: 0 });
    await logger.flush();
    expect(readdirSync(dir)).toEqual(["norotate.jsonl"]);
  });
});

describe("contextBuilder", () => {
  it("narrate context carries no private knowledge at all", () => {
    // The narrate prompt is executed facts + grounding rules — no memory,
    // belief, or goal dumps for anyone, so nothing private can leak.
    const world = makeTinyWorld();
    const n = world.actors.find((a) => a.id === "n")!;
    n.memories = ["SECRET_N_MEMORY"];
    n.beliefs = ["SECRET_N_BELIEF"];
    n.goal = "SECRET_N_GOAL";
    const u = world.actors.find((a) => a.id === "u")!;
    u.memories = ["OWN_MEMORY"];
    const ctx = buildNarrateContext(world, { actorId: "u", text: "Hi" }, undefined, {});
    expect(ctx).not.toContain("SECRET_N_MEMORY");
    expect(ctx).not.toContain("SECRET_N_BELIEF");
    expect(ctx).not.toContain("SECRET_N_GOAL");
    expect(ctx).not.toContain("OWN_MEMORY");
    // Positions are still visible (the narrator grounds the scene).
    expect(ctx).toContain("All actor positions");
  });

  it("narrate context ships positions, not the full world", () => {
    const world = makeTinyWorld();
    const u = world.actors.find((a) => a.id === "u")!;
    u.memories = ["OWN_U_MEMORY"];
    const n = world.actors.find((a) => a.id === "n")!;
    n.memories = ["SECRET_N_MEMORY"];
    const ctx = buildNarrateContext(world, { actorId: "u", text: "Hi" }, undefined, {});
    expect(ctx).toContain("All actor positions");
    expect(ctx).not.toContain("OWN_U_MEMORY");
    expect(ctx).not.toContain("SECRET_N_MEMORY");
    expect(ctx).not.toContain("Full Objective World");
  });

  it("narrate context includes validation feedback on retry", () => {
    const world = makeTinyWorld();
    const ctx = buildNarrateContext(world, { actorId: "u", text: "Hi" }, "bad output", {});
    expect(ctx).toContain("bad output");
  });
});
