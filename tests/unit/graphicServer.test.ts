import { describe, expect, it } from "vitest";
import { isAuthorized, resolveApiToken, resolveBindHost } from "../../src/ui/graphic/server.js";

describe("graphic server bind host (F30)", () => {
  it("defaults to loopback", () => {
    expect(resolveBindHost({})).toBe("127.0.0.1");
    expect(resolveBindHost({ HOST: "" })).toBe("127.0.0.1");
    expect(resolveBindHost({ HOST: "   " })).toBe("127.0.0.1");
  });

  it("HOST overrides the bind address", () => {
    expect(resolveBindHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveBindHost({ HOST: " 192.168.1.5 " })).toBe("192.168.1.5");
  });
});

describe("graphic server API token auth (F30)", () => {
  it("no token configured means no auth", () => {
    expect(resolveApiToken({})).toBeUndefined();
    expect(resolveApiToken({ NPC_API_TOKEN: "" })).toBeUndefined();
    expect(resolveApiToken({ NPC_API_TOKEN: "   " })).toBeUndefined();
  });

  it("reads and trims the configured token", () => {
    expect(resolveApiToken({ NPC_API_TOKEN: " secret " })).toBe("secret");
  });

  it("allows everything when no token is configured", () => {
    expect(isAuthorized({}, undefined)).toBe(true);
    expect(isAuthorized({ "x-api-token": "anything" }, undefined)).toBe(true);
  });

  it("accepts the x-api-token header", () => {
    expect(isAuthorized({ "x-api-token": "secret" }, "secret")).toBe(true);
    expect(isAuthorized({ "x-api-token": "wrong" }, "secret")).toBe(false);
    expect(isAuthorized({}, "secret")).toBe(false);
  });

  it("accepts Authorization: Bearer <token>", () => {
    expect(isAuthorized({ authorization: "Bearer secret" }, "secret")).toBe(true);
    expect(isAuthorized({ authorization: "bearer secret" }, "secret")).toBe(true);
    expect(isAuthorized({ authorization: "Bearer wrong" }, "secret")).toBe(false);
    expect(isAuthorized({ authorization: "Token secret" }, "secret")).toBe(false);
  });

  it("compares in constant time (length mismatch fails, no throw)", () => {
    expect(isAuthorized({ "x-api-token": "short" }, "a-much-longer-secret")).toBe(false);
  });
});
