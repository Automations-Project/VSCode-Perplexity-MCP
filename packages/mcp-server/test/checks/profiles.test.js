import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runProfilesCheck } from "../../src/checks/profiles.js";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "px-prof-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seedProfile(name, { meta = true, vault = "enc", cacheDaysAgo = 0 } = {}) {
  const p = join(dir, "profiles", name);
  mkdirSync(p, { recursive: true });
  if (meta) writeFileSync(join(p, "meta.json"), JSON.stringify({ name, loginMode: "manual" }));
  if (vault === "enc") writeFileSync(join(p, "vault.enc"), Buffer.alloc(64));
  if (vault === "plain") writeFileSync(join(p, "vault.json"), "{}");
  const cache = join(p, "models-cache.json");
  writeFileSync(cache, "{}");
  if (cacheDaysAgo > 0) {
    const past = new Date(Date.now() - cacheDaysAgo * 24 * 3600 * 1000);
    utimesSync(cache, past, past);
  }
}

describe("checks/profiles", () => {
  it("warns when no profiles exist", async () => {
    mkdirSync(join(dir, "profiles"), { recursive: true });
    const checks = await runProfilesCheck({ configDir: dir });
    expect(checks.find((c) => c.name === "profile-count").status).toBe("warn");
  });

  it("passes a fresh encrypted profile", async () => {
    seedProfile("work");
    const checks = await runProfilesCheck({ configDir: dir, profile: "work" });
    expect(checks.find((c) => c.name === "work/meta").status).toBe("pass");
    expect(checks.find((c) => c.name === "work/vault").status).toBe("pass");
  });

  it("warns on vault.json opt-out", async () => {
    seedProfile("work", { vault: "plain" });
    const checks = await runProfilesCheck({ configDir: dir, profile: "work" });
    const v = checks.find((c) => c.name === "work/vault");
    expect(v.status).toBe("warn");
    expect(v.message).toMatch(/plaintext/i);
  });

  it("warns on stale models-cache", async () => {
    seedProfile("work", { cacheDaysAgo: 10 });
    const checks = await runProfilesCheck({ configDir: dir, profile: "work" });
    expect(checks.find((c) => c.name === "work/models-cache").status).toBe("warn");
  });

  it("fails on corrupt meta.json", async () => {
    mkdirSync(join(dir, "profiles", "bad"), { recursive: true });
    writeFileSync(join(dir, "profiles", "bad", "meta.json"), "not-json");
    const checks = await runProfilesCheck({ configDir: dir, profile: "bad" });
    expect(checks.find((c) => c.name === "bad/meta").status).toBe("fail");
  });
});
