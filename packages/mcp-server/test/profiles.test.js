import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateName, getProfilePaths, getConfigDir, getActiveName } from "../src/profiles.js";

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
  it("switches the active pointer to another profile when deleting the active profile", () => {
    createProfile("a");
    createProfile("b");
    setActive("a");
    deleteProfile("a");
    expect(getActiveName()).toBe("b");
  });
  it("clears the active pointer when deleting the last profile", () => {
    createProfile("a");
    setActive("a");
    deleteProfile("a");
    expect(getActiveName()).toBeNull();
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

import { renameProfile, recordLoginSuccess } from "../src/profiles.js";

describe("renameProfile", () => {
  it("moves dir + updates meta.name", () => {
    createProfile("work");
    renameProfile("work", "work2");
    expect(getProfile("work")).toBeNull();
    expect(getProfile("work2")?.name).toBe("work2");
  });
  it("updates active pointer if it was pointing at old name", () => {
    createProfile("work");
    setActive("work");
    renameProfile("work", "work2");
    expect(getActive()?.name).toBe("work2");
  });
  it("rejects invalid new name", () => {
    createProfile("work");
    expect(() => renameProfile("work", "WORK")).toThrow(/lowercase/);
  });
  it("rejects rename to existing name", () => {
    createProfile("a");
    createProfile("b");
    expect(() => renameProfile("a", "b")).toThrow(/already exists/);
  });
});

describe("recordLoginSuccess", () => {
  it("creates the profile dir and writes meta when no prior meta exists", () => {
    const lastLogin = "2026-04-26T12:00:00Z";
    const meta = recordLoginSuccess("acct1", {
      tier: "pro",
      loginMode: "browser",
      lastLogin,
    });

    // Profile dir should now exist
    expect(existsSync(getProfilePaths("acct1").dir)).toBe(true);
    expect(existsSync(getProfilePaths("acct1").meta)).toBe(true);

    // Returned meta has expected shape
    expect(meta.name).toBe("acct1");
    expect(meta.displayName).toBe("acct1");
    expect(meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.tier).toBe("pro");
    expect(meta.loginMode).toBe("browser");
    expect(meta.lastLogin).toBe(lastLogin);

    // On-disk meta.json round-trips identically
    const onDisk = JSON.parse(
      readFileSync(getProfilePaths("acct1").meta, "utf8"),
    );
    expect(onDisk).toEqual(meta);
  });

  it("updates existing meta in place and preserves name/displayName/createdAt", () => {
    const created = createProfile("work", { displayName: "My Work" });
    const originalCreatedAt = created.createdAt;

    const lastLogin = "2026-04-26T13:30:00Z";
    const meta = recordLoginSuccess("work", {
      tier: "max",
      loginMode: "manual",
      lastLogin,
    });

    // Identity fields preserved
    expect(meta.name).toBe("work");
    expect(meta.displayName).toBe("My Work");
    expect(meta.createdAt).toBe(originalCreatedAt);

    // Login fields updated
    expect(meta.tier).toBe("max");
    expect(meta.loginMode).toBe("manual");
    expect(meta.lastLogin).toBe(lastLogin);

    // Disk reflects the same shape
    const onDisk = JSON.parse(
      readFileSync(getProfilePaths("work").meta, "utf8"),
    );
    expect(onDisk).toEqual(meta);
  });

  it("returns the merged meta object that callers can use directly", () => {
    createProfile("acct2");
    const returned = recordLoginSuccess("acct2", {
      tier: "free",
      loginMode: "browser",
      lastLogin: "2026-04-26T14:00:00Z",
    });
    const fromDisk = getProfile("acct2");
    expect(returned).toEqual(fromDisk);
  });
});
