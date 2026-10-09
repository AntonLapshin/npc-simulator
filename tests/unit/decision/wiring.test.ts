// PLAN_V2 Phase 6: Laya survives only as the semantic parser plus the
// locomotion veto — the wiring tests cover the slimmed config surface.
import { describe, expect, it } from "vitest";
import {
  createLayaClient,
  createLayaSemanticJudge,
  isLayaAvailable,
  readLayaConfig,
} from "../../../src/decision/wiring.js";
import { LayaClient } from "../../../src/decision/layaClient.js";
import { LayaSemanticJudge } from "../../../src/decision/layaSemanticJudge.js";

describe("readLayaConfig", () => {
  it("returns documented defaults on an empty env", () => {
    const cfg = readLayaConfig({});
    expect(cfg).toEqual({
      url: "http://127.0.0.1:8000",
      mode: "on",
      timeoutMs: 5000,
      toggles: {
        locomotion: true,
      },
    });
  });

  it("parses overrides", () => {
    const cfg = readLayaConfig({
      LAYA_URL: "http://laya:9000",
      LAYA_MODE: "off",
      LAYA_TIMEOUT_MS: "2000",
      LAYA_LOCOMOTION: "0",
    });
    expect(cfg.url).toBe("http://laya:9000");
    expect(cfg.mode).toBe("off");
    expect(cfg.timeoutMs).toBe(2000);
    expect(cfg.toggles.locomotion).toBe(false);
  });

  it("treats legacy mode values as on", () => {
    expect(readLayaConfig({ LAYA_MODE: "static" }).mode).toBe("on");
    expect(readLayaConfig({ LAYA_MODE: "dynamic" }).mode).toBe("on");
  });

  it("falls back to safe values on garbage input", () => {
    const cfg = readLayaConfig({
      LAYA_MODE: "turbo",
      LAYA_TIMEOUT_MS: "-5",
      LAYA_LOCOMOTION: "maybe",
    });
    expect(cfg.mode).toBe("on");
    expect(cfg.timeoutMs).toBe(5000);
    expect(cfg.toggles.locomotion).toBe(true);
  });

  it("accepts off mode", () => {
    expect(readLayaConfig({ LAYA_MODE: "off" }).mode).toBe("off");
  });
});

describe("factories", () => {
  it("createLayaClient builds a client for the configured url", () => {
    const cfg = readLayaConfig({ LAYA_URL: "http://example:1234" });
    const client = createLayaClient(cfg);
    expect(client).toBeInstanceOf(LayaClient);
    expect(client.url).toBe("http://example:1234");
  });

  it("createLayaSemanticJudge builds a judge", () => {
    const cfg = readLayaConfig({});
    const judge = createLayaSemanticJudge({ client: createLayaClient(cfg) });
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
