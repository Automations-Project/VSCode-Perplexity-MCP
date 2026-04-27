import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { getProfilePaths } from "./profiles.js";
import { safeAtomicWriteFileSync } from "./safe-write.js";

// -----------------------------------------------------------------------------
// File format
// -----------------------------------------------------------------------------
//
//   v1 (legacy, decrypt-only):
//     [MAGIC "PXVT" 4][VERSION 0x01 1][IV 12][CIPHERTEXT n][AUTHTAG 16]
//   v2 (current, written by all upgraded clients):
//     [MAGIC "PXVT" 4][VERSION 0x02 1][SALT_LEN 0x10 1][SALT 16][IV 12][CIPHERTEXT n][AUTHTAG 16]
//
// Migration discipline (see docs/superpowers/specs/2026-04-27-vault-hkdf-migration-design.md):
//   - Reads NEVER mutate the file. v1 blobs decrypt with the legacy static salt.
//   - Writes ALWAYS emit v2 with a fresh per-vault/per-write 16-byte random salt.
//   - The keychain path is format-independent: the 32-byte keychain key decrypts
//     v1 and v2 blobs alike (the embedded v2 salt is unused on that path).
// -----------------------------------------------------------------------------

const MAGIC = Buffer.from("PXVT");
const VERSION_V1 = 0x01;        // legacy, decrypt-only
const VERSION_V2 = 0x02;        // current, encrypt + decrypt
const VERSION_LATEST = VERSION_V2;
const IV_LEN = 12;
const AUTHTAG_LEN = 16;
const SALT_LEN = 16;
// Preserved for v1 decrypt only. Do not use for new encryption.
const LEGACY_STATIC_SALT = Buffer.from("perplexity-user-mcp:v1:salt");
const HKDF_INFO = Buffer.from("vault-master-key");

const V1_HEADER_LEN = 4 + 1 + IV_LEN;            // 17
const V2_HEADER_LEN = 4 + 1 + 1 + SALT_LEN + IV_LEN; // 34

/**
 * Parse the on-disk vault blob header. Returns the version, embedded salt
 * (v2 only — for v1 the legacy static salt is implied), iv, ciphertext, and
 * auth tag. Throws structural errors that are *distinguishable* from
 * AES-GCM authentication failures, so the caller can tell "wrong passphrase"
 * apart from "this isn't a vault file."
 *
 * @param {Buffer} blob
 * @returns {{version:number, salt:Buffer|null, iv:Buffer, ct:Buffer, tag:Buffer}}
 */
function parseVaultHeader(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 5) {
    throw new Error(`Vault file too short / truncated (${blob ? blob.length : 0} bytes).`);
  }
  if (!blob.slice(0, 4).equals(MAGIC)) {
    // Accept "too short" as a valid description even when magic happens to be wrong:
    // a < V1_HEADER_LEN+TAG buffer can't possibly be a valid vault regardless of magic.
    if (blob.length < V1_HEADER_LEN + AUTHTAG_LEN) {
      throw new Error(`Vault file too short / truncated (${blob.length} bytes, no valid header).`);
    }
    throw new Error("Vault file has wrong magic header — not a Perplexity vault.");
  }
  const version = blob[4];
  if (version === VERSION_V1) {
    if (blob.length < V1_HEADER_LEN + AUTHTAG_LEN) {
      throw new Error(`Vault file too short / truncated (${blob.length} bytes, v1).`);
    }
    const iv = blob.slice(5, 5 + IV_LEN);
    const tag = blob.slice(blob.length - AUTHTAG_LEN);
    const ct = blob.slice(5 + IV_LEN, blob.length - AUTHTAG_LEN);
    return { version, salt: null, iv, ct, tag };
  }
  if (version === VERSION_V2) {
    if (blob.length < 6) {
      throw new Error(`Vault file too short / truncated (${blob.length} bytes, v2 header).`);
    }
    const saltLen = blob[5];
    if (saltLen !== SALT_LEN) {
      throw new Error(`Vault has invalid salt length: ${saltLen} (expected ${SALT_LEN}). Possible corruption.`);
    }
    if (blob.length < V2_HEADER_LEN + AUTHTAG_LEN) {
      throw new Error(`Vault file too short / truncated (${blob.length} bytes, v2).`);
    }
    const salt = blob.slice(6, 6 + SALT_LEN);
    const iv = blob.slice(6 + SALT_LEN, 6 + SALT_LEN + IV_LEN);
    const tag = blob.slice(blob.length - AUTHTAG_LEN);
    const ct = blob.slice(V2_HEADER_LEN, blob.length - AUTHTAG_LEN);
    return { version, salt, iv, ct, tag };
  }
  throw new Error(`Vault uses unsupported version byte: ${version}. Upgrade required.`);
}

