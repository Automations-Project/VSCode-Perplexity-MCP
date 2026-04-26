import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeAtomicWriteFileSync } from "../src/safe-write.js";

let TMP;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "pplx-safe-write-"));
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("safeAtomicWriteFileSync", () => {
  it("writes a new file when target does not exist", () => {
    const target = join(TMP, "creds.json");
    safeAtomicWriteFileSync(target, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  it("atomically replaces an existing file (no rmSync window)", () => {
    const target = join(TMP, "creds.json");
    writeFileSync(target, "old");
    safeAtomicWriteFileSync(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  it("leaves no orphan .tmp file behind on success", () => {
    const target = join(TMP, "creds.json");
    writeFileSync(target, "old");
    safeAtomicWriteFileSync(target, "new");
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("passes through string encoding option", () => {
    const target = join(TMP, "out.txt");
    safeAtomicWriteFileSync(target, "abc", "utf8");
    expect(readFileSync(target, "utf8")).toBe("abc");
  });

  it("passes through options object (encoding + mode)", () => {
    const target = join(TMP, "out.txt");
    safeAtomicWriteFileSync(target, "secret\n", { encoding: "utf8", mode: 0o600 });
    expect(readFileSync(target, "utf8")).toBe("secret\n");
    if (process.platform !== "win32") {
      const mode = statSync(target).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("accepts Buffer data with no options", () => {
    const target = join(TMP, "blob.bin");
    const buf = Buffer.from([0x50, 0x58, 0x56, 0x54]); // "PXVT"
    safeAtomicWriteFileSync(target, buf);
    expect(readFileSync(target).equals(buf)).toBe(true);
  });

  it("cleans up the .tmp file when writeFileSync throws", () => {
    // Force write failure: try to write into a path whose parent is a regular file.
    const blocker = join(TMP, "blocker");
    writeFileSync(blocker, "x");
    const target = join(blocker, "child.txt");
    expect(() => safeAtomicWriteFileSync(target, "data")).toThrow();
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("re-throws the original error from writeFileSync (not the cleanup error)", () => {
    const blocker = join(TMP, "blocker");
    writeFileSync(blocker, "x");
    const target = join(blocker, "child.txt");
    let caught;
    try {
      safeAtomicWriteFileSync(target, "data");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toMatch(/ENOTDIR|EISDIR|EACCES|ENOENT/);
  });
});
