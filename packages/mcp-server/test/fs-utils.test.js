import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStaleSingletonLocks } from "../src/fs-utils.js";

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
});
