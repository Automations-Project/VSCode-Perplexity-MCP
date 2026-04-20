import { describe, it, expect } from "vitest";
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

  it("skips git-sha when the override points at a missing dir", async () => {
    const checks = await runRuntimeCheck({ gitDirOverride: "/does/not/exist", gitShaResolverOverride: async () => null });
    const git = checks.find((c) => c.name === "git-sha");
    expect(git.status).toBe("skip");
  });
});
