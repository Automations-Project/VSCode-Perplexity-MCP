import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptBlob, decryptBlob } from "../src/vault.js";

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
