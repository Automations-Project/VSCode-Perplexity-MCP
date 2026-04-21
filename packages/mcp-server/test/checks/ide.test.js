import { describe, it, expect, vi } from "vitest";
import { run as runIdeCheck } from "../../src/checks/ide.js";

describe("checks/ide", () => {
  it("uses injected ideStatuses when provided", async () => {
    const checks = await runIdeCheck({
      ideStatuses: {
        cursor: { detected: true, configured: true, health: "configured", displayName: "Cursor" },
        codexCli: { detected: false, configured: false, health: "missing", displayName: "Codex CLI" },
      },
    });
    expect(checks.find((c) => c.name === "cursor").status).toBe("pass");
    expect(checks.find((c) => c.name === "codexCli").status).toBe("skip");
  });

  it("warns on detected-but-not-configured IDE", async () => {
    const checks = await runIdeCheck({
      ideStatuses: {
        cursor: { detected: true, configured: false, health: "missing", displayName: "Cursor" },
      },
    });
    expect(checks.find((c) => c.name === "cursor").status).toBe("warn");
  });

  it("skips when no ideStatuses injected (CLI-only)", async () => {
    const checks = await runIdeCheck({});
    expect(checks.find((c) => c.name === "ide-audit").status).toBe("skip");
  });

  it("adds an mdViewers detail check without failing when none are detected", async () => {
    vi.resetModules();
    vi.doMock("../../src/viewer-detect.js", () => ({
      detectAllViewers: async () => ({ obsidian: false, typora: false, logseq: false }),
    }));

    const { run: runWithMock } = await import("../../src/checks/ide.js");
    const checks = await runWithMock({
      ideStatuses: {
        cursor: { detected: true, configured: true, health: "configured", displayName: "Cursor" },
      },
    });
    const mdViewers = checks.find((c) => c.name === "mdViewers");
    expect(mdViewers.status).toBe("pass");
    expect(mdViewers.detail.viewers).toEqual({ obsidian: false, typora: false, logseq: false });
    vi.doUnmock("../../src/viewer-detect.js");
  });
});
