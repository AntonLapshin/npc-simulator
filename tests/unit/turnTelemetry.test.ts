// Phase 6: ProviderCallCounter — only provider-backed engines count.

import { describe, expect, it } from "vitest";
import { ProviderCallCounter } from "../../src/engine/turnTelemetry.js";

describe("ProviderCallCounter", () => {
  it("starts at zero", () => {
    const c = new ProviderCallCounter();
    expect(c.total()).toBe(0);
    expect(c.breakdown()).toEqual({ proposal: 0, selection: 0, render: 0 });
  });

  it("counts provider-backed invocations per stage", () => {
    const c = new ProviderCallCounter();
    const llm = { providerBacked: true };
    c.note("proposal", llm);
    c.note("selection", llm);
    c.note("render", llm);
    c.note("render", llm);
    expect(c.breakdown()).toEqual({ proposal: 1, selection: 1, render: 2 });
    expect(c.total()).toBe(4);
  });

  it("ignores local engines and undefined", () => {
    const c = new ProviderCallCounter();
    c.note("proposal", { providerBacked: false });
    c.note("selection", {});
    c.note("render", undefined);
    expect(c.total()).toBe(0);
  });

  it("breakdown returns a copy", () => {
    const c = new ProviderCallCounter();
    c.note("render", { providerBacked: true });
    const b = c.breakdown();
    b.render = 99;
    expect(c.breakdown().render).toBe(1);
  });
});
