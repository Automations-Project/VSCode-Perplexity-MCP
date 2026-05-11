import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isMainModule } from "../src/is-main-module.js";
import { writeFileSync, symlinkSync, realpathSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = join(tmpdir(), "perplexity-is-main-module-test");

function cleanTmp() {
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
}

describe("isMainModule", () => {
  beforeEach(() => {
    cleanTmp();
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    cleanTmp();
    delete process.argv[1];
  });

  it("returns true when argv[1] matches import.meta.url exactly", () => {
    const realFile = join(TMP, "real.mjs");
    writeFileSync(realFile, "");
    process.argv[1] = realFile;
    const metaUrl = "file://" + realFile.replace(/\\/g, "/");
    expect(isMainModule(metaUrl)).toBe(true);
  });

  it("returns false when argv[1] points at a different file", () => {
    const realFile = join(TMP, "real.mjs");
    const otherFile = join(TMP, "other.mjs");
    writeFileSync(realFile, "");
    writeFileSync(otherFile, "");
    process.argv[1] = otherFile;
    const metaUrl = "file://" + realFile.replace(/\\/g, "/");
    expect(isMainModule(metaUrl)).toBe(false);
  });

  it("returns true when argv[1] is a symlink to the real file (issue #6)", () => {
    const realFile = join(TMP, "real.mjs");
    const linkFile = join(TMP, "link.mjs");
    writeFileSync(realFile, "");
    symlinkSync(realFile, linkFile);
    process.argv[1] = linkFile;
    const metaUrl = "file://" + realFile.replace(/\\/g, "/");
    expect(isMainModule(metaUrl)).toBe(true);
  });

  it("returns false when argv[1] is missing", () => {
    delete process.argv[1];
    expect(isMainModule("file:///any/path.mjs")).toBe(false);
  });
});
