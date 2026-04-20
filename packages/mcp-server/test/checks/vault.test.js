import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetKeyCache } from "../../src/vault.js";

async function runVaultCheck(opts) {
  __resetKeyCache();
  const { run } = await import("../../src/checks/vault.js");
  return run(opts);
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "px-vault-"));
  delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("checks/vault", () => {
  it("passes when keychain provides a key", async () => {
    vi.doMock("keytar", () => ({
      default: { getPassword: vi.fn(async () => "a".repeat(64)), setPassword: vi.fn() },
    }));
    const checks = await runVaultCheck({ configDir: dir, profile: "default" });
    expect(checks.find((c) => c.name === "unseal-path").status).toBe("pass");
    expect(checks.find((c) => c.name === "unseal-path").message).toMatch(/keychain/i);
    vi.doUnmock("keytar");
  });

  it("passes via env var when keychain absent but env set", async () => {
    vi.doMock("keytar", () => { throw new Error("no keychain"); });
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "correct horse";
    const checks = await runVaultCheck({ configDir: dir, profile: "default" });
    const check = checks.find((c) => c.name === "unseal-path");
    expect(check.status).toBe("pass");
    expect(check.message).toMatch(/env var/i);
    vi.doUnmock("keytar");
  });

  it("warns when env var is used on a platform with keychain available", async () => {
    vi.doMock("keytar", () => ({
      default: { getPassword: vi.fn(async () => "b".repeat(64)), setPassword: vi.fn() },
    }));
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "override";
    const checks = await runVaultCheck({ configDir: dir, profile: "default" });
    const check = checks.find((c) => c.name === "keychain-preferred");
    expect(check.status).toBe("warn");
    vi.doUnmock("keytar");
  });

  it("warns on vault.json plaintext opt-out", async () => {
    mkdirSync(join(dir, "profiles", "default"), { recursive: true });
    writeFileSync(join(dir, "profiles", "default", "vault.json"), "{}");
    const checks = await runVaultCheck({ configDir: dir, profile: "default" });
    const check = checks.find((c) => c.name === "encryption");
    expect(check.status).toBe("warn");
    expect(check.message).toMatch(/plaintext/i);
  });

  it("fails when nothing works and vault.enc exists", async () => {
    mkdirSync(join(dir, "profiles", "default"), { recursive: true });
    writeFileSync(join(dir, "profiles", "default", "vault.enc"), Buffer.alloc(64));
    vi.doMock("keytar", () => { throw new Error("no keychain"); });
    vi.stubGlobal("process", { ...process, stdin: { ...process.stdin, isTTY: false } });
    const checks = await runVaultCheck({ configDir: dir, profile: "default" });
    expect(checks.find((c) => c.name === "unseal-path").status).toBe("fail");
    vi.doUnmock("keytar");
  });
});
