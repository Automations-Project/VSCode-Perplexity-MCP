export function encryptBlob(plaintext: Buffer, key: Buffer): Buffer;
export function decryptBlob(blob: Buffer, key: Buffer): Buffer;
export function __resetKeyCache(): void;
export function getMasterKey(): Promise<Buffer>;

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
