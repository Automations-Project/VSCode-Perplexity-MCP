import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("getSavedCookies diagnostic logging (issue #5.3)", () => {
  let TMP;
  let capturedErrors;
  let originalConsoleError;

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "pplx-config-"));
    process.env.PERPLEXITY_CONFIG_DIR = TMP;
    process.env.PERPLEXITY_PROFILE = "default";
    delete process.env.PERPLEXITY_SESSION_TOKEN;
    delete process.env.PERPLEXITY_CSRF_TOKEN;
    capturedErrors = [];
    originalConsoleError = console.error;
    console.error = (...args) => {
      capturedErrors.push(args.join(" "));
    };
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.PERPLEXITY_CONFIG_DIR;
    delete process.env.PERPLEXITY_PROFILE;
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    delete process.env.PERPLEXITY_DISABLE_KEYCHAIN;
    console.error = originalConsoleError;
  });

  it("logs 'no vault.enc' when vault is missing", async () => {
    const { getSavedCookies } = await import("../src/config.js");
    const cookies = await getSavedCookies();
    expect(cookies).toEqual([]);
    expect(capturedErrors.some((c) => /no vault\.enc/.test(c))).toBe(true);
    expect(capturedErrors.some((c) => /run login first/.test(c))).toBe(true);
  });

  it("logs 'cookies key absent' when vault exists but has no cookies", async () => {
    const { createProfile } = await import("../src/profiles.js");
    const { Vault, __resetKeyCache } = await import("../src/vault.js");
    createProfile("default");
    __resetKeyCache();
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "test-passphrase";
    const v = new Vault();
    await v.set("default", "email", "test@example.com");

    vi.resetModules();
    const { getSavedCookies } = await import("../src/config.js");
    const cookies = await getSavedCookies();
    expect(cookies).toEqual([]);
    expect(capturedErrors.some((c) => c.includes("'cookies' key is absent"))).toBe(true);
  });

  it("wasLastVaultLocked() is false when there is no vault (not locked — just not logged in)", async () => {
    const { getSavedCookies, wasLastVaultLocked } = await import("../src/config.js");
    await getSavedCookies();
    expect(wasLastVaultLocked()).toBe(false);
  });

  it("wasLastVaultLocked() is true when vault.enc exists but cannot be unsealed", async () => {
    const { createProfile } = await import("../src/profiles.js");
    const { Vault, __resetKeyCache } = await import("../src/vault.js");
    createProfile("default");
    // Write a cookies blob encrypted with a passphrase (keychain disabled so
    // the blob is purely passphrase-protected).
    process.env.PERPLEXITY_DISABLE_KEYCHAIN = "1";
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "secret";
    __resetKeyCache();
    const v = new Vault();
    await v.set("default", "cookies", JSON.stringify([{ name: "x", value: "y" }]));

    // Now drop the passphrase (and keychain) — the daemon-style "Vault locked"
    // path: vault.enc exists but there is no unseal material.
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    __resetKeyCache();

    vi.resetModules();
    const { getSavedCookies, wasLastVaultLocked } = await import("../src/config.js");
    const cookies = await getSavedCookies();
    expect(cookies).toEqual([]);
    expect(wasLastVaultLocked()).toBe(true);
  });
});
