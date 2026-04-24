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

  // Bug-2 regression: a hard crash (SIGKILL / power loss) can leave a
  // lockfile whose pid refers to a dead process. A fresh daemon start must
  // reclaim that stale lockfile on its own instead of refusing to start.
  it("acquire() reclaims a stale lockfile (dead pid) without manual release", () => {
    const stale = makeRecord({ pid: 999999, uuid: "stale-daemon" });
    expect(acquire(stale, { lockPath })).toBe(true);

    const fresh = makeRecord({ uuid: "fresh-daemon", bearerToken: "token-fresh" });
    expect(acquire(fresh, { lockPath })).toBe(true);
    expect(read({ lockPath })?.uuid).toBe("fresh-daemon");
  });

  it("acquire() reclaims a lockfile with invalid pid=0 as stale", () => {
    // Write a malformed record manually — acquire() should treat it as stale
    // even though read()/normalizeRecord would throw on it.
    const { writeFileSync } = require("node:fs");
    writeFileSync(lockPath, '{"pid":0,"uuid":"x","port":1,"bearerToken":"x","version":"x","startedAt":"x"}', "utf8");

    const fresh = makeRecord({ uuid: "fresh-daemon" });
    expect(acquire(fresh, { lockPath })).toBe(true);
    expect(read({ lockPath })?.uuid).toBe("fresh-daemon");
  });

  it("acquire() reclaims an unparseable lockfile as stale", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(lockPath, "not json at all {{{", "utf8");

    const fresh = makeRecord({ uuid: "fresh-daemon" });
    expect(acquire(fresh, { lockPath })).toBe(true);
    expect(read({ lockPath })?.uuid).toBe("fresh-daemon");
  });

  it("acquire() refuses to reclaim a lockfile held by a live process", () => {
    // Use our own pid — acquire() should treat this as a LIVE lock and
    // return false rather than stomping it.
    const live = makeRecord({ pid: process.pid, uuid: "live-daemon" });
    expect(acquire(live, { lockPath })).toBe(true);

    const other = makeRecord({ pid: process.pid, uuid: "intruder" });
    expect(acquire(other, { lockPath })).toBe(false);
    expect(read({ lockPath })?.uuid).toBe("live-daemon");
  });
});
