import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../src/history-lock.js";

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempLock() {
  const dir = mkdtempSync(join(tmpdir(), "px-lock-"));
  dirs.push(dir);
  return join(dir, "index.lock");
}

describe("withFileLock", () => {
  it("runs fn and releases the lock", () => {
    const lockPath = tempLock();
    let heldDuringFn = false;
    const result = withFileLock(lockPath, () => {
      heldDuringFn = existsSync(lockPath);
      return "value";
    });
    expect(result).toBe("value");
    expect(heldDuringFn).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock when fn throws — a throw must not wedge every future writer", () => {
    const lockPath = tempLock();
    expect(() => withFileLock(lockPath, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("is reentrant — rebuildIndex is reachable from inside a held section", () => {
    const lockPath = tempLock();
    const result = withFileLock(lockPath, () => withFileLock(lockPath, () => "nested"));
    expect(result).toBe("nested");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("writes the holder pid so a crashed owner can be diagnosed and reclaimed", () => {
    const lockPath = tempLock();
    let contents = "";
    withFileLock(lockPath, () => {
      contents = readFileSync(lockPath, "utf8");
    });
    expect(Number.parseInt(contents.split("\n")[0], 10)).toBe(process.pid);
  });

  it("reclaims a lock whose owner is dead", () => {
    const lockPath = tempLock();
    // 0x7FFFFFFF is above every platform's pid ceiling → provably not alive.
    writeFileSync(lockPath, `${0x7fffffff}\n${Date.now()}`);
    let ran = false;
    withFileLock(lockPath, () => { ran = true; }, { attempts: 5, backoffMs: 1 });
    expect(ran).toBe(true);
  });

  it("reclaims an abandoned lock once it ages out", () => {
    const lockPath = tempLock();
    // Live pid (ours) but written long ago — a crashed writer that never got
    // to fill in its pid, or a hung holder. The age check is the backstop.
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60_000);
    const { utimesSync } = require("node:fs");
    utimesSync(lockPath, old, old);
    let ran = false;
    withFileLock(lockPath, () => { ran = true; }, { attempts: 5, backoffMs: 1 });
    expect(ran).toBe(true);
  });

  // The race that made the cross-process history test flaky under load.
  //
  // Acquire is openSync(path,"wx") -> writeFileSync(fd,pid): the file exists
  // and is EMPTY for a short window. A peer that reads it there sees no pid.
  // Treating "no pid" as stale means the peer DELETES a lock that was
  // legitimately just taken, both writers proceed, and the index loses an
  // entry. A fresh-but-empty lock means "someone is mid-acquire" — the
  // opposite of stale. Only the age check may reclaim it.
  it("does NOT reclaim a freshly-created, still-empty lock (mid-acquire window)", () => {
    const lockPath = tempLock();
    writeFileSync(lockPath, ""); // exists, empty, mtime = now
    let ran = false;
    withFileLock(lockPath, () => { ran = true; }, { attempts: 3, backoffMs: 1 });

    // We must NOT have stolen it. The fail-open contract means fn still runs
    // (throwing would recreate the silent loss recordToolRun swallows), but
    // the peer's lock must survive untouched.
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe("");
  });

  it("proceeds fail-open rather than throwing when the lock stays busy", () => {
    const lockPath = tempLock();
    // Held by a live process (us) with a fresh mtime → never reclaimable.
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}`);
    let ran = false;
    const result = withFileLock(lockPath, () => { ran = true; return "done"; }, {
      attempts: 3,
      backoffMs: 1,
    });
    // Throwing would be worse than proceeding: recordToolRun swallows throws,
    // so the entry would vanish silently — the exact bug this lock exists to
    // prevent. The .md is still written and rebuild-history-index can recover.
    expect(ran).toBe(true);
    expect(result).toBe("done");
    expect(existsSync(lockPath)).toBe(true);
  });
});
