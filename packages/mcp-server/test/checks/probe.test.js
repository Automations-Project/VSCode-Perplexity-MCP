import { describe, it, expect } from "vitest";
import { run as runProbe } from "../../src/checks/probe.js";

describe("checks/probe", () => {
  it("skips when probe:false", async () => {
    const checks = await runProbe({ probe: false });
    expect(checks.find((c) => c.name === "probe-search").status).toBe("skip");
  });

  it("passes with injected search stub returning sources", async () => {
    const checks = await runProbe({
      probe: true,
      searchOverride: async () => ({ sources: [{ url: "https://example" }], elapsedMs: 42 }),
    });
    const c = checks.find((c) => c.name === "probe-search");
    expect(c.status).toBe("pass");
    expect(c.detail.latencyMs).toBe(42);
    expect(c.detail.sourceCount).toBe(1);
  });

  it("fails when search returns no sources", async () => {
    const checks = await runProbe({
      probe: true,
      searchOverride: async () => ({ sources: [], elapsedMs: 500 }),
    });
    expect(checks.find((c) => c.name === "probe-search").status).toBe("fail");
  });

  it("warns when an authenticated probe completes but returns no sources", async () => {
    const checks = await runProbe({
      probe: true,
      searchOverride: async () => ({
        authenticated: true,
        answer: "Paris is the capital of France.",
        sources: [],
        elapsedMs: 500,
        threadUrl: "https://www.perplexity.ai/search/example",
      }),
    });
    expect(checks.find((c) => c.name === "probe-search").status).toBe("warn");
  });

  it("fails when search throws (network / auth)", async () => {
    const checks = await runProbe({
      probe: true,
      searchOverride: async () => { throw new Error("403"); },
    });
    expect(checks.find((c) => c.name === "probe-search").status).toBe("fail");
  });
});
