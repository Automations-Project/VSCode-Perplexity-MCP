import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, getLockfilePath, isStale, read, release } from "../../src/daemon/lockfile.ts";

function makeRecord(overrides = {}) {
  return {
    pid: process.pid,
    uuid: "daemon-uuid",
    port: 43111,
    bearerToken: "token-1",
    version: "0.6.0-test",
    startedAt: "2026-04-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("daemon lockfile", () => {
  let configDir;
  let lockPath;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-daemon-lock-"));
    lockPath = getLockfilePath(configDir);
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("allows one winner across 10 parallel acquire attempts", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, index) => Promise.resolve(
        acquire(makeRecord({ uuid: `daemon-${index}`, port: 43111 + index, bearerToken: `token-${index}` }), { lockPath })
      ))
    );

    expect(attempts.filter(Boolean)).toHaveLength(1);
    const winnerIndex = attempts.findIndex(Boolean);
    const record = read({ lockPath });
    expect(record).not.toBeNull();
    expect(record.uuid).toBe(`daemon-${winnerIndex}`);
    expect(record.bearerToken).toBe(`token-${winnerIndex}`);
  });

  it("reclaims a stale PID lock after detection", () => {
    const stale = makeRecord({ pid: 999999, uuid: "stale-daemon" });
    expect(acquire(stale, { lockPath })).toBe(true);

    const record = read({ lockPath });
    expect(isStale(record)).toBe(true);
    expect(release({ lockPath, expectedUuid: "stale-daemon" })).toBe(true);

    expect(acquire(makeRecord({ uuid: "fresh-daemon", bearerToken: "token-fresh" }), { lockPath })).toBe(true);
    expect(read({ lockPath })?.uuid).toBe("fresh-daemon");
  });

  it("treats a UUID mismatch as stale for reclaim logic", () => {
    expect(acquire(makeRecord({ uuid: "winner-daemon" }), { lockPath })).toBe(true);
    const record = read({ lockPath });
    expect(isStale(record, { echoedUuid: "other-daemon" })).toBe(true);
    expect(isStale(record, { echoedUuid: "winner-daemon" })).toBe(false);
  });

  it("does not release a lock when the expected UUID does not match", () => {
    expect(acquire(makeRecord({ uuid: "winner-daemon" }), { lockPath })).toBe(true);
    expect(release({ lockPath, expectedUuid: "not-the-winner" })).toBe(false);
    expect(read({ lockPath })?.uuid).toBe("winner-daemon");
  });
});
