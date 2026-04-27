import { createCipheriv, createDecipheriv, randomBytes, hkdfSync, scrypt as nodeScrypt } from "node:crypto";
import { promisify } from "node:util";
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
//   v2 (legacy, decrypt-only — superseded by v3):
//     [MAGIC "PXVT" 4][VERSION 0x02 1][SALT_LEN 0x10 1][SALT 16][IV 12][CIPHERTEXT n][AUTHTAG 16]
//   v3 (current, written by all upgraded clients):
//     [MAGIC "PXVT" 4][VERSION 0x03 1][KDF_ID 1][KDF_PARAMS_LEN 1][KDF_PARAMS n]
//     [SALT_LEN 0x10 1][SALT 16][IV 12][CIPHERTEXT n][AUTHTAG 16]
//
//   KDF_ID values:
//     0x01 = scrypt; KDF_PARAMS = [logN 1][r 1][p 1] (3 bytes)
//     0x02 = argon2id (RESERVED — not implemented in this phase)
//
// Migration discipline (see docs/superpowers/specs/2026-04-28-vault-v3-kdf-stretch-design.md):
//   - Reads NEVER mutate the file. v1/v2 blobs decrypt with their respective derivations.
//   - Writes ALWAYS emit v3 with a fresh per-vault/per-write 16-byte random salt and the
//     current KDF defaults (or the test seam override).
//   - The keychain path bypasses scrypt entirely; the 32-byte keychain key decrypts
//     v1/v2/v3 blobs alike (the embedded params/salt are unused on that path).
// -----------------------------------------------------------------------------

const MAGIC = Buffer.from("PXVT");
const VERSION_V1 = 0x01;        // legacy, decrypt-only
const VERSION_V2 = 0x02;        // legacy, decrypt-only after v3 ships
const VERSION_V3 = 0x03;        // current, encrypt + decrypt
const VERSION_LATEST = VERSION_V3;
const IV_LEN = 12;
const AUTHTAG_LEN = 16;
const SALT_LEN = 16;

// KDF identifiers — 1-byte namespace for "what KDF turns a passphrase into a key."
const KDF_ID_SCRYPT = 0x01;
// const KDF_ID_ARGON2ID = 0x02; // reserved; not implemented in this phase

// scrypt parameters and limits
const SCRYPT_LOGN_DEFAULT = 17;        // N = 131072 (~300ms on a 2020 laptop)
const SCRYPT_R_DEFAULT = 8;            // 1 MiB block
const SCRYPT_P_DEFAULT = 1;            // single-threaded
const SCRYPT_LOGN_FLOOR = 16;          // refuse to use anything weaker (decrypt-time check)
const SCRYPT_MAXMEM = 256 * 1024 * 1024; // 256 MiB cap (2× the actual peak at logN=17)
const SCRYPT_PARAMS_LEN = 3;           // bytes used to encode (logN, r, p)

// Preserved for v1 decrypt only. Do not use for new encryption.
const LEGACY_STATIC_SALT = Buffer.from("perplexity-user-mcp:v1:salt");
const HKDF_INFO = Buffer.from("vault-master-key");

const V1_HEADER_LEN = 4 + 1 + IV_LEN;            // 17
const V2_HEADER_LEN = 4 + 1 + 1 + SALT_LEN + IV_LEN; // 34
// v3 header length (with scrypt params) = 4 + 1 + 1 + 1 + 3 + 1 + 16 + 12 = 39
const V3_HEADER_FIXED_PREAMBLE = 4 + 1 + 1 + 1; // magic + ver + kdf_id + kdf_params_len = 7

// Promisified scrypt — Node's callback-based API wrapped once at module load.
const scryptAsync = promisify(nodeScrypt);

// Test seam (Q2): module-level override for KDF params at write time. Reads
// always use the params embedded in the blob. Cleared by `__resetKeyCache`.
//
// `_kdfTestModeActive` is a separate flag that, once any seam call has been
// made in this process, suppresses the decrypt-time floor check so tests can
// round-trip blobs at logN below the production floor. Production code never
// sets the seam, so the floor remains enforced. Cleared by `__resetKeyCache`.
let _kdfParamsOverride = null;
let _kdfTestModeActive = false;

/**
 * TEST SEAM — drop scrypt cost during tests by setting (logN, r, p).
 * MUST NOT be called in production code paths. Cleared by `__resetKeyCache()`.
 *
 * Encrypt path uses the override when set (so tests can write blobs with
 * logN=12 in ~5ms instead of logN=17 in ~300ms). Decrypt path always uses the
 * params embedded in the blob, regardless of any override. The decrypt-time
 * floor check (logN >= SCRYPT_LOGN_FLOOR) is enforced unconditionally.
 *
 * @param {{logN:number, r:number, p:number}} params
 */
export function __setKdfParamsForTest(params) {
  if (!params || typeof params.logN !== "number" || typeof params.r !== "number" || typeof params.p !== "number") {
    throw new Error("__setKdfParamsForTest requires {logN, r, p} numbers.");
  }
  _kdfParamsOverride = { logN: params.logN, r: params.r, p: params.p };
  _kdfTestModeActive = true;
}

