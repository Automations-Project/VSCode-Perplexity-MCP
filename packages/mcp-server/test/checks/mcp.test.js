import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runMcpCheck } from "../../src/checks/mcp.js";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "px-mcp-")); });

describe("checks/mcp", () => {
  it("skips when tool-config absent", async () => {
    const checks = await runMcpCheck({ configDir: dir });
    expect(checks.find((c) => c.name === "tool-config").status).toBe("skip");
  });

  it("passes when tool-config is valid and profile known", async () => {
    writeFileSync(join(dir, "tools-config.json"), JSON.stringify({ profile: "read-only" }));
    const checks = await runMcpCheck({ configDir: dir });
    expect(checks.find((c) => c.name === "tool-config").status).toBe("pass");
    expect(checks.find((c) => c.name === "enabled-tools").status).toBe("pass");
  });

  it("fails when tool-config is malformed JSON", async () => {
    writeFileSync(join(dir, "tools-config.json"), "{ not-json");
    const checks = await runMcpCheck({ configDir: dir });
    expect(checks.find((c) => c.name === "tool-config").status).toBe("fail");
  });
});
