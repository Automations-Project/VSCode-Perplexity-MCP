import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonAuthStatus } from "@perplexity-user-mcp/shared";
import { readLiveDaemonStatus } from "../src/auth/session.js";

// A daemon that exited leaves daemon-status.json behind with
// authenticated:false. Without a liveness check the dashboard renders
// "Daemon sees an anonymous session — run login to connect." forever, and no
// amount of logging in clears it (issue #10 follow-ups).
describe("readLiveDaemonStatus (stale daemon-status)", () => {
  let dir: string;
  let file: string;

  const ANONYMOUS: DaemonAuthStatus = {
    authenticated: false,
    tier: "Anonymous",
    userId: null,
    pid: process.pid,
    lastInit: new Date(0).toISOString(),
    initDurationMs: 1,
    error: null,
    reason: "not-logged-in",
  };

  const write = (status: unknown) => writeFileSync(file, JSON.stringify(status));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pplx-daemon-status-"));
    file = join(dir, "daemon-status.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null when the file does not exist", () => {
    expect(readLiveDaemonStatus(join(dir, "nope.json"))).toBeNull();
  });

  it("returns the status when the writing daemon is still alive", () => {
    write(ANONYMOUS);
    expect(readLiveDaemonStatus(file)?.reason).toBe("not-logged-in");
  });

  it("returns null when the writing daemon is gone", () => {
    // 0x7FFFFFFF is above every platform's pid ceiling, so it cannot be live.
    write({ ...ANONYMOUS, pid: 0x7fffffff });
    expect(readLiveDaemonStatus(file)).toBeNull();
  });

  it("does not suppress a live daemon's authenticated status", () => {
    write({ ...ANONYMOUS, authenticated: true, tier: "Pro", reason: "ok" });
    expect(readLiveDaemonStatus(file)?.tier).toBe("Pro");
  });

  it("trusts a pre-pid (legacy) daemon status rather than dropping it", () => {
    const { pid: _dropped, ...legacy } = ANONYMOUS;
    write(legacy);
    expect(readLiveDaemonStatus(file)).not.toBeNull();
  });

  it("returns null on malformed JSON", () => {
    writeFileSync(file, "{ not json");
    expect(readLiveDaemonStatus(file)).toBeNull();
  });
});
