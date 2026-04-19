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

import { readFileSync } from "node:fs";
import { createProfile, listProfiles, getProfile, deleteProfile } from "../src/profiles.js";

describe("createProfile", () => {
  it("creates dir + meta.json with required fields", () => {
    const p = createProfile("work");
    expect(p.name).toBe("work");
    expect(p.displayName).toBe("work");
    expect(p.loginMode).toBe("manual");
    expect(p.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(existsSync(getProfilePaths("work").dir)).toBe(true);
    expect(existsSync(getProfilePaths("work").meta)).toBe(true);
    const meta = JSON.parse(readFileSync(getProfilePaths("work").meta, "utf8"));
    expect(meta.name).toBe("work");
    expect(meta.email).toBeUndefined();
    expect(meta.userId).toBeUndefined();
  });
  it("rejects invalid names", () => {
    expect(() => createProfile("Work")).toThrow(/lowercase/);
  });
  it("rejects duplicates", () => {
    createProfile("work");
    expect(() => createProfile("work")).toThrow(/already exists/);
  });
  it("accepts custom displayName", () => {
    const p = createProfile("work", { displayName: "My Work Pro", loginMode: "auto" });
    expect(p.displayName).toBe("My Work Pro");
    expect(p.loginMode).toBe("auto");
  });
});

describe("listProfiles", () => {
  it("returns empty array when no profiles", () => {
    expect(listProfiles()).toEqual([]);
  });
  it("lists created profiles", () => {
    createProfile("a");
    createProfile("b");
    const names = listProfiles().map((p) => p.name).sort();
    expect(names).toEqual(["a", "b"]);
  });
  it("skips dirs with unparseable meta.json", () => {
    createProfile("good");
    // Manually create a malformed profile dir
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(TMP, "profiles", "broken"), { recursive: true });
    writeFileSync(join(TMP, "profiles", "broken", "meta.json"), "not json");
    const names = listProfiles().map((p) => p.name);
    expect(names).toEqual(["good"]); // broken is skipped silently
  });
});

describe("getProfile", () => {
  it("returns null for unknown", () => {
    expect(getProfile("nope")).toBeNull();
  });
  it("returns profile meta for known", () => {
    createProfile("work");
    expect(getProfile("work")?.name).toBe("work");
  });
  it("returns null for malformed meta", () => {
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(TMP, "profiles", "bad"), { recursive: true });
    writeFileSync(join(TMP, "profiles", "bad", "meta.json"), "not json");
    expect(getProfile("bad")).toBeNull();
  });
});

describe("deleteProfile", () => {
  it("removes dir and meta", () => {
    createProfile("work");
    expect(existsSync(getProfilePaths("work").dir)).toBe(true);
    deleteProfile("work");
    expect(existsSync(getProfilePaths("work").dir)).toBe(false);
  });
  it("is idempotent — no throw if profile doesn't exist", () => {
    expect(() => deleteProfile("nonexistent")).not.toThrow();
  });
});

import { getActive, setActive, suggestNextDefaultName } from "../src/profiles.js";

describe("active profile pointer", () => {
  it("returns null when no profiles exist", () => {
    expect(getActive()).toBeNull();
  });

  it("returns active profile", () => {
    createProfile("work");
    setActive("work");
    expect(getActive()?.name).toBe("work");
  });

  it("atomically swaps active on setActive", () => {
    createProfile("a");
    createProfile("b");
    setActive("a");
    expect(getActive()?.name).toBe("a");
    setActive("b");
    expect(getActive()?.name).toBe("b");
  });

  it("falls back if pointer references a deleted profile", () => {
    createProfile("a");
    setActive("a");
    deleteProfile("a");
    expect(getActive()).toBeNull();
  });

  it("setActive rejects unknown profile", () => {
    expect(() => setActive("nope")).toThrow(/not found/i);
  });
});

describe("suggestNextDefaultName", () => {
  it("returns account-1 when empty", () => {
    expect(suggestNextDefaultName()).toBe("account-1");
  });
  it("skips existing numbered defaults", () => {
    createProfile("account-1");
    createProfile("account-2");
    expect(suggestNextDefaultName()).toBe("account-3");
  });
  it("ignores non-matching names", () => {
    createProfile("work");
    expect(suggestNextDefaultName()).toBe("account-1");
  });
});
