import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptBlob, decryptBlob, getMasterKey, __resetKeyCache, __setKdfParamsForTest } from "../src/vault.js";

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
    // Flip a byte well inside the ciphertext region. v3 layout:
    //   [0..3 magic][4 ver][5 kdfid][6 kdfparamslen][7..9 kdfparams][10 saltlen]
    //   [11..26 salt][27..38 iv][39..N-17 ct][N-16..N-1 tag]
    // Offset 40 lands in ciphertext for any plaintext ≥ 2 bytes.
    enc[40] ^= 0x01;
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
    expect(enc[4]).toBe(3); // version: encryptBlob now always emits v3
    expect(enc[5]).toBe(0x01); // KDF_ID = scrypt
    expect(enc[6]).toBe(0x03); // KDF_PARAMS_LEN = 3
    // KDF params at 7..9, SALT_LEN at 10
    expect(enc[10]).toBe(0x10); // SALT_LEN = 16
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

  it("prompts for passphrase when stdin.isTTY=true and not in stdio mode", async () => {
    // Temporarily mock process.stdin.isTTY to true
    const originalTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    // Mock the tty-prompt module so we don't block on real stdin
    vi.doMock("../src/tty-prompt.js", () => ({
      promptSecret: async () => "tty-entered-pass",
    }));

    try {
      const { getMasterKey: gmk, __resetKeyCache: reset } = await import("../src/vault.js");
      reset();
      const key = await gmk();
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.length).toBe(32);
    } finally {
      vi.doUnmock("../src/tty-prompt.js");
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

  it("Vault.get throws a diagnosable error when vault holds non-JSON plaintext", async () => {
    // Write a vault with valid encryption but non-JSON plaintext
    const { writeFileSync } = await import("node:fs");
    cp("work");
    const key = await getMasterKey();
    const blob = encryptBlob(Buffer.from("this is not valid json at all"), key);
    const { getProfilePaths } = await import("../src/profiles.js");
    writeFileSync(getProfilePaths("work").vault, blob);
    const v = new Vault();
    await expect(v.get("work", "anything")).rejects.toThrow(/corrupt|unreadable/i);
  });
});

