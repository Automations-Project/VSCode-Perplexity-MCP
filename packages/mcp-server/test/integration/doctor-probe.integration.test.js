import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { start as startMock } from "./mock-server.js";

let mock;
beforeAll(async () => { mock = await startMock({ port: 0 }); });
afterAll(async () => { await mock.close(); });

describe("doctor probe integration", () => {
  it("returns pass + latency + sourceCount on the mock", async () => {
    const { run } = await import("../../src/checks/probe.js");
    const checks = await run({
      probe: true,
      searchOverride: async () => ({ sources: [{ url: `${mock.url}/x` }, { url: `${mock.url}/y` }], elapsedMs: 187 }),
    });
    expect(checks[0].status).toBe("pass");
    expect(checks[0].detail.latencyMs).toBe(187);
    expect(checks[0].detail.sourceCount).toBe(2);
  });

  it("honors a tight timeout budget", async () => {
    const { run } = await import("../../src/checks/probe.js");
    const checks = await run({
      probe: true,
      timeoutMs: 20,
      searchOverride: async ({ timeoutMs }) => {
        await new Promise((r) => setTimeout(r, timeoutMs + 5));
        throw new Error("aborted");
      },
    });
    expect(checks[0].status).toBe("fail");
  });
});
