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

  it("warns when command path is wrong-runtime even though args look configured", async () => {
    const checks = await runIdeCheck({
      ideStatuses: {
        cursor: {
          detected: true,
          configured: true,
          health: "configured",
          displayName: "Cursor",
          commandHealth: "wrong-runtime",
        },
      },
    });
    const cursorCheck = checks.find((c) => c.name === "cursor");
    expect(cursorCheck.status).toBe("warn");
    expect(cursorCheck.message).toContain("wrong-runtime");
    // The remediation must be the same Configure command the user already
    // knows from the dashboard.
    expect(cursorCheck.action.commandId).toBe("Perplexity.generateConfigs");
  });

  it("warns for missing/unresolved/unknown commandHealth values", async () => {
    const checks = await runIdeCheck({
      ideStatuses: {
        a: { detected: true, configured: true, health: "configured", displayName: "A", commandHealth: "missing" },
        b: { detected: true, configured: true, health: "configured", displayName: "B", commandHealth: "unresolved" },
        c: { detected: true, configured: true, health: "configured", displayName: "C", commandHealth: "unknown" },
      },
    });
    expect(checks.find((c) => c.name === "a").status).toBe("warn");
    expect(checks.find((c) => c.name === "b").status).toBe("warn");
    expect(checks.find((c) => c.name === "c").status).toBe("warn");
  });

  it("does not warn when commandHealth is 'ok'", async () => {
    const checks = await runIdeCheck({
      ideStatuses: {
        cursor: {
          detected: true,
          configured: true,
          health: "configured",
          displayName: "Cursor",
          commandHealth: "ok",
        },
      },
    });
    expect(checks.find((c) => c.name === "cursor").status).toBe("pass");
  });

  it("prioritizes stale-args warning over commandHealth warning", async () => {
    // A stale launcher path is more urgent than a bad-command path because the
    // IDE can't even spawn anything when args[0] doesn't exist. The formatter
    // must surface the stale message and skip the command-health check.
    const checks = await runIdeCheck({
      ideStatuses: {
        cursor: {
          detected: true,
          configured: true,
          health: "stale",
          displayName: "Cursor",
          commandHealth: "wrong-runtime",
        },
      },
    });
    const cursorCheck = checks.find((c) => c.name === "cursor");
    expect(cursorCheck.status).toBe("warn");
    expect(cursorCheck.message).toContain("stale");
    expect(cursorCheck.message).not.toContain("wrong-runtime");
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
