export function encryptBlob(plaintext: Buffer, key: Buffer): Buffer;
export function decryptBlob(blob: Buffer, key: Buffer): Buffer;
export function __resetKeyCache(): void;
export function getMasterKey(): Promise<Buffer>;

export class Vault {
  get(profile: string, key: string): Promise<string | null>;
  set(profile: string, key: string, value: string): Promise<void>;
  delete(profile: string, key: string): Promise<void>;
  deleteAll(profile: string): Promise<void>;
}
