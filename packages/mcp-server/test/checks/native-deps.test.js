import { describe, it, expect } from "vitest";
import { run as runNativeDepsCheck } from "../../src/checks/native-deps.js";

describe("checks/native-deps", () => {
  it("passes when patchright and got-scraping chain both resolve", async () => {
    const checks = await runNativeDepsCheck({});
    expect(checks.find((c) => c.name === "patchright").status).toBe("pass");
    expect(checks.find((c) => c.name === "got-scraping-chain").status).toBe("pass");
  });

  it("warns when the got-scraping chain is broken (carry-over #5 regression guard)", async () => {
    const checks = await runNativeDepsCheck({
      resolveChainOverride: () => { throw new Error("Cannot find module 'is-obj'"); },
    });
    const chain = checks.find((c) => c.name === "got-scraping-chain");
    expect(chain.status).toBe("warn");
    expect(chain.detail?.chainError).toMatch(/is-obj/);
    expect(chain.hint).toMatch(/prepare-package-deps/);
  });

  it("reports impit install state", async () => {
    const checks = await runNativeDepsCheck({
      impitStatusOverride: { installed: true, version: "1.2.3" },
    });
    expect(checks.find((c) => c.name === "impit").status).toBe("pass");
  });

  it("skips impit when not installed (optional speed boost)", async () => {
    const checks = await runNativeDepsCheck({
      impitStatusOverride: { installed: false, version: null },
    });
    expect(checks.find((c) => c.name === "impit").status).toBe("skip");
  });
});
