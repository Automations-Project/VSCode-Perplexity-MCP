import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptBlob, decryptBlob, getMasterKey, __resetKeyCache } from "../src/vault.js";

describe("vault AES-GCM primitives", () => {
  const KEY = Buffer.alloc(32, 7); // deterministic test key

  it("roundtrips a JSON payload", () => {
    const data = { cookies: [{ name: "session", value: "v1" }], email: "x@y.co" };
    const enc = encryptBlob(Buffer.from(JSON.stringify(data)), KEY);
    const dec = decryptBlob(enc, KEY);
    expect(JSON.parse(dec.toString())).toEqual(data);
  });

  it("rejects wrong key", () => {
    const enc = encryptBlob(Buffer.from("hello"), KEY);
    const wrongKey = Buffer.alloc(32, 8);
    expect(() => decryptBlob(enc, wrongKey)).toThrow(/decrypt/i);
  });

  it("rejects tampered authtag", () => {
    const enc = encryptBlob(Buffer.from("hello"), KEY);
    enc[enc.length - 1] ^= 0x01;  // flip one bit in authtag
    expect(() => decryptBlob(enc, KEY)).toThrow(/decrypt/i);
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptBlob(Buffer.from("hello world payload"), KEY);
    // flip a byte in the middle (ciphertext region is between iv and authtag)
    enc[20] ^= 0x01;
    expect(() => decryptBlob(enc, KEY)).toThrow(/decrypt/i);
  });

  it("produces different ciphertext for same plaintext (random IV)", () => {
    const a = encryptBlob(Buffer.from("same"), KEY);
    const b = encryptBlob(Buffer.from("same"), KEY);
    expect(a.equals(b)).toBe(false);
  });

  it("includes magic header PXVT", () => {
    const enc = encryptBlob(Buffer.from("x"), KEY);
    expect(enc.slice(0, 4).toString()).toBe("PXVT");
    expect(enc[4]).toBe(1); // version
  });
});

describe("getMasterKey — keychain path", () => {
  beforeEach(() => {
    __resetKeyCache();
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
  });

  it("reads existing key from keychain via keytar", async () => {
    const hex = "a".repeat(64);  // 32 bytes as hex
    vi.doMock("keytar", () => ({
      default: {
        getPassword: vi.fn(async () => hex),
        setPassword: vi.fn(),
      },
    }));
    const key = await getMasterKey();
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(hex);
    vi.doUnmock("keytar");
  });

  it("generates + persists key when keychain is empty", async () => {
    let stored = null;
    vi.doMock("keytar", () => ({
      default: {
        getPassword: vi.fn(async () => stored),
        setPassword: vi.fn(async (_svc, _acct, val) => {
          stored = val;
        }),
      },
    }));
    const key = await getMasterKey();
    expect(key.length).toBe(32);
    expect(stored).not.toBeNull();
    expect(stored).toHaveLength(64);  // 32 bytes as hex
    vi.doUnmock("keytar");
  });
});

describe("getMasterKey — env var fallback", () => {
  beforeEach(() => {
    __resetKeyCache();
    vi.doMock("keytar", () => { throw new Error("unavailable"); });
  });
  afterEach(() => {
    vi.doUnmock("keytar");
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    delete process.env.PERPLEXITY_MCP_STDIO;
  });

  it("derives key from PERPLEXITY_VAULT_PASSPHRASE via HKDF", async () => {
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "super-secret-passphrase";
    const key = await getMasterKey();
    expect(key.length).toBe(32);
    // Same passphrase ⇒ same key (caching only within one process; reset between)
    __resetKeyCache();
    const key2 = await getMasterKey();
    expect(key.equals(key2)).toBe(true);
  });

  it("different passphrase ⇒ different key", async () => {
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "one";
    const k1 = await getMasterKey();
    __resetKeyCache();
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "two";
    const k2 = await getMasterKey();
    expect(k1.equals(k2)).toBe(false);
  });
});

describe("getMasterKey — fail-fast in stdio-server mode", () => {
  beforeEach(() => {
    __resetKeyCache();
    vi.doMock("keytar", () => { throw new Error("unavailable"); });
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
  });
  afterEach(() => {
    vi.doUnmock("keytar");
    delete process.env.PERPLEXITY_MCP_STDIO;
  });

  it("throws structured error when stdio-server flag set", async () => {
    process.env.PERPLEXITY_MCP_STDIO = "1";
    await expect(getMasterKey()).rejects.toThrow(/Vault locked/);
  });
});

