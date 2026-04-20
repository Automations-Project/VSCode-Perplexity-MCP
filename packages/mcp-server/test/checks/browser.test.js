import { describe, it, expect, vi, beforeEach } from "vitest";
import { run as runBrowserCheck } from "../../src/checks/browser.js";

beforeEach(() => vi.resetModules());

describe("checks/browser", () => {
  it("fails when no Chrome-family binary is detected", async () => {
    const checks = await runBrowserCheck({ findChromeOverride: () => null });
    expect(checks.find((c) => c.name === "chrome-family").status).toBe("fail");
  });

  it("passes when Chrome is detected with a version", async () => {
    const checks = await runBrowserCheck({
      findChromeOverride: () => "/usr/bin/google-chrome",
      versionProbeOverride: async () => "Google Chrome 130.0.6723.91",
    });
    const c = checks.find((c) => c.name === "chrome-family");
    expect(c.status).toBe("pass");
    expect(c.message).toMatch(/130\./);
  });

  it("warns when the version probe fails", async () => {
    const checks = await runBrowserCheck({
      findChromeOverride: () => "/opt/google/chrome",
      versionProbeOverride: async () => { throw new Error("EPERM"); },
    });
    expect(checks.find((c) => c.name === "chrome-version").status).toBe("warn");
  });
});
