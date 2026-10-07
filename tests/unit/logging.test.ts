import { describe, expect, it } from "vitest";
import { Logger } from "../../src/logging/logger.js";
import { MockProposalEngine } from "../../src/mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../../src/mocks/mockSelectionEngine.js";
import { MockConsequenceEngine } from "../../src/mocks/mockConsequenceEngine.js";
import {
  buildConsequenceContext,
  buildProposalContext,
  buildSelectionContext,
} from "../../src/engine/contextBuilder.js";
import { makeTinyWorld } from "../helpers.js";

describe("logging", () => {
  it("proposal logs prompt and parsed response", async () => {
    const logger = new Logger({ sessionId: "t1", writeToFile: false });
    const engine = new MockProposalEngine(logger);
    const world = makeTinyWorld();
    await engine.propose(world, "u");
    const events = logger.store.events();
    expect(events).toContain("proposal_started");
    expect(events).toContain("proposal_completed");
    const completed = logger.store.byEvent("proposal_completed")[0]!;
    expect(typeof completed.prompt).toBe("string");
    expect(completed.parsedResponse).toBeDefined();
  });

  it("selection logs prompt and parsed response", async () => {
    const logger = new Logger({ sessionId: "t2", writeToFile: false });
    const engine = new MockSelectionEngine(logger);
    const world = makeTinyWorld();
    await engine.select(world, "u", ["Do this."]);
    const completed = logger.store.byEvent("selection_completed")[0]!;
    expect(typeof completed.prompt).toBe("string");
    expect(completed.parsedResponse).toMatchObject({ action: "Do this." });
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
    const proposal = new MockProposalEngine(logger);
    const selection = new MockSelectionEngine(logger);
    const consequence = new MockConsequenceEngine(logger);
    const world = makeTinyWorld();
    await proposal.propose(world, "u");
    await selection.select(world, "u", ["x"]);
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

describe("contextBuilder", () => {
  it("proposal/selection contexts hide other actors' private knowledge", () => {
    const world = makeTinyWorld();
    const n = world.actors.find((a) => a.id === "n")!;
    n.memories = ["SECRET_N_MEMORY"];
    n.beliefs = ["SECRET_N_BELIEF"];
    n.goal = "SECRET_N_GOAL";
    const proposalCtx = buildProposalContext(world, "u");
    expect(proposalCtx).not.toContain("SECRET_N_MEMORY");
    expect(proposalCtx).not.toContain("SECRET_N_BELIEF");
    expect(proposalCtx).not.toContain("SECRET_N_GOAL");
    // Own knowledge is included.
    const u = world.actors.find((a) => a.id === "u")!;
    u.memories = ["OWN_MEMORY"];
    expect(buildProposalContext(world, "u")).toContain("OWN_MEMORY");

    const selectionCtx = buildSelectionContext(world, "u", ["Do x."]);
    expect(selectionCtx).not.toContain("SECRET_N_MEMORY");
    expect(selectionCtx).toContain("Do x.");
  });

  it("consequence context ships a slim snapshot, not the full world", () => {
    const world = makeTinyWorld();
    const u = world.actors.find((a) => a.id === "u")!;
    u.memories = ["OWN_U_MEMORY"];
    const n = world.actors.find((a) => a.id === "n")!;
    n.memories = ["SECRET_N_MEMORY"];
    const ctx = buildConsequenceContext(world, { actorId: "u", text: "Hi" });
    // Acting actor's memories (summarized) and positions are visible…
    expect(ctx).toContain("OWN_U_MEMORY");
    expect(ctx).toContain("All actor positions");
    expect(ctx).toContain("Hi");
    // …but other actors' compounding private lists never enter the prompt.
    expect(ctx).not.toContain("SECRET_N_MEMORY");
    expect(ctx).not.toContain("Full Objective World");
  });

  it("consequence context includes validation feedback on retry", () => {
    const world = makeTinyWorld();
    const ctx = buildConsequenceContext(world, { actorId: "u", text: "Hi" }, "bad output");
    expect(ctx).toContain("bad output");
  });
});
