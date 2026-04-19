import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { softLogout, hardLogout } from "../src/logout.js";
import { Vault } from "../src/vault.js";
import { createProfile, getProfilePaths, getProfile } from "../src/profiles.js";

describe("logout", () => {
  let configDir;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-logout-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "t-pass";
    createProfile("default");
  });

  it("soft: clears vault cookies + meta.lastLogin, touches .reinit, keeps dir", async () => {
    const vault = new Vault();
    await vault.set("default", "cookies", JSON.stringify([{ name: "x", value: "y" }]));
    await vault.set("default", "email", "a@b.co");
    writeFileSync(getProfilePaths("default").meta, JSON.stringify({ name: "default", displayName: "default", loginMode: "manual", tier: "Pro", lastLogin: "2026-04-19T00:00:00Z" }));

    await softLogout("default");

    expect(await vault.get("default", "cookies")).toBeNull();
    expect(await vault.get("default", "email")).toBe("a@b.co");
    expect(getProfile("default").lastLogin).toBeUndefined();
    expect(existsSync(getProfilePaths("default").reinit)).toBe(true);
    expect(existsSync(getProfilePaths("default").dir)).toBe(true);
  });

  it("hard: wipes entire profile dir including vault", async () => {
    const vault = new Vault();
    await vault.set("default", "cookies", JSON.stringify([{ name: "x", value: "y" }]));
    await hardLogout("default");
    expect(existsSync(getProfilePaths("default").dir)).toBe(false);
  });
});
