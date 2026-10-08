import { describe, expect, it, vi } from "vitest";
import { LayaClient, LayaUnavailableError } from "../../../src/decision/layaClient.js";

const QUESTIONS = {
  ping: { type: "noul" as const, instructions: "Is this a ping?" },
};

const okBody = {
  answers: { ping: { type: "noul", noul: 0.9 } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("LayaClient", () => {
  it("POSTs to {baseUrl}/v1/systemone and returns normalized answers", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse(okBody),
    );
    const client = new LayaClient({ baseUrl: "http://127.0.0.1:8000/", fetchImpl });
    const answers = await client.decide("state", QUESTIONS);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8000/v1/systemone");
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(init?.body as string);
    expect(sent.state).toEqual({ document: "state" });
    expect(answers["ping"]).toEqual({ type: "noul", pTrue: 0.9 });
  });

  it("throws LayaUnavailableError on non-2xx", async () => {
    const client = new LayaClient({
      baseUrl: "http://x",
      fetchImpl: (async () => jsonResponse({}, 500)) as typeof fetch,
    });
    await expect(client.decide("s", QUESTIONS)).rejects.toThrow(LayaUnavailableError);
  });

  it("throws LayaUnavailableError on network failure", async () => {
    const client = new LayaClient({
      baseUrl: "http://x",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    await expect(client.decide("s", QUESTIONS)).rejects.toThrow(LayaUnavailableError);
  });

  it("throws LayaUnavailableError on a malformed body", async () => {
    const client = new LayaClient({
      baseUrl: "http://x",
      fetchImpl: (async () => jsonResponse({ answers: {} })) as typeof fetch,
    });
    await expect(client.decide("s", QUESTIONS)).rejects.toThrow(LayaUnavailableError);
  });

  it("throws LayaUnavailableError when the request aborts", async () => {
    const client = new LayaClient({
      baseUrl: "http://x",
      timeoutMs: 5,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        // Honor the abort signal like a real fetch would.
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => resolve(), 5000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        return jsonResponse(okBody);
      }) as typeof fetch,
    });
    await expect(client.decide("s", QUESTIONS)).rejects.toThrow(LayaUnavailableError);
  });
});
