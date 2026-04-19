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
