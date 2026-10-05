import { describe, expect, it } from "vitest";
import {
  parseCommand,
  renderScenePanel,
  renderActorPanel,
  renderSuggestions,
  renderHistory,
  formatLogEntry,
} from "../../src/ui/text/commands.js";
import { handleLine, TextSession } from "../../src/ui/text/textUi.js";
import { createTestLogger } from "../../src/logging/logger.js";
import { makeTestDeps, makeTinyWorld, loadOfficeScenario } from "../helpers.js";

function makeSession() {
  const logger = createTestLogger("textui");
  const deps = makeTestDeps(logger);
  const session = new TextSession(logger, deps, false, true);
  session.world = makeTinyWorld();
  return { session, logger };
}

describe("text UI command parsing (§17.2)", () => {
  it("parses every documented command", () => {
    expect(parseCommand("start scenarios/office.json")).toEqual({ kind: "start", path: "scenarios/office.json" });
    expect(parseCommand("start")).toEqual({ kind: "start", path: undefined });
    expect(parseCommand("next")).toEqual({ kind: "next" });
    expect(parseCommand("look")).toEqual({ kind: "look" });
    expect(parseCommand("look actor ana")).toEqual({ kind: "lookActor", actorId: "ana" });
    expect(parseCommand("look object door")).toEqual({ kind: "lookObject", objectId: "door" });
    expect(parseCommand("memories ana")).toEqual({ kind: "memories", actorId: "ana" });
    expect(parseCommand("beliefs")).toEqual({ kind: "beliefs", actorId: undefined });
    expect(parseCommand("relationships ana")).toEqual({ kind: "relationships", actorId: "ana" });
    expect(parseCommand("history")).toEqual({ kind: "history", limit: undefined });
    expect(parseCommand("history 5")).toEqual({ kind: "history", limit: 5 });
    expect(parseCommand("save out.json")).toEqual({ kind: "save", path: "out.json" });
    expect(parseCommand("load out.json")).toEqual({ kind: "load", path: "out.json" });
    expect(parseCommand("log tail 3")).toEqual({ kind: "logTail", limit: 3 });
    expect(parseCommand("log module turn")).toEqual({ kind: "logModule", module: "turn", limit: undefined });
    expect(parseCommand("log tick 2")).toEqual({ kind: "logTick", tick: 2, limit: undefined });
    expect(parseCommand("debug on")).toEqual({ kind: "debug", on: true });
    expect(parseCommand("debug off")).toEqual({ kind: "debug", on: false });
    expect(parseCommand("help")).toEqual({ kind: "help" });
    expect(parseCommand("quit")).toEqual({ kind: "quit" });
  });

  it("accepts free-form actions without filtering", () => {
    const cmd = parseCommand("action: Walk to Ana and ask where your desk is.");
    expect(cmd).toEqual({ kind: "action", text: "Walk to Ana and ask where your desk is." });
    // Colon is optional; any text is accepted verbatim.
    expect(parseCommand("action Say nothing and wait.")).toEqual({ kind: "action", text: "Say nothing and wait." });
  });

  it("rejects malformed input with usage hints", () => {
    expect(parseCommand("")).toMatchObject({ kind: "error" });
    expect(parseCommand("load")).toMatchObject({ kind: "error" });
    expect(parseCommand("bogus")).toMatchObject({ kind: "error" });
    expect(parseCommand("history xyz")).toMatchObject({ kind: "error" });
  });
});

describe("text UI panels (§17.1)", () => {
  it("scene panel defaults to subjective view, debug shows objective world", () => {
    const world = makeTinyWorld();
    const subjective = renderScenePanel(world, { viewerId: "u", debug: false });
    expect(subjective).toContain("Tiny");
    expect(subjective).toContain("subjective view");
    const objective = renderScenePanel(world, { debug: true });
    expect(objective).toContain("objective world");
    expect(objective).toContain("U (u)");
  });

  it("actor panel shows state/emotion/goal/lists", () => {
    const world = makeTinyWorld();
    const panel = renderActorPanel(world.actors[0]!);
    expect(panel).toContain("standing");
    expect(panel).toContain("calm");
    expect(panel).toContain("Explore.");
  });

  it("suggestions render numbered; history renders tail", () => {
    expect(renderSuggestions(["Stay.", "Look."])).toContain("[1] Stay.");
    const world = { ...makeTinyWorld(), history: ["a", "b", "c"] };
    expect(renderHistory(world, 2)).toContain("b");
    expect(renderHistory(makeTinyWorld())).toContain("no history");
  });

  it("log formatting hides traces unless debug is on", () => {
    const entry = {
      id: "log_1", sessionId: "s", timestamp: new Date().toISOString(),
      tick: 1, turnIndex: 0, module: "proposal", event: "proposal_completed",
      actorId: "u", prompt: "secret-prompt", rawResponse: '{"a":1}', reasoning: "why",
    };
    expect(formatLogEntry(entry, false)).toContain("proposal/proposal_completed");
    expect(formatLogEntry(entry, false)).not.toContain("secret-prompt");
    expect(formatLogEntry(entry, true)).toContain("why");
  });
});

describe("text UI session flow", () => {
  const ask = async () => "1";

  it("look/history/memories work on a loaded world", async () => {
    const { session } = makeSession();
    expect((await handleLine("look", session, ask)).output).toContain("Tiny");
    expect((await handleLine("history", session, ask)).output).toContain("no history");
    expect((await handleLine("memories u", session, ask)).output).toContain("memories");
    expect((await handleLine("help", session, ask)).output).toContain("action:");
  });

  it("next advances the turn and logs it", async () => {
    const { session, logger } = makeSession();
    const res = await handleLine("next", session, ask);
    expect(session.world!.tick).toBe(1);
    expect(res.output).toContain("acted");
    expect(logger.store.byEvent("turn_completed")).toHaveLength(1);
  });

  it("action: submits a free-form user action verbatim", async () => {
    const { session } = makeSession();
    const text = "Walk to N and say hello, newcomer style!";
    const res = await handleLine(`action: ${text}`, session, ask);
    expect(res.output).toContain(text);
    expect(session.world!.history[0]).toContain(text);
  });

  it("action: on an NPC turn refuses instead of mutating", async () => {
    const { session } = makeSession();
    await handleLine("next", session, ask); // user turn done; now NPC's turn
    const res = await handleLine("action: hello", session, ask);
    expect(res.output).toContain("Not your turn");
  });

  it("debug toggles the view", async () => {
    const { session } = makeSession();
    await handleLine("debug on", session, ask);
    expect(session.debug).toBe(true);
    const out = (await handleLine("look", session, ask)).output;
    expect(out).toContain("objective world");
  });

  it("runs the office scenario end to end with mocks", async () => {
    const logger = createTestLogger("office-text");
    const session = new TextSession(logger, makeTestDeps(logger), false, true);
    session.world = loadOfficeScenario();
    const res = await handleLine("action: Hey guys, I'm a new team member, my name is Jeff!", session, ask);
    expect(res.output).toContain("Jeff");
    expect(session.world!.tick).toBe(1);
  });
});
