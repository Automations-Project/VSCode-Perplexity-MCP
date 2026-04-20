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

  it("detects impit from the runtime package even when only the package exists", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "px-impit-"));
    process.env.PERPLEXITY_CONFIG_DIR = dir;
    try {
      const pkgDir = join(dir, "native-deps", "node_modules", "impit");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "impit", version: "0.13.0" }));
      const checks = await runNativeDepsCheck({});
      const impit = checks.find((c) => c.name === "impit");
      expect(impit.status).toBe("pass");
      expect(impit.message).toMatch(/0.13.0/);
    } finally {
      delete process.env.PERPLEXITY_CONFIG_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checks/native-deps — baseDir resolution (Phase 3.1 fix)", () => {
  it("uses baseDir for patchright + chain resolution when provided", async () => {
    // Point baseDir at the repo root — it has all deps hoisted in node_modules.
    const repoRoot = process.cwd();
    const checks = await runNativeDepsCheck({ baseDir: repoRoot });
    expect(checks.find((c) => c.name === "patchright").status).toBe("pass");
    expect(checks.find((c) => c.name === "got-scraping-chain").status).toBe("pass");
  });

  it("fails patchright when baseDir has no node_modules/patchright", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const empty = mkdtempSync(join(tmpdir(), "px-empty-"));
    const checks = await runNativeDepsCheck({ baseDir: empty });
    expect(checks.find((c) => c.name === "patchright").status).toBe("fail");
  });
});