function getActiveKdfParams() {
  return _kdfParamsOverride ?? {
    logN: SCRYPT_LOGN_DEFAULT,
    r: SCRYPT_R_DEFAULT,
    p: SCRYPT_P_DEFAULT,
  };
}

/**
 * Parse the on-disk vault blob header. Returns the version, KDF identifier
 * and parameters (v3 only), embedded salt (v2/v3), iv, ciphertext, and auth
 * tag. Throws structural errors that are *distinguishable* from AES-GCM
 * authentication failures, so the caller can tell "wrong passphrase" apart
 * from "this isn't a vault file."
 *
 * @param {Buffer} blob
 * @returns {{version:number, kdfId:number|null, kdfParams:object|null, salt:Buffer|null, iv:Buffer, ct:Buffer, tag:Buffer}}
 */
function parseVaultHeader(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 5) {
    throw new Error(`Vault file too short / truncated (${blob ? blob.length : 0} bytes).`);
  }
  if (!blob.slice(0, 4).equals(MAGIC)) {
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
    return { version, kdfId: null, kdfParams: null, salt: null, iv, ct, tag };
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
    return { version, kdfId: null, kdfParams: null, salt, iv, ct, tag };
  }
  if (version === VERSION_V3) {
    // Need at least: magic(4)+ver(1)+kdf_id(1)+kdf_params_len(1) = 7 bytes.
    if (blob.length < V3_HEADER_FIXED_PREAMBLE) {
      throw new Error(`Vault file too short / truncated (${blob.length} bytes, v3 preamble).`);
    }
    const kdfId = blob[5];
    const kdfParamsLen = blob[6];
    if (kdfId === KDF_ID_SCRYPT) {
      if (kdfParamsLen !== SCRYPT_PARAMS_LEN) {
        throw new Error(
          `Vault has invalid KDF params length: ${kdfParamsLen} (expected ${SCRYPT_PARAMS_LEN} for scrypt). Possible corruption.`
        );
      }
    } else {
      // Reserved or unknown KDF — KDF_ID 0x00 (invalid) and 0x02..0xFF are not implemented here.
      throw new Error(
        `Vault uses unsupported KDF id: 0x${kdfId.toString(16).padStart(2, "0")}.`
      );
    }
    // Now we know how many params bytes to consume.
    const kdfParamsStart = V3_HEADER_FIXED_PREAMBLE; // 7
    const kdfParamsEnd = kdfParamsStart + kdfParamsLen; // 10 for scrypt
    if (blob.length < kdfParamsEnd + 1) {
      throw new Error(`Vault file too short / truncated (${blob.length} bytes, v3 KDF params).`);
    }
    const kdfParamsBytes = blob.slice(kdfParamsStart, kdfParamsEnd);
    let kdfParams;
    if (kdfId === KDF_ID_SCRYPT) {
      kdfParams = {
        logN: kdfParamsBytes[0],
        r: kdfParamsBytes[1],
        p: kdfParamsBytes[2],
      };
    }
    const saltLenOffset = kdfParamsEnd;
    const saltLen = blob[saltLenOffset];
    if (saltLen !== SALT_LEN) {
      throw new Error(`Vault has invalid salt length: ${saltLen} (expected ${SALT_LEN}). Possible corruption.`);
    }
    const saltStart = saltLenOffset + 1;
    const ivStart = saltStart + SALT_LEN;
    const ctStart = ivStart + IV_LEN;
    const fullHeaderAndTag = ctStart + AUTHTAG_LEN;
    if (blob.length < fullHeaderAndTag) {
      throw new Error(`Vault file too short / truncated (${blob.length} bytes, v3).`);
    }
    const salt = blob.slice(saltStart, saltStart + SALT_LEN);
    const iv = blob.slice(ivStart, ctStart);
    const tag = blob.slice(blob.length - AUTHTAG_LEN);
    const ct = blob.slice(ctStart, blob.length - AUTHTAG_LEN);
    return { version, kdfId, kdfParams, salt, iv, ct, tag };
  }
  throw new Error(`Vault uses unsupported version byte: ${version}. Upgrade required.`);
}

/**
 * Derive the AES-256-GCM key from a passphrase + salt via HKDF-SHA256.
 * NOTE: HKDF is NOT a password KDF — it has no work factor. Used only for v1
 * (legacy static salt) and v2 (per-blob random salt) decrypt paths. v3 uses
 * scrypt; see `scryptDerive`.
 */
function hkdfFromPassphrase(passphrase, salt) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(passphrase, "utf8"), salt, HKDF_INFO, 32));
}

/**
 * Derive the AES-256-GCM key from a passphrase + salt via scrypt with the
 * provided parameters. Enforces the security floor (logN >= 16) before
 * invoking the KDF; an attacker who tampers with disk to force weak params
 * is rejected here.
 *
 * The test seam (`__setKdfParamsForTest`) bypasses the floor check while
 * active so tests can write/read fast blobs at logN=12 without hitting the
 * production guardrail. In production the override is null and the floor
 * check is unconditional.
 */
