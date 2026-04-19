import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { getProfilePaths } from "./profiles.js";

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
