import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { getProfilePaths } from "./profiles.js";
import { safeAtomicWriteFileSync } from "./safe-write.js";

const MAGIC = Buffer.from("PXVT");
const VERSION = 1;
const IV_LEN = 12;
const AUTHTAG_LEN = 16;

/**
 * File layout: [MAGIC 4][VERSION 1][IV 12][CIPHERTEXT n][AUTHTAG 16]
 */
export function encryptBlob(plaintext, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Vault key must be 32 bytes.");
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, ct, tag]);
}

export function decryptBlob(blob, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Vault key must be 32 bytes.");
  }
  if (blob.length < 4 + 1 + IV_LEN + AUTHTAG_LEN) {
    throw new Error("Vault blob too short.");
  }
  if (!blob.slice(0, 4).equals(MAGIC)) {
    throw new Error("Vault blob missing magic header — not a PXVT vault.");
  }
  const version = blob[4];
  if (version !== VERSION) {
    throw new Error(`Unsupported vault version: ${version}`);
  }
  const iv = blob.slice(5, 5 + IV_LEN);
  const tag = blob.slice(blob.length - AUTHTAG_LEN);
  const ct = blob.slice(5 + IV_LEN, blob.length - AUTHTAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    throw new Error("Vault decrypt failed: wrong key or corrupted blob.");
  }
}

const KEYTAR_SERVICE = "perplexity-user-mcp";
const KEYTAR_ACCOUNT = "vault-master-key";

let _keyCache = null;

export function __resetKeyCache() { _keyCache = null; }

async function tryKeytar() {
  try {
    const mod = await import("keytar");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function keyFromKeychain() {
  const keytar = await tryKeytar();
  if (!keytar) return null;
  try {
    let hex = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    if (!hex) {
      // Generate + persist
      const fresh = randomBytes(32);
      hex = fresh.toString("hex");
      await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, hex);
    }
    const buf = Buffer.from(hex, "hex");
    if (buf.length !== 32) return null;
    return buf;
  } catch {
    return null;
  }
}

function hkdfFromPassphrase(passphrase) {
  const salt = Buffer.from("perplexity-user-mcp:v1:salt");
  const info = Buffer.from("vault-master-key");
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(passphrase, "utf8"), salt, info, 32));
  return key;
}

function isStdioServerMode() {
  return process.env.PERPLEXITY_MCP_STDIO === "1" || (process.stdin && process.stdin.isTTY === false);
}

export async function getMasterKey() {
  if (_keyCache) return _keyCache;

  // 1. OS keychain
  const fromKc = await keyFromKeychain();
  if (fromKc) {
    _keyCache = fromKc;
    return fromKc;
  }

  // 2. Env-var passphrase
  const envPass = process.env.PERPLEXITY_VAULT_PASSPHRASE;
  if (envPass) {
    _keyCache = hkdfFromPassphrase(envPass);
    return _keyCache;
  }

  // 3. TTY prompt — ONLY when not in stdio-server mode
  if (!isStdioServerMode() && process.stdin.isTTY) {
    const { promptSecret } = await import("./tty-prompt.js");
    const pass = await promptSecret({ prompt: "Perplexity vault passphrase: " });
    if (pass) {
      _keyCache = hkdfFromPassphrase(pass);
      return _keyCache;
    }
  }

  // 4. Fail-fast
  throw new Error(
    "Vault locked: no keychain, no env var, no TTY. " +
    "Install OS keychain (libsecret on Linux) or set " +
    "PERPLEXITY_VAULT_PASSPHRASE in your IDE's MCP config. " +
    "See https://github.com/<OWNER>/perplexity-user-mcp/blob/main/docs/vault-unseal.md"
  );
}

async function readVaultObject(profileName) {
  const p = getProfilePaths(profileName).vault;
  if (!existsSync(p)) return {};
  const key = await getMasterKey();
  const blob = readFileSync(p);
  const plain = decryptBlob(blob, key);
  try {
    return JSON.parse(plain.toString("utf8"));
  } catch (err) {
    const { redact } = await import("./redact.js");
    console.error(`[vault] Corrupt vault JSON for profile ${redact(profileName)}: ${redact(err.message)}`);
    throw new Error(`Vault for profile '${profileName}' is corrupt or unreadable.`);
  }
}

async function writeVaultObject(profileName, obj) {
  const paths = getProfilePaths(profileName);
  if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true });
  const key = await getMasterKey();
  const blob = encryptBlob(Buffer.from(JSON.stringify(obj)), key);
  safeAtomicWriteFileSync(paths.vault, blob);
}

export class Vault {
  async get(profile, key) {
    const obj = await readVaultObject(profile);
    return obj[key] ?? null;
  }
  async set(profile, key, value) {
    const obj = await readVaultObject(profile);
    obj[key] = value;
    await writeVaultObject(profile, obj);
  }
  async delete(profile, key) {
    const obj = await readVaultObject(profile);
    delete obj[key];
    await writeVaultObject(profile, obj);
  }
  async deleteAll(profile) {
    const p = getProfilePaths(profile).vault;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}
