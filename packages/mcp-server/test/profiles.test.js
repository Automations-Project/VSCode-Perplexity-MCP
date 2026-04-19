import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateName, getProfilePaths, getConfigDir } from "../src/profiles.js";

let TMP;
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "pplx-test-"));
  process.env.PERPLEXITY_CONFIG_DIR = TMP;
});
afterEach(() => {
  delete process.env.PERPLEXITY_CONFIG_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

describe("validateName", () => {
  it("accepts plain slugs", () => {
    expect(validateName("work")).toBeNull();
    expect(validateName("account-1")).toBeNull();
    expect(validateName("a_b-c")).toBeNull();
  });
  it("rejects empty", () => {
    expect(validateName("")).toMatch(/required/i);
  });
  it("rejects uppercase", () => {
    expect(validateName("Work")).toMatch(/lowercase/i);
  });
  it("rejects @ (email-shaped)", () => {
    expect(validateName("alice@company")).toMatch(/characters/i);
  });
  it("rejects . (hostname-shaped)", () => {
    expect(validateName("alice.com")).toMatch(/characters/i);
  });
  it("rejects spaces", () => {
    expect(validateName("my account")).toMatch(/characters/i);
  });
  it("rejects >32 chars", () => {
    expect(validateName("a".repeat(33))).toMatch(/32/);
  });
  it("rejects non-string input", () => {
    expect(validateName(null)).toMatch(/required/i);
    expect(validateName(undefined)).toMatch(/required/i);
    expect(validateName(42)).toMatch(/required/i);
  });
});

describe("getProfilePaths", () => {
  it("returns all expected subpaths", () => {
    const p = getProfilePaths("work");
    expect(p.dir).toBe(join(TMP, "profiles", "work"));
    expect(p.browserData).toBe(join(TMP, "profiles", "work", "browser-data"));
    expect(p.modelsCache).toBe(join(TMP, "profiles", "work", "models-cache.json"));
    expect(p.history).toBe(join(TMP, "profiles", "work", "history"));
    expect(p.attachments).toBe(join(TMP, "profiles", "work", "attachments"));
    expect(p.researches).toBe(join(TMP, "profiles", "work", "researches"));
    expect(p.meta).toBe(join(TMP, "profiles", "work", "meta.json"));
    expect(p.vault).toBe(join(TMP, "profiles", "work", "vault.enc"));
    expect(p.vaultPlain).toBe(join(TMP, "profiles", "work", "vault.json"));
    expect(p.reinit).toBe(join(TMP, "profiles", "work", ".reinit"));
  });

  it("does not touch filesystem (paths only)", () => {
    const p = getProfilePaths("nowhere");
    expect(existsSync(p.dir)).toBe(false);
  });
});

describe("getConfigDir", () => {
  it("honors PERPLEXITY_CONFIG_DIR env var", () => {
    expect(getConfigDir()).toBe(TMP);
  });

  it("falls back to ~/.perplexity-mcp when env unset", () => {
    delete process.env.PERPLEXITY_CONFIG_DIR;
    const cd = getConfigDir();
    expect(cd.endsWith(".perplexity-mcp")).toBe(true);
  });
});