/**
 * Derive the AES-256-GCM key from a passphrase + salt via HKDF-SHA256.
 * NOTE: HKDF is NOT a password KDF — it has no work factor. Weak passphrases
 * remain brute-forceable. The randomized per-vault salt thwarts pre-computed
 * rainbow tables (the audit's headline fix); a future v3 may add scrypt/argon2id.
 */
function hkdfFromPassphrase(passphrase, salt) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(passphrase, "utf8"), salt, HKDF_INFO, 32));
}

/**
 * Encrypt `plaintext` with the supplied 32-byte `key` and emit a v2 blob.
 * The embedded salt is fresh per call. Public signature is stable; internal
 * format always emits the latest version.
 *
 * @param {Buffer} plaintext
 * @param {Buffer} key 32-byte AES-256-GCM key.
 * @returns {Buffer}
 */
export function encryptBlob(plaintext, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Vault key must be 32 bytes.");
  }
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([VERSION_V2, SALT_LEN]), salt, iv, ct, tag]);
}

/**
 * Decrypt a vault blob using the supplied 32-byte key. Accepts both v1 and v2
 * formats. The embedded v2 salt is *unused* on this code path — the caller is
 * presumed to already have a directly-usable key (e.g. from the OS keychain).
 * For passphrase-derived keys, the higher-level read path derives the key
 * from the embedded salt before calling here.
 *
 * @param {Buffer} blob
 * @param {Buffer} key 32-byte AES-256-GCM key.
 * @returns {Buffer}
 */
export function decryptBlob(blob, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Vault key must be 32 bytes.");
  }
  const header = parseVaultHeader(blob);
  return aesGcmOpen(header, key);
}

function aesGcmOpen({ iv, ct, tag }, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error(
      "Vault decrypt failed: wrong passphrase or corrupted ciphertext. " +
      "If you recently rotated PERPLEXITY_VAULT_PASSPHRASE or VS Code SecretStorage, restore the original passphrase."
    );
  }
}

const KEYTAR_SERVICE = "perplexity-user-mcp";
const KEYTAR_ACCOUNT = "vault-master-key";

let _keyCache = null;
let _unsealMaterialCache = null;

export function __resetKeyCache() {
  _keyCache = null;
  _unsealMaterialCache = null;
}

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

function isStdioServerMode() {
  return process.env.PERPLEXITY_MCP_STDIO === "1" || (process.stdin && process.stdin.isTTY === false);
}

/**
 * Resolve the unseal context for the vault: either a 32-byte key from the OS
 * keychain, or a passphrase string (env var / TTY / SecretStorage-injected).
 * Cached in `_unsealMaterialCache` to mirror `_keyCache`'s UX trade-off — we
 * do not re-prompt or re-hit the keychain on every vault op. Cleared by
 * `__resetKeyCache()`.
 *
 * Sibling of `getMasterKey()`. The HKDF derivation is now per-vault (because
 * the salt is read off each blob), so unseal material can no longer be
 * pre-derived to a single Buffer at unseal time for passphrase users.
 *
 * @returns {Promise<{kind:"key", key:Buffer}|{kind:"passphrase", passphrase:string}>}
 */
