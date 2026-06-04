import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, liveDaemonOwnsProfile } from "../src/checks/probe.js";

let CFG;
let prevCfg;
let prevProfile;

beforeEach(() => {
  prevCfg = process.env.PERPLEXITY_CONFIG_DIR;
  prevProfile = process.env.PERPLEXITY_PROFILE;
  delete process.env.PERPLEXITY_PROFILE; // probe targets the active profile by default
  CFG = mkdtempSync(join(tmpdir(), "pplx-probe-"));
  process.env.PERPLEXITY_CONFIG_DIR = CFG;
});

afterEach(() => {
  if (prevCfg === undefined) delete process.env.PERPLEXITY_CONFIG_DIR;
  else process.env.PERPLEXITY_CONFIG_DIR = prevCfg;
  if (prevProfile === undefined) delete process.env.PERPLEXITY_PROFILE;
  else process.env.PERPLEXITY_PROFILE = prevProfile;
  rmSync(CFG, { recursive: true, force: true });
});

function writeDaemonLock(pid) {
  const rec = {
    pid,
    uuid: "test-uuid",
    port: 51234,
    bearerToken: "test-bearer",
    version: "0.0.0-test",
    startedAt: new Date(0).toISOString(),
  };
  writeFileSync(join(CFG, "daemon.lock"), JSON.stringify(rec));
}

describe("liveDaemonOwnsProfile", () => {
  it("returns true when a live daemon lockfile is present", () => {
    writeDaemonLock(process.pid); // our own process is alive
    expect(liveDaemonOwnsProfile()).toBe(true);
  });

  it("returns false when no daemon lockfile exists", () => {
    expect(liveDaemonOwnsProfile()).toBe(false);
  });

  it("returns false when the daemon lockfile is stale (dead pid)", () => {
    writeDaemonLock(2147483646); // pid that is not alive
    expect(liveDaemonOwnsProfile()).toBe(false);
  });

  it("returns false when the probe targets a different profile than the daemon-served active one", () => {
    writeDaemonLock(process.pid); // live daemon (serves the active profile)
    process.env.PERPLEXITY_PROFILE = "some-other-profile"; // probe targets a different browser-data dir
    expect(liveDaemonOwnsProfile()).toBe(false);
  });
});

describe("probe run() single-owner guard (issue #8)", () => {
  it("skips the competing launch when a live daemon owns the profile, without calling search", async () => {
    writeDaemonLock(process.pid);
    let called = false;
    const res = await run({
      probe: true,
      searchOverride: async () => {
        called = true;
        return { sources: [{ url: "x" }], elapsedMs: 1, authenticated: true };
      },
    });
    expect(called).toBe(false);
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe("probe-search");
    expect(res[0].status).toBe("skip");
    expect(res[0].message).toMatch(/daemon/i);
  });

  it("runs the probe normally when no daemon owns the profile", async () => {
    const res = await run({
      probe: true,
      searchOverride: async () => ({ sources: [{ url: "x" }], elapsedMs: 5, authenticated: true }),
    });
    expect(res[0].status).toBe("pass");
  });
});