describe("vault JSON corruption", () => {
  it("throws a diagnosable error when the decrypted vault JSON is corrupt", async () => {
    const configDir = mkdtempSync(join2(tmp2(), "px-corrupt-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "c-pass";
    __resetKeyCache();
    const { createProfile, getProfilePaths } = await import("../src/profiles.js");
    createProfile("default");
    const vault = new Vault();
    const key = await getMasterKey();
    const { writeFileSync } = await import("node:fs");
    const bad = encryptBlob(Buffer.from("definitely-not-json}"), key);
    writeFileSync(getProfilePaths("default").vault, bad);
    await expect(vault.get("default", "cookies")).rejects.toThrow(/corrupt|unreadable/i);
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

// -------------------------------------------------------------------------
// v2 migration tests — see docs/superpowers/specs/2026-04-27-vault-hkdf-migration-design.md
//
// Format reference:
//   v1: [MAGIC "PXVT" 4][VERSION 0x01 1][IV 12][CT n][TAG 16]
//   v2: [MAGIC "PXVT" 4][VERSION 0x02 1][SALT_LEN 0x10 1][SALT 16][IV 12][CT n][TAG 16]
// -------------------------------------------------------------------------
import { createCipheriv, hkdfSync, randomBytes as randBytes } from "node:crypto";
import { readFileSync as readBytes, writeFileSync as writeBytes, statSync } from "node:fs";

const LEGACY_STATIC_SALT_TEST = Buffer.from("perplexity-user-mcp:v1:salt");
const HKDF_INFO = Buffer.from("vault-master-key");

function deriveLegacyKey(passphrase) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(passphrase, "utf8"), LEGACY_STATIC_SALT_TEST, HKDF_INFO, 32));
}

// Build a v1-format vault.enc blob using the legacy static salt (mirrors the
// pre-migration vault.js encryptBlob behaviour exactly).
function buildV1Blob(plaintext, passphrase) {
  const key = deriveLegacyKey(passphrase);
  const iv = randBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("PXVT"), Buffer.from([0x01]), iv, ct, tag]);
}

describe("v2 migration", () => {
  let MIG_TMP;
  beforeEach(() => {
    MIG_TMP = mkdtempSync(join2(tmp2(), "pplx-vault-mig-"));
    process.env.PERPLEXITY_CONFIG_DIR = MIG_TMP;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "migration-pass-A";
    __resetKeyCache();
    // Force the passphrase code path (no keychain) for migration scenarios.
    vi.doMock("keytar", () => { throw new Error("unavailable"); });
    // Drop scrypt cost — writes now emit v3 which invokes scrypt.
    __setKdfParamsForTest({ logN: 12, r: 8, p: 1 });
  });
  afterEach(() => {
    vi.doUnmock("keytar");
    rm2(MIG_TMP, { recursive: true, force: true });
    delete process.env.PERPLEXITY_CONFIG_DIR;
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    __resetKeyCache();
  });

  it("(1) v1 passphrase vault reads successfully after upgrade", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const vaultPath = getProfilePaths("work").vault;
    // Vault.get returns obj[key] verbatim, so store cookies as a string (matches real callers in config.ts).
    const payload = JSON.stringify({ cookies: JSON.stringify([{ name: "session", value: "v1secret" }]) });
    writeBytes(vaultPath, buildV1Blob(payload, "migration-pass-A"));

    const v = new Vault();
    const got = await v.get("work", "cookies");
    expect(JSON.parse(got)).toEqual([{ name: "session", value: "v1secret" }]);
  });

  it("(2) read-only v1 get does not mutate the file", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const vaultPath = getProfilePaths("work").vault;
    const payload = JSON.stringify({ cookies: [{ name: "s", value: "x" }] });
    writeBytes(vaultPath, buildV1Blob(payload, "migration-pass-A"));

    const beforeBytes = readBytes(vaultPath);
    const beforeMtime = statSync(vaultPath).mtimeMs;

    const v = new Vault();
    await v.get("work", "cookies");

    const afterBytes = readBytes(vaultPath);
    const afterMtime = statSync(vaultPath).mtimeMs;
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(afterMtime).toBe(beforeMtime);
    // Header is still v1 — no eager rewrite.
    expect(afterBytes[4]).toBe(0x01);
  });

  it("(3) first write after v1 read writes the latest format (v3) with salt length 0x10", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const vaultPath = getProfilePaths("work").vault;
    const payload = JSON.stringify({ cookies: [{ name: "s", value: "x" }] });
    writeBytes(vaultPath, buildV1Blob(payload, "migration-pass-A"));

    const v = new Vault();
    await v.set("work", "foo", "bar");

    const after = readBytes(vaultPath);
    expect(after.slice(0, 4).toString()).toBe("PXVT");
    expect(after[4]).toBe(0x03); // VERSION_V3 — v3 is the current write format
    // v3 layout: salt-len byte sits at offset 10 (after kdf_id, kdf_params_len, 3 params).
    expect(after[10]).toBe(0x10); // SALT_LEN = 16
  });

  it("(4) second read of migrated v3 vault succeeds", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const vaultPath = getProfilePaths("work").vault;
    const payload = JSON.stringify({ cookies: "original-cookie-string" });
    writeBytes(vaultPath, buildV1Blob(payload, "migration-pass-A"));

    const v = new Vault();
    // Trigger migration via a write.
    await v.set("work", "newkey", "newval");
    // Read both keys back — the v1 cookies value AND the v3-set newkey.
    expect(await v.get("work", "cookies")).toBe("original-cookie-string");
    expect(await v.get("work", "newkey")).toBe("newval");
    // Confirm we are reading v3 now.
    expect(readBytes(vaultPath)[4]).toBe(0x03);
  });

  it("(5) write from scratch emits v3 with 16-byte salt", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const vaultPath = getProfilePaths("work").vault;

    const v = new Vault();
    await v.set("work", "k", "v");

    const blob = readBytes(vaultPath);
    expect(blob.slice(0, 4).toString()).toBe("PXVT");
    expect(blob[4]).toBe(0x03);
    expect(blob[5]).toBe(0x01); // KDF_ID = scrypt
    expect(blob[10]).toBe(0x10); // SALT_LEN at offset 10 in v3
    // Salt occupies bytes 11..27; assert it's not all zeros.
    const salt = blob.slice(11, 11 + 16);
    expect(salt.length).toBe(16);
    expect(salt.equals(Buffer.alloc(16))).toBe(false);
  });

  it("(6) two profiles get different salts", async () => {
    cp("alpha");
    cp("beta");
    const { getProfilePaths } = await import("../src/profiles.js");
    const v = new Vault();
    await v.set("alpha", "k", "v");
    await v.set("beta", "k", "v");

    const aBlob = readBytes(getProfilePaths("alpha").vault);
    const bBlob = readBytes(getProfilePaths("beta").vault);
    // v3 salt offset = 11 (4 magic + 1 ver + 1 kdf_id + 1 kdf_params_len + 3 params + 1 salt_len).
    const aSalt = aBlob.slice(11, 11 + 16);
    const bSalt = bBlob.slice(11, 11 + 16);
    expect(aSalt.length).toBe(16);
    expect(bSalt.length).toBe(16);
    expect(aSalt.equals(bSalt)).toBe(false);
  });

  it("(7) wrong passphrase for v1 throws and leaves file unchanged", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const vaultPath = getProfilePaths("work").vault;
    // Write v1 with passphrase A.
    writeBytes(vaultPath, buildV1Blob(JSON.stringify({ x: 1 }), "migration-pass-A"));
    const beforeBytes = readBytes(vaultPath);

    // Switch passphrase to B.
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "different-pass-B";
    __resetKeyCache();

    const v = new Vault();
    let caught;
    try {
      await v.get("work", "x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // Must NOT be a structural-error wording (truncated/magic/version/salt-length).
    expect(caught.message).not.toMatch(/truncated|wrong magic|unsupported version|invalid salt length/i);
    // Should suggest passphrase / decrypt failure.
    expect(caught.message).toMatch(/decrypt|passphrase|wrong key|corrupted ciphertext/i);

    const afterBytes = readBytes(vaultPath);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
  });

  it("(8) wrong passphrase for current-format vault throws and leaves file unchanged", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const vaultPath = getProfilePaths("work").vault;

    const v = new Vault();
    // Write current format (v3) with passphrase A.
    await v.set("work", "x", "1");
    const beforeBytes = readBytes(vaultPath);

    // Switch passphrase to B.
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "different-pass-B";
    __resetKeyCache();
    // Re-arm the test seam since __resetKeyCache wipes it.
    __setKdfParamsForTest({ logN: 12, r: 8, p: 1 });

    let caught;
    try {
      await v.get("work", "x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).not.toMatch(/truncated|wrong magic|unsupported version|invalid salt length/i);
    expect(caught.message).toMatch(/decrypt|passphrase|wrong key|corrupted ciphertext/i);

    const afterBytes = readBytes(vaultPath);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
  });

  describe("(9) structural errors", () => {
    it("truncated file → distinguishable error", async () => {
      cp("work");
      const { getProfilePaths } = await import("../src/profiles.js");
      writeBytes(getProfilePaths("work").vault, Buffer.alloc(5));
      const v = new Vault();
      let caught;
      try { await v.get("work", "x"); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      expect(caught.message).toMatch(/truncated|too short/i);
      // Must NOT be the wrong-passphrase error.
      expect(caught.message).not.toMatch(/wrong passphrase|corrupted ciphertext/i);
    });

    it("wrong magic header → distinguishable error", async () => {
      cp("work");
      const { getProfilePaths } = await import("../src/profiles.js");
      const bad = Buffer.alloc(64);
      bad.write("NOPE", 0);
      writeBytes(getProfilePaths("work").vault, bad);
      const v = new Vault();
      let caught;
      try { await v.get("work", "x"); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      expect(caught.message).toMatch(/magic/i);
      expect(caught.message).not.toMatch(/wrong passphrase|corrupted ciphertext/i);
    });

    it("unsupported version byte → distinguishable error", async () => {
      cp("work");
      const { getProfilePaths } = await import("../src/profiles.js");
      const bad = Buffer.alloc(64);
      bad.write("PXVT", 0);
      bad[4] = 0x99;
      writeBytes(getProfilePaths("work").vault, bad);
      const v = new Vault();
      let caught;
      try { await v.get("work", "x"); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      expect(caught.message).toMatch(/unsupported.*version|version.*unsupported|version.*99/i);
      expect(caught.message).not.toMatch(/wrong passphrase|corrupted ciphertext/i);
    });

    it("invalid salt length → distinguishable error", async () => {
      cp("work");
      const { getProfilePaths } = await import("../src/profiles.js");
      // Build a v2-shaped blob but with SALT_LEN=0x05 instead of 0x10.
      const bad = Buffer.alloc(80);
      bad.write("PXVT", 0);
      bad[4] = 0x02;
      bad[5] = 0x05; // wrong salt length
      writeBytes(getProfilePaths("work").vault, bad);
      const v = new Vault();
      let caught;
      try { await v.get("work", "x"); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      expect(caught.message).toMatch(/salt.*length|invalid salt/i);
      expect(caught.message).not.toMatch(/wrong passphrase|corrupted ciphertext/i);
    });

    it("tampered ciphertext on v2 → wrong-passphrase-style decrypt error", async () => {
      cp("work");
      const { getProfilePaths } = await import("../src/profiles.js");
      const vaultPath = getProfilePaths("work").vault;
      const v = new Vault();
      await v.set("work", "x", "y");
      const blob = readBytes(vaultPath);
      // Flip a byte well inside the ciphertext region (after header+salt+iv).
      blob[40] ^= 0x01;
      writeBytes(vaultPath, blob);
      let caught;
      try { await v.get("work", "x"); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      // Indistinguishable from wrong key — the AES-GCM tag failure.
      expect(caught.message).toMatch(/decrypt|passphrase|wrong key|corrupted ciphertext/i);
      // But MUST NOT misreport as structural.
      expect(caught.message).not.toMatch(/truncated|wrong magic|unsupported version|invalid salt length/i);
    });
  });

  it("(10) keychain path still works and ignores the salt", async () => {
    // Reset to use a keychain key (32 bytes, hex).
    vi.doUnmock("keytar");
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    __resetKeyCache();
    vi.resetModules();
    const fixedKey = "c".repeat(64);
    vi.doMock("keytar", () => ({
      default: {
        getPassword: vi.fn(async () => fixedKey),
        setPassword: vi.fn(),
      },
    }));
    try {
      const { Vault: V2, __resetKeyCache: reset2, getMasterKey: gmk } = await import("../src/vault.js");
      reset2();
      const { createProfile, getProfilePaths } = await import("../src/profiles.js");
      createProfile("kc");

      const v = new V2();
      await v.set("kc", "cookies", JSON.stringify({ a: 1 }));
      const got = await v.get("kc", "cookies");
      expect(JSON.parse(got)).toEqual({ a: 1 });

      const blob = readBytes(getProfilePaths("kc").vault);
      // Format: v3 (writes always emit the latest format, even on the keychain path).
      expect(blob[4]).toBe(0x03);
      expect(blob[5]).toBe(0x01); // KDF_ID = scrypt (params still embedded for uniformity)
      expect(blob[10]).toBe(0x10); // SALT_LEN at the v3 offset

      // Keychain key is format-independent: deriving the master key directly
      // and asserting it round-trips without involving the on-disk salt.
      const key = await gmk();
      expect(key.length).toBe(32);
      expect(key.toString("hex")).toBe(fixedKey);
    } finally {
      vi.doUnmock("keytar");
    }
  });

  // --- Coverage-completion tests for parseVaultHeader's truncation branches ---
  it("decryptBlob: null blob throws truncated (null-guard branch)", () => {
    expect(() => decryptBlob(null, Buffer.alloc(32, 7))).toThrow(/too short|truncated/i);
  });

  it("decryptBlob: v1 blob with header but truncated tail throws truncated", () => {
    // Valid PXVT magic + version 1, but only 17 bytes (no tag region).
    const bad = Buffer.alloc(17);
    bad.write("PXVT", 0);
    bad[4] = 0x01;
    expect(() => decryptBlob(bad, Buffer.alloc(32, 7))).toThrow(/too short|truncated/i);
  });

  it("decryptBlob: v2 blob 5 bytes long throws truncated v2 header", () => {
    // Magic + version byte but no salt-len byte.
    const bad = Buffer.alloc(5);
    bad.write("PXVT", 0);
    bad[4] = 0x02;
    expect(() => decryptBlob(bad, Buffer.alloc(32, 7))).toThrow(/too short|truncated/i);
  });

  it("decryptBlob: v2 blob with valid salt-len but truncated tail throws truncated v2", () => {
    // Magic + ver 2 + salt-len 16, but total length < V2_HEADER_LEN+TAG.
    const bad = Buffer.alloc(40);
    bad.write("PXVT", 0);
    bad[4] = 0x02;
    bad[5] = 0x10;
    expect(() => decryptBlob(bad, Buffer.alloc(32, 7))).toThrow(/too short|truncated/i);
  });

  it("(11) atomic write failure during migration leaves v1 bytes intact", async () => {
    // Use vi.doMock on safe-write to force the rename to throw on the first
    // write call. This proves the v1 file survives a failed migration.
    vi.resetModules();
    vi.doMock("../src/safe-write.js", () => ({
      safeAtomicWriteFileSync: () => { throw new Error("simulated disk full"); },
    }));
    try {
      const { Vault: V2, __resetKeyCache: reset2 } = await import("../src/vault.js");
      const { createProfile, getProfilePaths } = await import("../src/profiles.js");
      reset2();
      createProfile("work");
      const vaultPath = getProfilePaths("work").vault;
      const payload = JSON.stringify({ cookies: "original-v1" });
      writeBytes(vaultPath, buildV1Blob(payload, "migration-pass-A"));
      const before = readBytes(vaultPath);

      const v = new V2();
      // First confirm read works (v1).
      expect(await v.get("work", "cookies")).toBe("original-v1");

      // Now attempt a write — the mocked safeAtomicWriteFileSync throws.
      let caught;
      try { await v.set("work", "k", "new"); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      expect(caught.message).toMatch(/simulated disk full/);

      // V1 file must be byte-identical.
      const after = readBytes(vaultPath);
      expect(after.equals(before)).toBe(true);
      expect(after[4]).toBe(0x01);
    } finally {
      vi.doUnmock("../src/safe-write.js");
      vi.resetModules();
    }
  });
});

// -------------------------------------------------------------------------
// v3 migration tests — see docs/superpowers/specs/2026-04-28-vault-v3-kdf-stretch-design.md
//
// Format reference:
//   v1: [MAGIC "PXVT" 4][VERSION 0x01 1][IV 12][CT n][TAG 16]
//   v2: [MAGIC "PXVT" 4][VERSION 0x02 1][SALT_LEN 0x10 1][SALT 16][IV 12][CT n][TAG 16]
//   v3: [MAGIC "PXVT" 4][VERSION 0x03 1][KDF_ID 1][KDF_PARAMS_LEN 1][KDF_PARAMS n]
//       [SALT_LEN 0x10 1][SALT 16][IV 12][CT n][TAG 16]
//     KDF_ID = 0x01 (scrypt). KDF_PARAMS for scrypt = [logN 1][r 1][p 1] (3 bytes).
//
// All v3 tests force a low scrypt cost via __setKdfParamsForTest({logN: 12, r: 8, p: 1})
// to keep test runtime tractable. The seam is reset by __resetKeyCache.
// -------------------------------------------------------------------------

function buildV2Blob(plaintext, passphrase) {
  const salt = randBytes(16);
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(passphrase, "utf8"), salt, HKDF_INFO, 32));
  const iv = randBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from("PXVT"),
    Buffer.from([0x02, 0x10]),
    salt,
    iv,
    ct,
    tag,
  ]);
}

describe("v3 migration", () => {
  let MIG_TMP;
  beforeEach(() => {
    MIG_TMP = mkdtempSync(join2(tmp2(), "pplx-vault-mig3-"));
    process.env.PERPLEXITY_CONFIG_DIR = MIG_TMP;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "migration-pass-A";
    __resetKeyCache();
    vi.doMock("keytar", () => { throw new Error("unavailable"); });
    // Drop scrypt cost for the test suite — set logN=12 (~5ms) instead of 17.
    __setKdfParamsForTest({ logN: 12, r: 8, p: 1 });
  });
  afterEach(() => {
    vi.doUnmock("keytar");
    rm2(MIG_TMP, { recursive: true, force: true });
    delete process.env.PERPLEXITY_CONFIG_DIR;
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    __resetKeyCache();
  });

  it("(v3.1) v3 from scratch: writes version 0x03 with kdf_id 0x01 and round-trips", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const v = new Vault();
    await v.set("work", "cookies", "[{\"name\":\"session\",\"value\":\"abc\"}]");
    const blob = readBytes(getProfilePaths("work").vault);
    expect(blob.slice(0, 4).toString()).toBe("PXVT");
    expect(blob[4]).toBe(0x03); // VERSION_V3
    expect(blob[5]).toBe(0x01); // KDF_ID = scrypt
    expect(blob[6]).toBe(0x03); // KDF_PARAMS_LEN = 3 (scrypt: logN, r, p)
    // KDF params: [logN 1][r 1][p 1] at offset 7..10
    // SALT_LEN at offset 7 + KDF_PARAMS_LEN = 10
    expect(blob[10]).toBe(0x10); // SALT_LEN = 16
    // Round-trip
    expect(await v.get("work", "cookies")).toBe("[{\"name\":\"session\",\"value\":\"abc\"}]");
  });

  it("(v3.2) v1 → v3 migration: read v1, write v3, both values round-trip", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const vaultPath = getProfilePaths("work").vault;
    const payload = JSON.stringify({ cookies: "original-v1-string" });
    writeBytes(vaultPath, buildV1Blob(payload, "migration-pass-A"));

    const v = new Vault();
    // Read still works (v1 path).
    expect(await v.get("work", "cookies")).toBe("original-v1-string");
    // The v1 file is unchanged on disk by the read.
    expect(readBytes(vaultPath)[4]).toBe(0x01);

    // Write triggers migration to v3.
    await v.set("work", "newkey", "newval");
    const after = readBytes(vaultPath);
    expect(after[4]).toBe(0x03);
    expect(after[5]).toBe(0x01); // scrypt
    expect(after[6]).toBe(0x03); // params len

    // Subsequent reads use v3 path.
    expect(await v.get("work", "cookies")).toBe("original-v1-string");
    expect(await v.get("work", "newkey")).toBe("newval");
  });

  it("(v3.3) v2 → v3 migration: read v2, write v3, both values round-trip", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const vaultPath = getProfilePaths("work").vault;
    const payload = JSON.stringify({ cookies: "original-v2-string" });
    writeBytes(vaultPath, buildV2Blob(payload, "migration-pass-A"));

    const v = new Vault();
    // Read still works (v2 path).
    expect(await v.get("work", "cookies")).toBe("original-v2-string");
    // The v2 file is unchanged on disk by the read.
    expect(readBytes(vaultPath)[4]).toBe(0x02);

    // Write triggers migration to v3.
    await v.set("work", "newkey", "newval");
    const after = readBytes(vaultPath);
    expect(after[4]).toBe(0x03);
    expect(after[5]).toBe(0x01);
    expect(after[6]).toBe(0x03);

    // Subsequent reads use v3 path.
    expect(await v.get("work", "cookies")).toBe("original-v2-string");
    expect(await v.get("work", "newkey")).toBe("newval");
  });

  it("(v3.4) v3 with corrupted KDF params: invalid kdf_params_len → structural error", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    // v3 header but kdf_params_len = 0 → invalid for scrypt (need 3 bytes).
    const bad = Buffer.alloc(80);
    bad.write("PXVT", 0);
    bad[4] = 0x03;
    bad[5] = 0x01; // KDF_ID scrypt
    bad[6] = 0x00; // KDF_PARAMS_LEN — invalid (must be 3 for scrypt)
    bad[7] = 0x10; // SALT_LEN
    writeBytes(getProfilePaths("work").vault, bad);

    const v = new Vault();
    let caught;
    try { await v.get("work", "x"); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/kdf|params/i);
    // Distinguishable from wrong passphrase / corrupted ciphertext.
    expect(caught.message).not.toMatch(/wrong passphrase|corrupted ciphertext/i);
  });

  it("(v3.4c) v3 with r=0 → structural error, distinguishable from wrong passphrase", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    // Valid v3 header layout but r=0 (invalid scrypt block size).
    const bad = Buffer.alloc(11 + 16 + 12 + 16);
    bad.write("PXVT", 0);
    bad[4] = 0x03;
    bad[5] = 0x01;
    bad[6] = 0x03;
    bad[7] = 17;   // logN — above floor
    bad[8] = 0x00; // r = 0 (invalid)
    bad[9] = 0x01; // p
    bad[10] = 0x10; // SALT_LEN
    writeBytes(getProfilePaths("work").vault, bad);

    const v = new Vault();
    let caught;
    try { await v.get("work", "x"); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/scrypt|invalid|kdf/i);
    expect(caught.message).not.toMatch(/wrong passphrase|corrupted ciphertext/i);
  });

  it("(v3.cov) v3 blob 5 bytes long throws truncated v3 preamble", () => {
    // Magic + version 3 byte, but no kdf_id / kdf_params_len bytes.
    const bad = Buffer.alloc(5);
    bad.write("PXVT", 0);
    bad[4] = 0x03;
    expect(() => decryptBlob(bad, Buffer.alloc(32, 7))).toThrow(/too short|truncated/i);
  });

  it("(v3.cov) __setKdfParamsForTest throws when called without numbers", () => {
    expect(() => __setKdfParamsForTest(null)).toThrow(/requires .*numbers/i);
    expect(() => __setKdfParamsForTest({ logN: "x", r: 8, p: 1 })).toThrow(/requires .*numbers/i);
    expect(() => __setKdfParamsForTest({ logN: 12, r: 8 })).toThrow(/requires .*numbers/i);
  });

  it("(v3.cov) v3 blob truncated mid-KDF-params throws structural error", () => {
    // Magic + ver 3 + kdf_id 1 + kdf_params_len 3, but blob is only 7 bytes total:
    // not enough room for the 3 params bytes + 1 salt-len byte. Must throw.
    const bad = Buffer.alloc(7);
    bad.write("PXVT", 0);
    bad[4] = 0x03;
    bad[5] = 0x01;
    bad[6] = 0x03; // claims 3 bytes of params
    expect(() => decryptBlob(bad, Buffer.alloc(32, 7))).toThrow(/too short|truncated/i);
  });

  it("(v3.cov) v3 blob with invalid salt length throws structural error", () => {
    // Magic + ver 3 + kdf_id 1 + kdf_params_len 3 + (logN, r, p) + salt_len=5 (bad).
    const bad = Buffer.alloc(11 + 16 + 12 + 16);
    bad.write("PXVT", 0);
    bad[4] = 0x03;
    bad[5] = 0x01;
    bad[6] = 0x03;
    bad[7] = 17;
    bad[8] = 8;
    bad[9] = 1;
    bad[10] = 0x05; // wrong salt-len
    expect(() => decryptBlob(bad, Buffer.alloc(32, 7))).toThrow(/salt.*length|invalid salt/i);
  });

  it("(v3.cov) v3 blob with valid header but truncated tail throws structural error", () => {
    // Full header (11 + 16 + 12 = 39 bytes) but no auth tag region.
    const bad = Buffer.alloc(39);
    bad.write("PXVT", 0);
    bad[4] = 0x03;
    bad[5] = 0x01;
    bad[6] = 0x03;
    bad[7] = 17;
    bad[8] = 8;
    bad[9] = 1;
    bad[10] = 0x10;
    expect(() => decryptBlob(bad, Buffer.alloc(32, 7))).toThrow(/too short|truncated/i);
  });

  it("(v3.4d) v3 with unsupported KDF id → structural error", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    // Valid v3 layout but KDF_ID = 0x99 (unsupported).
    const bad = Buffer.alloc(80);
    bad.write("PXVT", 0);
    bad[4] = 0x03;
    bad[5] = 0x99; // unknown KDF
    bad[6] = 0x03;
    bad[7] = 17;
    bad[8] = 8;
    bad[9] = 1;
    bad[10] = 0x10;
    writeBytes(getProfilePaths("work").vault, bad);

    const v = new Vault();
    let caught;
    try { await v.get("work", "x"); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/unsupported.*KDF|KDF.*unsupported/i);
    expect(caught.message).not.toMatch(/wrong passphrase|corrupted ciphertext/i);
  });

  it("(v3.4b) v3 with logN below floor → structural error, distinguishable from wrong passphrase", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    // Reset the test seam so the production floor check is enforced — that's
    // the path under test. Re-derive happens lazily; we never actually call
    // scrypt because the floor check fires first.
    __resetKeyCache();
    // Valid v3 header layout but logN = 8 (below the SCRYPT_LOGN_FLOOR of 16).
    const bad = Buffer.alloc(11 + 16 + 12 + 16); // header + salt + iv + tag (no ct)
    bad.write("PXVT", 0);
    bad[4] = 0x03;
    bad[5] = 0x01;
    bad[6] = 0x03;
    bad[7] = 0x08; // logN = 8 — below floor
    bad[8] = 0x08; // r
    bad[9] = 0x01; // p
    bad[10] = 0x10; // SALT_LEN
    writeBytes(getProfilePaths("work").vault, bad);

    const v = new Vault();
    let caught;
    try { await v.get("work", "x"); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/scrypt|floor|logN|kdf/i);
    expect(caught.message).not.toMatch(/wrong passphrase|corrupted ciphertext/i);
  });

  it("(v3.5) v3 with wrong passphrase → wrong-passphrase-style error, file unchanged", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const vaultPath = getProfilePaths("work").vault;
    const v = new Vault();
    await v.set("work", "x", "1");
    const before = readBytes(vaultPath);

    // Switch passphrase to B.
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "different-pass-B";
    __resetKeyCache();
    // Re-set the test seam since __resetKeyCache cleared it.
    __setKdfParamsForTest({ logN: 12, r: 8, p: 1 });

    let caught;
    try { await v.get("work", "x"); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/wrong passphrase|corrupted ciphertext/i);
    expect(caught.message).not.toMatch(/truncated|wrong magic|unsupported version|invalid salt length|kdf|scrypt/i);

    const after = readBytes(vaultPath);
    expect(after.equals(before)).toBe(true);
  });

  it("(v3.6) two profiles get different salts under v3", async () => {
    cp("alpha");
    cp("beta");
    const { getProfilePaths } = await import("../src/profiles.js");
    const v = new Vault();
    await v.set("alpha", "k", "v");
    await v.set("beta", "k", "v");

    const aBlob = readBytes(getProfilePaths("alpha").vault);
    const bBlob = readBytes(getProfilePaths("beta").vault);
    expect(aBlob[4]).toBe(0x03);
    expect(bBlob[4]).toBe(0x03);
    // Salt at offset 11 (4 magic + 1 ver + 1 kdf_id + 1 kdf_params_len + 3 params + 1 salt_len) for 16 bytes.
    const aSalt = aBlob.slice(11, 11 + 16);
    const bSalt = bBlob.slice(11, 11 + 16);
    expect(aSalt.length).toBe(16);
    expect(bSalt.length).toBe(16);
    expect(aSalt.equals(bSalt)).toBe(false);
  });

  it("(v3.7) keychain path bypasses scrypt — v3 blob round-trips without invoking KDF", async () => {
    // Switch to keychain mode for this test.
    vi.doUnmock("keytar");
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    __resetKeyCache();
    vi.resetModules();

    const fixedKey = "c".repeat(64);
    vi.doMock("keytar", () => ({
      default: {
        getPassword: vi.fn(async () => fixedKey),
        setPassword: vi.fn(),
      },
    }));

    try {
      const { Vault: V2, __resetKeyCache: reset2, getMasterKey: gmk, __setKdfParamsForTest: seam } =
        await import("../src/vault.js");
      reset2();
      // Set the seam to a value BELOW the floor (logN=8). If the keychain
      // path were to invoke scryptDerive, it would either throw (no override
      // active for the in-blob params) or, if the override matched, run an
      // ultra-cheap derivation. Since the keychain path skips scryptDerive
      // entirely, the test seam value is irrelevant — write/read must succeed.
      seam({ logN: 8, r: 8, p: 1 });
      const { createProfile, getProfilePaths } = await import("../src/profiles.js");
      createProfile("kc");

      const v = new V2();
      await v.set("kc", "cookies", JSON.stringify({ a: 1 }));
      const got = await v.get("kc", "cookies");
      expect(JSON.parse(got)).toEqual({ a: 1 });

      // Confirm v3 format is on disk and embeds the (low) params for uniformity.
      const blob = readBytes(getProfilePaths("kc").vault);
      expect(blob[4]).toBe(0x03);
      expect(blob[5]).toBe(0x01); // KDF_ID = scrypt
      expect(blob[7]).toBe(8);    // logN echoed from override (params still embedded)

      const key = await gmk();
      expect(key.length).toBe(32);
      expect(key.toString("hex")).toBe(fixedKey);
    } finally {
      vi.doUnmock("keytar");
    }
  });

  it("(v3.8) re-tuning: blob written with logN=13 reads back fine even after override changes to logN=12", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");

    // First write under logN=13.
    __setKdfParamsForTest({ logN: 13, r: 8, p: 1 });
    const v = new Vault();
    await v.set("work", "k", "first");
    const blob = readBytes(getProfilePaths("work").vault);
    expect(blob[7]).toBe(13); // logN encoded into params

    // Now switch the write-time params to logN=12 — but reads should still use the embedded params.
    __setKdfParamsForTest({ logN: 12, r: 8, p: 1 });
    expect(await v.get("work", "k")).toBe("first");

    // Write a fresh value: emits a new blob with logN=12.
    await v.set("work", "k2", "second");
    const blob2 = readBytes(getProfilePaths("work").vault);
    expect(blob2[7]).toBe(12);
    // Both values still readable.
    expect(await v.get("work", "k")).toBe("first");
    expect(await v.get("work", "k2")).toBe("second");
  });

  it("(v3.9) read-only Vault.get on v3 blob does not mutate the file", async () => {
    cp("work");
    const { getProfilePaths } = await import("../src/profiles.js");
    const vaultPath = getProfilePaths("work").vault;
    const v = new Vault();
    await v.set("work", "x", "y");
    const before = readBytes(vaultPath);
    const beforeMtime = statSync(vaultPath).mtimeMs;

    // Several reads must not touch the file.
    await v.get("work", "x");
    await v.get("work", "x");
    await v.get("work", "x");

    const after = readBytes(vaultPath);
    const afterMtime = statSync(vaultPath).mtimeMs;
    expect(after.equals(before)).toBe(true);
    expect(afterMtime).toBe(beforeMtime);
    expect(after[4]).toBe(0x03);
  });

  it("(v3.10) atomic write failure during v2→v3 migration leaves v2 bytes intact", async () => {
    vi.resetModules();
    vi.doMock("../src/safe-write.js", () => ({
      safeAtomicWriteFileSync: () => { throw new Error("simulated disk full"); },
    }));
    try {
      const { Vault: V2, __resetKeyCache: reset2, __setKdfParamsForTest } = await import("../src/vault.js");
      const { createProfile, getProfilePaths } = await import("../src/profiles.js");
      reset2();
      __setKdfParamsForTest({ logN: 12, r: 8, p: 1 });
      createProfile("work");
      const vaultPath = getProfilePaths("work").vault;
      const payload = JSON.stringify({ cookies: "original-v2" });
      writeBytes(vaultPath, buildV2Blob(payload, "migration-pass-A"));
      const before = readBytes(vaultPath);

      const v = new V2();
      // Read still works (v2 path).
      expect(await v.get("work", "cookies")).toBe("original-v2");

      // Write — mocked safe-write throws.
      let caught;
      try { await v.set("work", "k", "new"); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      expect(caught.message).toMatch(/simulated disk full/);

      // V2 file must be byte-identical.
      const after = readBytes(vaultPath);
      expect(after.equals(before)).toBe(true);
      expect(after[4]).toBe(0x02);
    } finally {
      vi.doUnmock("../src/safe-write.js");
      vi.resetModules();
    }
  });
});
