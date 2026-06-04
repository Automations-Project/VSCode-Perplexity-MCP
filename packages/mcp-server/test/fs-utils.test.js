import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStaleSingletonLocks, launchWithRetry, isLockContentionError } from "../src/fs-utils.js";

let TMP;
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "pplx-fs-"));
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("clearStaleSingletonLocks", () => {
  it("removes SingletonLock, SingletonCookie, and SingletonSocket if present", () => {
    const lock = join(TMP, "SingletonLock");
    const cookie = join(TMP, "SingletonCookie");
    const socket = join(TMP, "SingletonSocket");
    writeFileSync(lock, "x");
    writeFileSync(cookie, "x");
    writeFileSync(socket, "x");
    clearStaleSingletonLocks(TMP);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(cookie)).toBe(false);
    expect(existsSync(socket)).toBe(false);
  });

  it("does not throw on an empty directory", () => {
    expect(() => clearStaleSingletonLocks(TMP)).not.toThrow();
  });

  it("preserves unrelated files in the directory", () => {
    const keep = join(TMP, "Preferences");
    writeFileSync(keep, "config");
    writeFileSync(join(TMP, "SingletonLock"), "x");
    clearStaleSingletonLocks(TMP);
    expect(existsSync(keep)).toBe(true);
  });

  it("removes the Windows ProcessSingleton lockfile if present (issue #8)", () => {
    const lf = join(TMP, "lockfile");
    writeFileSync(lf, "x");
    clearStaleSingletonLocks(TMP);
    expect(existsSync(lf)).toBe(false);
  });
});

describe("isLockContentionError", () => {
  it("matches Chromium singleton-lock / immediate-exit signatures", () => {
    expect(isLockContentionError(new Error(
      "browserType.launchPersistentContext: Target page, context or browser has been closed"
    ))).toBe(true);
    expect(isLockContentionError(new Error("ProcessSingleton: the profile is already in use"))).toBe(true);
  });

  it("matches Windows exit-code-21 phrasings including the 'with code' variant", () => {
    expect(isLockContentionError(new Error("exit 21"))).toBe(true);
    expect(isLockContentionError(new Error("exit code 21"))).toBe(true);
    expect(isLockContentionError(new Error("exit with code 21"))).toBe(true);
    expect(isLockContentionError(new Error("Browser process exited with code 21"))).toBe(true);
    // word boundary — must not match an unrelated number that merely contains 21
    expect(isLockContentionError(new Error("net error 215"))).toBe(false);
  });

  it("returns false for unrelated errors and non-errors", () => {
    expect(isLockContentionError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(false);
    expect(isLockContentionError(new Error("Executable doesn't exist"))).toBe(false);
    expect(isLockContentionError(null)).toBe(false);
    expect(isLockContentionError(undefined)).toBe(false);
  });
});

describe("launchWithRetry", () => {
  it("returns the first successful launch without sleeping", async () => {
    const sleeps = [];
    const result = await launchWithRetry(() => "ctx", { sleep: async (ms) => { sleeps.push(ms); } });
    expect(result).toBe("ctx");
    expect(sleeps).toEqual([]);
  });

  it("retries lock contention with exponential backoff, running beforeAttempt each time", async () => {
    let calls = 0;
    const before = [];
    const sleeps = [];
    const result = await launchWithRetry(
      () => {
        calls++;
        if (calls < 3) throw new Error("Target page, context or browser has been closed");
        return "ctx";
      },
      {
        baseDelayMs: 10,
        sleep: async (ms) => { sleeps.push(ms); },
        beforeAttempt: (attempt) => { before.push(attempt); },
      }
    );
    expect(result).toBe("ctx");
    expect(calls).toBe(3);
    expect(before).toEqual([0, 1, 2]);
    expect(sleeps).toEqual([10, 20]);
  });

  it("rethrows after exhausting retries on persistent lock contention", async () => {
    let calls = 0;
    await expect(
      launchWithRetry(
        () => { calls++; throw new Error("Target page, context or browser has been closed"); },
        { retries: 2, baseDelayMs: 1, sleep: async () => {} }
      )
    ).rejects.toThrow(/closed/);
    expect(calls).toBe(3); // initial attempt + 2 retries
  });

  it("does not retry a non-lock error", async () => {
    let calls = 0;
    await expect(
      launchWithRetry(
        () => { calls++; throw new Error("Executable doesn't exist at /path/chrome"); },
        { retries: 3, baseDelayMs: 1, sleep: async () => {} }
      )
    ).rejects.toThrow(/Executable/);
    expect(calls).toBe(1);
  });

  it("keeps retrying even when beforeAttempt throws (lock clearing is best-effort)", async () => {
    let launches = 0;
    let befores = 0;
    const result = await launchWithRetry(
      () => {
        launches++;
        if (launches < 2) throw new Error("Target page, context or browser has been closed");
        return "ok";
      },
      {
        baseDelayMs: 1,
        sleep: async () => {},
        beforeAttempt: () => { befores++; throw new Error("could not delete lockfile"); },
      }
    );
    expect(result).toBe("ok");
    expect(launches).toBe(2);
    expect(befores).toBe(2); // ran before each attempt; its throw was swallowed
  });
});
