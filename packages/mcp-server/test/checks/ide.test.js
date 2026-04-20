import { describe, it, expect } from "vitest";
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
});
