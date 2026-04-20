import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run as runRuntimeCheck } from "../../src/checks/runtime.js";

describe("checks/runtime", () => {
  it("passes on Node >= 20", async () => {
    const checks = await runRuntimeCheck({ nodeVersionOverride: "v20.11.0" });
    const node = checks.find((c) => c.name === "node-version");
    expect(node.status).toBe("pass");
    expect(node.message).toMatch(/20\./);
  });

  it("fails on Node < 20", async () => {
    const checks = await runRuntimeCheck({ nodeVersionOverride: "v18.19.0" });
    const node = checks.find((c) => c.name === "node-version");
    expect(node.status).toBe("fail");
    expect(node.hint).toMatch(/upgrade/i);
  });

  it("reports platform, arch, and package-version", async () => {
    const checks = await runRuntimeCheck({});
    expect(checks.find((c) => c.name === "platform").status).toBe("pass");
    expect(checks.find((c) => c.name === "arch").status).toBe("pass");
    expect(checks.find((c) => c.name === "package-version").status).toBe("pass");
  });

  it("resolves package version from a bundled baseDir when provided", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "px-runtime-"));
    mkdirSync(join(baseDir, "mcp"), { recursive: true });
    writeFileSync(
      join(baseDir, "mcp", "package.json"),
      JSON.stringify({ name: "perplexity-user-mcp", version: "9.9.9-test" }),
    );
    const checks = await runRuntimeCheck({ baseDir, gitDirOverride: "/does/not/exist", gitShaResolverOverride: async () => null });
    const version = checks.find((c) => c.name === "package-version");
    expect(version.message).toMatch(/9\.9\.9-test/);
  });

  it("skips git-sha when the override points at a missing dir", async () => {
    const checks = await runRuntimeCheck({ gitDirOverride: "/does/not/exist", gitShaResolverOverride: async () => null });
    const git = checks.find((c) => c.name === "git-sha");
    expect(git.status).toBe("skip");
  });
});
