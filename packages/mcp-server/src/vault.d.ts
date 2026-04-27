export function encryptBlob(plaintext: Buffer, key: Buffer): Buffer;
export function decryptBlob(blob: Buffer, key: Buffer): Buffer;
export function __resetKeyCache(): void;
export function getMasterKey(): Promise<Buffer>;

/**
 * TEST SEAM — drop scrypt cost during tests by overriding the (logN, r, p)
 * parameters used at write time. Reads always use the params embedded in the
 * blob, regardless of any override.
 *
 * Cleared by `__resetKeyCache()` so tests do not leak state across files.
 * MUST NOT be called from production code paths. The decrypt-time floor
 * check (logN >= SCRYPT_LOGN_FLOOR) remains enforced unconditionally.
 */
export function __setKdfParamsForTest(params: { logN: number; r: number; p: number }): void;

/**
 * Sibling of `getMasterKey()` introduced with the v2 vault format. Returns
 * the unseal context WITHOUT prematurely deriving the HKDF key — for v2
 * blobs, key derivation needs the salt embedded in each blob, so it can no
 * longer happen up front. Cached just like `_keyCache`; cleared by
 * `__resetKeyCache()`.
 */
export type UnsealMaterial =
  | { kind: "key"; key: Buffer }
  | { kind: "passphrase"; passphrase: string };

export function getUnsealMaterial(): Promise<UnsealMaterial>;

export class Vault {
  get(profile: string, key: string): Promise<string | null>;
  set(profile: string, key: string, value: string): Promise<void>;
  delete(profile: string, key: string): Promise<void>;
  deleteAll(profile: string): Promise<void>;
}
