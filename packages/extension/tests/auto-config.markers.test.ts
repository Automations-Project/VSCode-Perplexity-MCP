import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PERPLEXITY_RULES_SECTION_END,
  PERPLEXITY_RULES_SECTION_START
} from "@perplexity-user-mcp/shared";
import {
  findMarkerBlock,
  removeSectionFromFile,
  upsertSectionInFile
} from "../src/auto-config/index.js";

const START = PERPLEXITY_RULES_SECTION_START;
const END = PERPLEXITY_RULES_SECTION_END;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "perplexity-markers-"));
  tempDirs.push(dir);
  return dir;
}

describe("findMarkerBlock", () => {
  it("reports missing when neither marker is present", () => {
    expect(findMarkerBlock("plain file body\n", START, END)).toEqual({
      state: "missing"
    });
  });

  it("reports found when exactly one well-ordered pair is present", () => {
    const body = `pre\n${START}\nmanaged\n${END}\npost\n`;
    const result = findMarkerBlock(body, START, END);
    expect(result.state).toBe("found");
    if (result.state !== "found") throw new Error("unreachable");
    expect(body.slice(result.startIdx, result.startIdx + START.length)).toBe(START);
    expect(body.slice(result.endIdx, result.endIdx + END.length)).toBe(END);
  });

  it("reports malformed reversed when END comes before START", () => {
    const body = `pre\n${END}\nstray\n${START}\npost\n`;
    expect(findMarkerBlock(body, START, END)).toEqual({
      state: "malformed",
      reason: "reversed"
    });
  });

  it("reports malformed duplicate when multiple pairs exist", () => {
    const body = `${START}\na\n${END}\nmid\n${START}\nb\n${END}\n`;
    expect(findMarkerBlock(body, START, END)).toEqual({
      state: "malformed",
      reason: "duplicate"
    });
  });

  it("reports malformed unmatched when only one side is present", () => {
    expect(findMarkerBlock(`only start ${START} here`, START, END)).toEqual({
      state: "malformed",
      reason: "unmatched"
    });
    expect(findMarkerBlock(`only end ${END} here`, START, END)).toEqual({
      state: "malformed",
      reason: "unmatched"
    });
  });
});

describe("upsertSectionInFile", () => {
  it("creates the file with the managed section when it does not exist", () => {
    const dir = makeTmp();
    const file = join(dir, "new.md");
    upsertSectionInFile(file, `${START}\nhello\n${END}`);
    expect(readFileSync(file, "utf8")).toBe(`${START}\nhello\n${END}\n`);
  });

  it("replaces the managed block in place on the happy path", () => {
    const dir = makeTmp();
    const file = join(dir, "rules.md");
    writeFileSync(file, `preamble\n${START}\nold\n${END}\npostamble\n`, "utf8");
    upsertSectionInFile(file, `${START}\nnew\n${END}`);
    expect(readFileSync(file, "utf8")).toBe(
      `preamble\n${START}\nnew\n${END}\npostamble\n`
    );
  });

  it("appends a fresh block instead of eating content when markers are reversed", () => {
    const dir = makeTmp();
    const file = join(dir, "rules.md");
    const userPreamble = "USER IMPORTANT CONTENT\n";
    const broken = `${userPreamble}${END}\nstray managed text\n${START}\n`;
    writeFileSync(file, broken, "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    upsertSectionInFile(file, `${START}\nfresh\n${END}`);

    const result = readFileSync(file, "utf8");
    // User's hand-written preamble must still be present.
    expect(result).toContain("USER IMPORTANT CONTENT");
    // The broken pair must still be present (not silently eaten).
    expect(result).toContain("stray managed text");
    // A fresh, well-formed block must have been appended.
    expect(result.endsWith(`${START}\nfresh\n${END}\n`)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("appends a fresh block instead of collapsing when duplicate pairs exist", () => {
    const dir = makeTmp();
    const file = join(dir, "rules.md");
    const existing =
      `top\n${START}\npair-one\n${END}\nmid\n${START}\npair-two\n${END}\nbottom\n`;
    writeFileSync(file, existing, "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    upsertSectionInFile(file, `${START}\nfresh\n${END}`);

    const result = readFileSync(file, "utf8");
    // Both original pairs and surrounding content remain untouched.
    expect(result).toContain("pair-one");
    expect(result).toContain("pair-two");
    expect(result).toContain("top");
    expect(result).toContain("mid");
    expect(result).toContain("bottom");
    // A third, fresh pair is appended at the end.
    expect(result.endsWith(`${START}\nfresh\n${END}\n`)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("writes atomically via a .tmp + rename (no direct write to target path)", () => {
    const dir = makeTmp();
    const file = join(dir, "atomic.md");
    upsertSectionInFile(file, `${START}\nbody\n${END}`);
    // After a successful write, no `.tmp` sidecar should be left behind.
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(`${START}\nbody\n${END}\n`);
  });
});

describe("removeSectionFromFile", () => {
  it("is a no-op when the file does not exist", () => {
    const dir = makeTmp();
    const file = join(dir, "missing.md");
    expect(() => removeSectionFromFile(file)).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it("is a no-op when neither marker is present", () => {
    const dir = makeTmp();
    const file = join(dir, "plain.md");
    const original = "plain content\nwith no markers\n";
    writeFileSync(file, original, "utf8");
    removeSectionFromFile(file);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("strips the managed block on the happy path", () => {
    const dir = makeTmp();
    const file = join(dir, "rules.md");
    writeFileSync(file, `preamble\n\n${START}\nmanaged\n${END}\n\npost\n`, "utf8");
    removeSectionFromFile(file);
    const result = readFileSync(file, "utf8");
    expect(result).not.toContain(START);
    expect(result).not.toContain(END);
    expect(result).toContain("preamble");
    expect(result).toContain("post");
  });

  it("leaves the file untouched and warns when markers are reversed", () => {
    const dir = makeTmp();
    const file = join(dir, "rules.md");
    const broken = `USER\n${END}\nstray\n${START}\nMORE USER\n`;
    writeFileSync(file, broken, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    removeSectionFromFile(file);

    expect(readFileSync(file, "utf8")).toBe(broken);
    expect(warn).toHaveBeenCalled();
  });

  it("leaves the file untouched when duplicate pairs exist", () => {
    const dir = makeTmp();
    const file = join(dir, "rules.md");
    const broken =
      `top\n${START}\na\n${END}\nmid\n${START}\nb\n${END}\nbottom\n`;
    writeFileSync(file, broken, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    removeSectionFromFile(file);

    expect(readFileSync(file, "utf8")).toBe(broken);
    expect(warn).toHaveBeenCalled();
  });
});