import { mkdtempSync, rmSync as rm2 } from "node:fs";
import { tmpdir as tmp2 } from "node:os";
import { join as join2 } from "node:path";
import { Vault } from "../src/vault.js";
import { createProfile as cp } from "../src/profiles.js";

describe("Vault interface", () => {
  let TMP;
  beforeEach(() => {
    TMP = mkdtempSync(join2(tmp2(), "pplx-vault-"));
    process.env.PERPLEXITY_CONFIG_DIR = TMP;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "test-passphrase-xyz";
    __resetKeyCache();
  });
  afterEach(() => {
    rm2(TMP, { recursive: true, force: true });
    delete process.env.PERPLEXITY_CONFIG_DIR;
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
  });

  it("set+get roundtrip", async () => {
    cp("work");
    const v = new Vault();
    await v.set("work", "cookies", JSON.stringify([{ name: "session", value: "abc" }]));
    const got = await v.get("work", "cookies");
    expect(JSON.parse(got)).toEqual([{ name: "session", value: "abc" }]);
  });

  it("get returns null for unknown key", async () => {
    cp("work");
    const v = new Vault();
    expect(await v.get("work", "nothing")).toBeNull();
  });

  it("delete removes a single key", async () => {
    cp("work");
    const v = new Vault();
    await v.set("work", "email", "alice@co.co");
    await v.set("work", "cookies", "[]");
    await v.delete("work", "email");
    expect(await v.get("work", "email")).toBeNull();
    expect(await v.get("work", "cookies")).toBe("[]");
  });

  it("deleteAll removes the whole vault", async () => {
    cp("work");
    const v = new Vault();
    await v.set("work", "cookies", "[]");
    await v.deleteAll("work");
    expect(await v.get("work", "cookies")).toBeNull();
  });
});

