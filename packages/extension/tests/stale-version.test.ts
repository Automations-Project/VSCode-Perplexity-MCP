import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLockStale, killStaleDaemonPid, removeStaleLock } from "../src/daemon/stale-version.js";

describe("isLockStale", () => {
  it("returns false for a null/missing lock (handled elsewhere)", () => {
    expect(isLockStale(null, "0.8.9")).toBe(false);
    expect(isLockStale(undefined, "0.8.9")).toBe(false);
  });

  it("returns false when versions match exactly", () => {
    expect(isLockStale({ version: "0.8.9" }, "0.8.9")).toBe(false);
  });

  it("returns true on any version mismatch (older or newer)", () => {
    expect(isLockStale({ version: "0.8.5" }, "0.8.9")).toBe(true);
    expect(isLockStale({ version: "0.9.0" }, "0.8.9")).toBe(true);
    expect(isLockStale({ version: "1.0.0-beta.1" }, "0.8.9")).toBe(true);
  });

  it("treats missing/empty version field as mismatch (older daemons)", () => {
    expect(isLockStale({}, "0.8.9")).toBe(true);
    expect(isLockStale({ version: "" }, "0.8.9")).toBe(true);
    expect(isLockStale({ version: null }, "0.8.9")).toBe(true);
  });

  it("prefers mcpVersion over version (legacy reaper compat stamp)", () => {
    // Extension 0.8.56 stamped lock.version=0.8.56 for old reapers, while
    // mcpVersion=0.8.55 is the real chunk graph — new reaper must use mcpVersion.
    expect(
      isLockStale({ version: "0.8.56", mcpVersion: "0.8.55" }, "0.8.55"),
    ).toBe(false);
    expect(
      isLockStale({ version: "0.8.56", mcpVersion: "0.8.54" }, "0.8.55"),
    ).toBe(true);
  });

  it("falls back to version when mcpVersion is absent (pre-dual-field locks)", () => {
    expect(isLockStale({ version: "0.8.55" }, "0.8.55")).toBe(false);
    expect(isLockStale({ version: "0.8.55" }, "0.8.56")).toBe(true);
  });
});

describe("removeStaleLock", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "perp-stale-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("deletes an existing lock file", () => {
    const p = join(tmp, "daemon.lock");
    writeFileSync(p, "{}", "utf8");
    expect(existsSync(p)).toBe(true);
    removeStaleLock(p);
    expect(existsSync(p)).toBe(false);
  });

  it("swallows ENOENT when the file is already gone", () => {
    expect(() => removeStaleLock(join(tmp, "nope.lock"))).not.toThrow();
  });
});

describe("killStaleDaemonPid", () => {
  // The reaper now forks by platform: Windows must TREE-kill (taskkill /T /F —
  // a plain process.kill is TerminateProcess, the daemon's cleanup never runs,
  // and its orphaned Chrome keeps the browser-data ProcessSingleton, breaking
  // every later launch). POSIX keeps SIGTERM so the daemon's own handler can
  // close its browser gracefully.
  const realKill = process.kill;
  const realPlatform = process.platform;
  const setPlatform = (value: string) =>
    Object.defineProperty(process, "platform", { value, configurable: true });
  afterEach(() => {
    process.kill = realKill;
    setPlatform(realPlatform);
  });

  it("POSIX: calls SIGTERM on the supplied pid (graceful — daemon closes its own browser)", () => {
    setPlatform("linux");
    const spy = vi.fn();
    process.kill = spy as unknown as typeof process.kill;
    const log = vi.fn();
    killStaleDaemonPid(31456, log);
    expect(spy).toHaveBeenCalledWith(31456, "SIGTERM");
    expect(log).not.toHaveBeenCalled();
  });

  it("Windows: never uses process.kill — tree-kill only, and it must not throw", () => {
    setPlatform("win32");
    const spy = vi.fn();
    process.kill = spy as unknown as typeof process.kill;
    const log = vi.fn();
    // taskkill fires against a nonexistent pid; the callback logs, never throws.
    expect(() => killStaleDaemonPid(0x7fffffff, log)).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("swallows ESRCH (already dead) silently", () => {
    setPlatform("linux");
    process.kill = ((): never => {
      const e = new Error("no such process") as Error & { code: string };
      e.code = "ESRCH";
      throw e;
    }) as unknown as typeof process.kill;
    const log = vi.fn();
    expect(() => killStaleDaemonPid(99999, log)).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });

  it("logs (but does not throw) on EPERM", () => {
    setPlatform("linux");
    process.kill = ((): never => {
      const e = new Error("not permitted") as Error & { code: string };
      e.code = "EPERM";
      throw e;
    }) as unknown as typeof process.kill;
    const log = vi.fn();
    expect(() => killStaleDaemonPid(1, log)).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("EPERM"));
  });

  it("logs unknown errors without throwing", () => {
    setPlatform("linux");
    process.kill = ((): never => { throw new Error("boom"); }) as unknown as typeof process.kill;
    const log = vi.fn();
    expect(() => killStaleDaemonPid(42, log)).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});

describe("integration: stale lock kill+clean before respawn", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "perp-stale-int-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("when a lock has version=0.8.5 and bundled=0.8.9, kill is invoked and the lock is removed", () => {
    const lockPath = join(tmp, "daemon.lock");
    const stale = {
      pid: 31456, port: 13168, uuid: "u-1",
      bearerToken: "tok", version: "0.8.5",
      startedAt: new Date().toISOString(),
      cloudflaredPid: null, tunnelUrl: null,
    };
    writeFileSync(lockPath, JSON.stringify(stale), "utf8");

    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as typeof stale;
    expect(isLockStale(lock, "0.8.9")).toBe(true);

    // Pin POSIX: the Windows branch goes through taskkill (tree-kill), not
    // process.kill — asserted separately in the killStaleDaemonPid suite.
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const killSpy = vi.fn();
    const realKill = process.kill;
    process.kill = killSpy as unknown as typeof process.kill;
    try {
      killStaleDaemonPid(lock.pid, () => undefined);
      removeStaleLock(lockPath);
    } finally {
      process.kill = realKill;
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    }

    expect(killSpy).toHaveBeenCalledWith(31456, "SIGTERM");
    expect(existsSync(lockPath)).toBe(false);
  });
});