async function scryptDerive(passphrase, salt, params) {
  const { logN, r, p } = params;
  // The decrypt-time floor check is unconditional in production. Tests that
  // need to write/read fast blobs (logN < 16) call `__setKdfParamsForTest`,
  // which flips `_kdfTestModeActive` on for this process and suppresses the
  // floor. The flag is cleared by `__resetKeyCache`, so a stray test seam
  // call cannot leak past suite boundaries.
  //
  // Tampered-production-blob protection (v3.4b): production code never calls
  // the seam, so `_kdfTestModeActive` stays false; an attacker who flips logN
  // to 8 on disk hits this branch and the derivation is refused.
  if (!_kdfTestModeActive && logN < SCRYPT_LOGN_FLOOR) {
    throw new Error(
      `Vault scrypt parameters below security floor (logN=${logN} < ${SCRYPT_LOGN_FLOOR}). Refusing to derive.`
    );
  }
  if (r < 1 || p < 1) {
    throw new Error(`Vault scrypt parameters invalid (r=${r}, p=${p}).`);
  }
  const N = 1 << logN;
  const key = await scryptAsync(Buffer.from(passphrase, "utf8"), salt, 32, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
  return Buffer.from(key);
}

/**
 * Encrypt `plaintext` with the supplied 32-byte `key` and emit a v3 blob.
 * The embedded salt is fresh per call and the active KDF params are encoded
 * into the header — but the KDF itself is NOT invoked here (caller passes a
 * pre-derived 32-byte key). Public signature is stable; internal format
 * always emits the latest version.
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
  const params = getActiveKdfParams();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION_V3, KDF_ID_SCRYPT, SCRYPT_PARAMS_LEN, params.logN, params.r, params.p, SALT_LEN]),
    salt,
    iv,
    ct,
    tag,
  ]);
}

/**
 * Decrypt a vault blob using the supplied 32-byte key. Accepts v1, v2, and v3
 * formats. The embedded salt + KDF params on v2/v3 are *unused* on this code
 * path — the caller is presumed to already have a directly-usable key (e.g.
 * from the OS keychain). For passphrase-derived keys, the higher-level read
 * path derives the key from the embedded salt+params before calling here.
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

/**
 * Reset the in-memory caches (key, unseal material, and the test-seam KDF
 * params override). Called on profile-state changes (account switch, login,
 * logout) and from tests to ensure isolation.
 */
export function __resetKeyCache() {
  _keyCache = null;
  _unsealMaterialCache = null;
  _kdfParamsOverride = null;
  _kdfTestModeActive = false;
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
 * Sibling of `getMasterKey()`. Key derivation is per-blob (the salt is read
 * off each blob and, for v3, fed into scrypt with the embedded params), so
 * unseal material can no longer be pre-derived to a single Buffer at unseal
 * time for passphrase users.
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
 * default-derivation entry point but is NOT what the v2/v3 read/write paths
 * use (they derive against the per-blob random salt, with v3 also stretching
 * via scrypt). Prefer `getUnsealMaterial()` in new code that touches
 * encrypted blobs.
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
 * - Passphrase unseal:
 *     v1: HKDF over the legacy static salt
 *     v2: HKDF over the embedded salt
 *     v3: scrypt over the embedded salt with the embedded params
 *
 * Defensive checks (`header.version === VERSION_V3 && kdfId !== KDF_ID_SCRYPT`,
 * unsupported version) are performed in `parseVaultHeader`, so this function
 * trusts its input. Only one branch each per version path here.
 */
async function deriveKeyForHeader(header, unseal) {
  if (unseal.kind === "key") return unseal.key;
  if (header.version === VERSION_V1) {
    return hkdfFromPassphrase(unseal.passphrase, LEGACY_STATIC_SALT);
  }
  if (header.version === VERSION_V2) {
    return hkdfFromPassphrase(unseal.passphrase, header.salt);
  }
  // header.version === VERSION_V3 — parseVaultHeader has already validated
  // kdfId/kdfParams, so we go straight to scrypt.
  return scryptDerive(unseal.passphrase, header.salt, header.kdfParams);
}

async function readVaultObject(profileName) {
  const p = getProfilePaths(profileName).vault;
  if (!existsSync(p)) return {};
  const blob = readFileSync(p);
  const header = parseVaultHeader(blob);
  const unseal = await getUnsealMaterial();
  const key = await deriveKeyForHeader(header, unseal);
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
  // ALWAYS write v3: fresh random salt per write, current scrypt defaults
  // (or the test-seam override). Keychain users skip the KDF but still emit
  // the same uniform v3 format with the params bytes for forward compatibility.
  const salt = randomBytes(SALT_LEN);
  const params = getActiveKdfParams();
  const key = unseal.kind === "key"
    ? unseal.key
    : await scryptDerive(unseal.passphrase, salt, params);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([
    MAGIC,
    Buffer.from([VERSION_V3, KDF_ID_SCRYPT, SCRYPT_PARAMS_LEN, params.logN, params.r, params.p, SALT_LEN]),
    salt,
    iv,
    ct,
    tag,
  ]);
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