describe("vault primitive error paths — key validation", () => {
  it("encryptBlob throws on non-32-byte key", () => {
    expect(() => encryptBlob(Buffer.from("x"), Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it("decryptBlob throws on non-32-byte key", () => {
    expect(() => decryptBlob(Buffer.alloc(50), Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe("vault primitive error paths — blob structure", () => {
  const KEY = Buffer.alloc(32, 7);

  it("decryptBlob throws on too-short blob", () => {
    expect(() => decryptBlob(Buffer.alloc(5), KEY)).toThrow(/too short/i);
  });

  it("decryptBlob throws on missing PXVT magic", () => {
    const bad = Buffer.alloc(50);
    bad.write("NOPE", 0);
    expect(() => decryptBlob(bad, KEY)).toThrow(/magic/i);
  });

  it("decryptBlob throws on unsupported version", () => {
    const good = encryptBlob(Buffer.from("x"), KEY);
    good[4] = 99;  // mangle version byte
    expect(() => decryptBlob(good, KEY)).toThrow(/version/i);
  });
});

describe("getMasterKey — malformed keychain hex fallback", () => {
  beforeEach(() => {
    __resetKeyCache();
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
  });

  it("falls through to env-var when keychain returns wrong-length hex", async () => {
    vi.doMock("keytar", () => ({
      default: {
        getPassword: vi.fn(async () => "too-short"),  // not 64 hex chars
        setPassword: vi.fn(),
      },
    }));
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "fallback-pass";
    const key = await getMasterKey();
    expect(key.length).toBe(32);
    vi.doUnmock("keytar");
  });

  it("falls through to env-var when keychain throws", async () => {
    vi.doMock("keytar", () => ({
      default: {
        getPassword: vi.fn(async () => {
          throw new Error("keychain unavailable");
        }),
        setPassword: vi.fn(),
      },
    }));
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "fallback-pass";
    const key = await getMasterKey();
    expect(key.length).toBe(32);
    vi.doUnmock("keytar");
  });
});

describe("getMasterKey — TTY prompt path", () => {
  beforeEach(() => {
    __resetKeyCache();
    vi.doMock("keytar", () => { throw new Error("unavailable"); });
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    delete process.env.PERPLEXITY_MCP_STDIO;
  });
  afterEach(() => {
    vi.doUnmock("keytar");
    delete process.env.PERPLEXITY_MCP_STDIO;
  });

  it("throws TTY-not-implemented error when stdin.isTTY=true and not in stdio mode", async () => {
    // Temporarily mock process.stdin.isTTY to true
    const originalTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    try {
      await expect(getMasterKey()).rejects.toThrow(/TTY passphrase prompt not yet implemented/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalTTY, configurable: true });
    }
  });
});

describe("readVaultObject — malformed plaintext", () => {
  let TMP3;
  beforeEach(() => {
    TMP3 = mkdtempSync(join2(tmp2(), "pplx-vault-bad-"));
    process.env.PERPLEXITY_CONFIG_DIR = TMP3;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "xyz";
    __resetKeyCache();
  });
  afterEach(() => {
    rm2(TMP3, { recursive: true, force: true });
    delete process.env.PERPLEXITY_CONFIG_DIR;
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
  });

  it("Vault.get returns null when vault holds non-JSON plaintext", async () => {
    // Write a vault with valid encryption but non-JSON plaintext
    const { writeFileSync } = await import("node:fs");
    cp("work");
    const key = await getMasterKey();
    const blob = encryptBlob(Buffer.from("this is not valid json at all"), key);
    const { getProfilePaths } = await import("../src/profiles.js");
    writeFileSync(getProfilePaths("work").vault, blob);
    const v = new Vault();
    expect(await v.get("work", "anything")).toBeNull();
  });
});

describe("Vault profile directory creation", () => {
  let TMP4;
  beforeEach(() => {
    TMP4 = mkdtempSync(join2(tmp2(), "pplx-vault-dir-"));
    process.env.PERPLEXITY_CONFIG_DIR = TMP4;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "test";
    __resetKeyCache();
  });
  afterEach(() => {
    rm2(TMP4, { recursive: true, force: true });
    delete process.env.PERPLEXITY_CONFIG_DIR;
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
  });

  it("set creates profile directory if it does not exist", async () => {
    // Don't create the profile; writeVaultObject should mkdir
    const v = new Vault();
    await v.set("newprof", "key", "value");
    const got = await v.get("newprof", "key");
    expect(got).toBe("value");
  });

  it("deleteAll removes vault when it exists", async () => {
    cp("work");
    const v = new Vault();
    await v.set("work", "key", "value");
    expect(await v.get("work", "key")).toBe("value");
    await v.deleteAll("work");
    expect(await v.get("work", "key")).toBeNull();
  });
});

describe("Vault edge case: keychain returns null then env var fallback", () => {
  beforeEach(() => {
    __resetKeyCache();
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
  });
  afterEach(() => {
    vi.doUnmock("keytar");
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
  });

  it("falls through when keychain getPassword returns null", async () => {
    vi.doMock("keytar", () => ({
      default: {
        getPassword: vi.fn(async () => null),
        setPassword: vi.fn(),
      },
    }));
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "fallback-phrase";
    const key = await getMasterKey();
    expect(key.length).toBe(32);
    vi.doUnmock("keytar");
  });
});

describe("Vault atomicity", () => {
  let TMP;
  beforeEach(() => {
    TMP = mkdtempSync(join2(tmp2(), "pplx-vault-atomic-"));
    process.env.PERPLEXITY_CONFIG_DIR = TMP;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "xyz";
    __resetKeyCache();
  });
  afterEach(() => {
    rm2(TMP, { recursive: true, force: true });
    delete process.env.PERPLEXITY_CONFIG_DIR;
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
  });

  it("leaves no .tmp file behind after a successful write", async () => {
    const { existsSync: exists } = await import("node:fs");
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const v = new Vault();
    await v.set("work", "cookies", "[]");
    const vaultPath = getProfilePaths("work").vault;
    expect(exists(vaultPath)).toBe(true);
    expect(exists(vaultPath + ".tmp")).toBe(false);
  });

  it("overwrites existing vault on subsequent set", async () => {
    cp("work");
    const v = new Vault();
    await v.set("work", "k", "v1");
    await v.set("work", "k", "v2");
    expect(await v.get("work", "k")).toBe("v2");
  });
});