export async function getUnsealMaterial() {
  if (_unsealMaterialCache) return _unsealMaterialCache;

  // 1. OS keychain (returns a real 32-byte key).
  const fromKc = await keyFromKeychain();
  if (fromKc) {
    _unsealMaterialCache = { kind: "key", key: fromKc };
    return _unsealMaterialCache;
  }

  // 2. Env-var passphrase.
  const envPass = process.env.PERPLEXITY_VAULT_PASSPHRASE;
  if (envPass) {
    _unsealMaterialCache = { kind: "passphrase", passphrase: envPass };
    return _unsealMaterialCache;
  }

  // 3. TTY prompt — only when not in stdio-server mode.
  if (!isStdioServerMode() && process.stdin.isTTY) {
    const { promptSecret } = await import("./tty-prompt.js");
    const pass = await promptSecret({ prompt: "Perplexity vault passphrase: " });
    if (pass) {
      _unsealMaterialCache = { kind: "passphrase", passphrase: pass };
      return _unsealMaterialCache;
    }
  }

  // 4. Fail-fast.
  throw new Error(
    "Vault locked: no keychain, no env var, no TTY. " +
    "Three unseal paths on Linux/headless: " +
    "(a) install an OS keychain (libsecret + gnome-keyring) so the MCP process can read it, " +
    "(b) set PERPLEXITY_VAULT_PASSPHRASE in your IDE's MCP server env block, or " +
    "(c) run the VS Code extension's daemon and connect over HTTP transport instead of stdio. " +
    "Codex CLI setup: docs/codex-cli-setup.md. " +
    "Generic vault-unseal docs: docs/vault-unseal.md."
  );
}

/**
 * Return a 32-byte master key. SIGNATURE PRESERVED for back-compat; internal
 * implementation now defers to `getUnsealMaterial()`. For passphrase users,
 * this derives via HKDF + the legacy static salt — which is suitable as a
 * default-derivation entry point but is NOT what the v2 read/write paths use
 * (they derive against the per-blob random salt). Prefer `getUnsealMaterial()`
 * in new code that touches encrypted blobs.
 */
export async function getMasterKey() {
  if (_keyCache) return _keyCache;
  const unseal = await getUnsealMaterial();
  if (unseal.kind === "key") {
    _keyCache = unseal.key;
  } else {
    _keyCache = hkdfFromPassphrase(unseal.passphrase, LEGACY_STATIC_SALT);
  }
  return _keyCache;
}

/**
 * Derive the AES key for a given parsed header + unseal context.
 * - Keychain unseal: always returns the keychain key directly (format-independent).
 * - Passphrase unseal: HKDF over the legacy static salt for v1, embedded salt for v2.
 */
function deriveKeyForHeader(header, unseal) {
  if (unseal.kind === "key") return unseal.key;
  const salt = header.version === VERSION_V1 ? LEGACY_STATIC_SALT : header.salt;
  return hkdfFromPassphrase(unseal.passphrase, salt);
}

async function readVaultObject(profileName) {
  const p = getProfilePaths(profileName).vault;
  if (!existsSync(p)) return {};
  const blob = readFileSync(p);
  const header = parseVaultHeader(blob);
  const unseal = await getUnsealMaterial();
  const key = deriveKeyForHeader(header, unseal);
  const plain = aesGcmOpen(header, key);
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
  const unseal = await getUnsealMaterial();
  // ALWAYS write v2: fresh random salt per write, regardless of unseal source.
  const salt = randomBytes(SALT_LEN);
  const key = unseal.kind === "key"
    ? unseal.key
    : hkdfFromPassphrase(unseal.passphrase, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([MAGIC, Buffer.from([VERSION_V2, SALT_LEN]), salt, iv, ct, tag]);
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
