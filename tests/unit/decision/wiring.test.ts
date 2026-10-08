import { describe, expect, it } from "vitest";
import {
  createLayaClient,
  createLayaSelectionEngine,
  createLayaSemanticJudge,
  isLayaAvailable,
  readLayaConfig,
} from "../../../src/decision/wiring.js";
import { LayaClient } from "../../../src/decision/layaClient.js";
import { LayaSelectionEngine } from "../../../src/decision/layaSelectionEngine.js";
import { LayaSemanticJudge } from "../../../src/decision/layaSemanticJudge.js";
import type { SelectionEngine } from "../../../src/intelligence/types.js";

describe("readLayaConfig", () => {
  it("returns documented defaults on an empty env", () => {
    const cfg = readLayaConfig({});
    expect(cfg).toEqual({
      url: "http://127.0.0.1:8000",
      mode: "static",
      confidenceThreshold: 0.55,
      timeoutMs: 5000,
      maxOptions: 12,
      toggles: {
        selection: true,
        judge: true,
        triage: true,
        salience: true,
        planner: false,
        // Exp-2-E additions: OFF by default.
        salvageSelect: false,
        locomotion: false,
      },
    });
  });

  it("parses overrides", () => {
    const cfg = readLayaConfig({
      LAYA_URL: "http://laya:9000",
      LAYA_MODE: "dynamic",
      LAYA_CONFIDENCE_THRESHOLD: "0.7",
      LAYA_TIMEOUT_MS: "2000",
      LAYA_MAX_OPTIONS: "8",
      LAYA_SELECTION: "0",
      LAYA_JUDGE: "false",
      LAYA_PLANNER: "1",
    });
    expect(cfg.url).toBe("http://laya:9000");
    expect(cfg.mode).toBe("dynamic");
    expect(cfg.confidenceThreshold).toBe(0.7);
    expect(cfg.timeoutMs).toBe(2000);
    expect(cfg.maxOptions).toBe(8);
    expect(cfg.toggles.selection).toBe(false);
    expect(cfg.toggles.judge).toBe(false);
    expect(cfg.toggles.planner).toBe(true);
    expect(cfg.toggles.triage).toBe(true);
  });

  it("parses the Exp-2-E toggles (off by default)", () => {
    const off = readLayaConfig({});
    expect(off.toggles.salvageSelect).toBe(false);
    expect(off.toggles.locomotion).toBe(false);
    const on = readLayaConfig({
      LAYA_SALVAGE_SELECT: "1",
      LAYA_LOCOMOTION: "yes",
    });
    expect(on.toggles.salvageSelect).toBe(true);
    expect(on.toggles.locomotion).toBe(true);
  });

  it("falls back to safe values on garbage input", () => {
    const cfg = readLayaConfig({
      LAYA_MODE: "turbo",
      LAYA_CONFIDENCE_THRESHOLD: "banana",
      LAYA_TIMEOUT_MS: "-5",
      LAYA_SELECTION: "maybe",
    });
    expect(cfg.mode).toBe("static");
    expect(cfg.confidenceThreshold).toBe(0.55);
    expect(cfg.timeoutMs).toBe(5000);
    expect(cfg.toggles.selection).toBe(true);
  });

  it("accepts off mode", () => {
    expect(readLayaConfig({ LAYA_MODE: "off" }).mode).toBe("off");
  });
});

describe("factories", () => {
  const stubFallback: SelectionEngine = {
    select: async () => ({ action: "fallback", reasoning: "stub" }),
  };

  it("createLayaClient builds a client for the configured url", () => {
    const cfg = readLayaConfig({ LAYA_URL: "http://example:1234" });
    const client = createLayaClient(cfg);
    expect(client).toBeInstanceOf(LayaClient);
    expect(client.url).toBe("http://example:1234");
  });

  it("createLayaSelectionEngine wires client + fallback", () => {
    const cfg = readLayaConfig({});
    const engine = createLayaSelectionEngine({ client: createLayaClient(cfg) }, cfg, stubFallback);
    expect(engine).toBeInstanceOf(LayaSelectionEngine);
  });

  it("createLayaSemanticJudge builds a judge", () => {
    const cfg = readLayaConfig({});
    const judge = createLayaSemanticJudge({ client: createLayaClient(cfg) }, cfg);
    expect(judge).toBeInstanceOf(LayaSemanticJudge);
  });
});

describe("isLayaAvailable", () => {
  it("returns true on a sane probe answer", async () => {
    const client = new LayaClient({
      baseUrl: "http://x",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ answers: { probe: { type: "noul", noul: 0.5 } } }), {
          status: 200,
        })) as typeof fetch,
    });
    await expect(isLayaAvailable(client)).resolves.toBe(true);
  });

  it("returns false when the server is down (never throws)", async () => {
    const client = new LayaClient({
      baseUrl: "http://x",
      fetchImpl: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    await expect(isLayaAvailable(client)).resolves.toBe(false);
  });

  it("returns false on a malformed probe answer", async () => {
    const client = new LayaClient({
      baseUrl: "http://x",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ answers: {} }), { status: 200 })) as typeof fetch,
    });
    await expect(isLayaAvailable(client)).resolves.toBe(false);
  });

  it("returns false on a non-2xx probe response", async () => {
    const client = new LayaClient({
      baseUrl: "http://x",
      fetchImpl: (async () => new Response("oops", { status: 503 })) as typeof fetch,
    });
    await expect(isLayaAvailable(client)).resolves.toBe(false);
  });
});
