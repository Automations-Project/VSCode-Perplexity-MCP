import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runConfigCheck } from "../../src/checks/config.js";

let dir;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "px-cfg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("checks/config", () => {
  it("fails when config dir does not exist", async () => {
    const checks = await runConfigCheck({ configDir: join(dir, "absent") });
    const d = checks.find((c) => c.name === "config-dir");
    expect(d.status).toBe("fail");
  });

  it("passes when config dir is present and active points to a real profile", async () => {
    mkdirSync(join(dir, "profiles", "default"), { recursive: true });
    writeFileSync(join(dir, "profiles", "default", "meta.json"), JSON.stringify({ name: "default" }));
    writeFileSync(join(dir, "active"), "default\n");
    const checks = await runConfigCheck({ configDir: dir });
    expect(checks.find((c) => c.name === "config-dir").status).toBe("pass");
    expect(checks.find((c) => c.name === "active-pointer").status).toBe("pass");
  });

  it("fails when active points to a missing profile", async () => {
    writeFileSync(join(dir, "active"), "ghost\n");
    const checks = await runConfigCheck({ configDir: dir });
    expect(checks.find((c) => c.name === "active-pointer").status).toBe("fail");
  });

  it("skips config.json when absent (optional)", async () => {
    const checks = await runConfigCheck({ configDir: dir });
    expect(checks.find((c) => c.name === "config-json").status).toBe("skip");
  });

  it("warns when config.json is present but malformed", async () => {
    writeFileSync(join(dir, "config.json"), "{ not-json");
    const checks = await runConfigCheck({ configDir: dir });
    expect(checks.find((c) => c.name === "config-json").status).toBe("warn");
  });
});
