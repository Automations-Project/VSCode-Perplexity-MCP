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
});
