import { describe, it, expect } from "vitest";
import {
  redactPem,
  redactDiagnosticsString,
  redactDiagnosticsObject,
  redactMessage,
  redactObject,
} from "../src/diagnostics/redact.js";

const SAMPLE_PEM = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7QqVh8SrUp4Jm4s4Zv5K",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "-----END CERTIFICATE-----",
].join("\n");

const SAMPLE_RSA = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAxyzabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

const SAMPLE_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0000000000000000",
  "-----END PRIVATE KEY-----",
].join("\n");

describe("diagnostics redact", () => {
  describe("redactPem", () => {
    it("replaces a CERTIFICATE block with <redacted:pem>", () => {
      const out = redactPem(`prefix\n${SAMPLE_PEM}\nsuffix`);
      expect(out).toContain("<redacted:pem>");
      expect(out).not.toContain("BEGIN CERTIFICATE");
      expect(out).not.toContain("aaaaaaaaaaaaaaaa");
      expect(out).toContain("prefix");
      expect(out).toContain("suffix");
    });

    it("replaces an RSA PRIVATE KEY block", () => {
      const out = redactPem(SAMPLE_RSA);
      expect(out).toBe("<redacted:pem>");
    });

    it("replaces a PRIVATE KEY block", () => {
      const out = redactPem(SAMPLE_PRIVATE_KEY);
      expect(out).toBe("<redacted:pem>");
    });

    it("replaces multiple PEM blocks in one string", () => {
      const joined = `${SAMPLE_PEM}\n---\n${SAMPLE_RSA}`;
      const out = redactPem(joined);
      const matches = out.match(/<redacted:pem>/g) ?? [];
      expect(matches.length).toBe(2);
      expect(out).not.toMatch(/BEGIN/);
    });

    it("leaves non-PEM content alone", () => {
      const text = "just a regular log line\nwith multiple\r\nlines and stuff";
      expect(redactPem(text)).toBe(text);
    });
  });

  describe("redactDiagnosticsString", () => {
    it("calls PEM redactor before token redactor", () => {
      // PEM body contains a long base64 blob that the generic long-token
      // rule would otherwise shred. We want PEM to win first so the whole
      // block becomes a single <redacted:pem>, not a partial <redacted> in
      // the middle of a cert that still leaks its envelope.
      const out = redactDiagnosticsString(`cert=${SAMPLE_PEM}`);
      expect(out).toContain("<redacted:pem>");
      expect(out).not.toContain("BEGIN CERTIFICATE");
      // The long-token rule should not run inside a PEM body that is
      // already collapsed into the placeholder.
      expect(out).not.toContain("aaaaaaaaaaaa");
    });

    it("still runs the generic message redactor for secrets outside PEM", () => {
      const input = `user ${"pplx_at_ABCDEFGHIJ1234567890"} reported`;
      const out = redactDiagnosticsString(input);
      expect(out).toContain("<redacted:oauth-access>");
    });

    it("is a no-op on innocuous strings", () => {
      expect(redactDiagnosticsString("hello world")).toBe("hello world");
    });
  });

  describe("redactDiagnosticsObject", () => {
    it("redacts PEM embedded in nested object strings", () => {
      const input = {
        tunnels: [
          { name: "cf", cert: SAMPLE_PEM, note: "ok" },
        ],
        meta: { key: SAMPLE_RSA },
      };
      const out = redactDiagnosticsObject(input);
      const serialised = JSON.stringify(out);
      expect(serialised).toContain("<redacted:pem>");
      expect(serialised).not.toContain("BEGIN CERTIFICATE");
      expect(serialised).not.toContain("BEGIN RSA PRIVATE KEY");
    });

    it("composes with the base object redactor for non-PEM secrets", () => {
      const input = { bearerToken: "A".repeat(40), port: 7764 };
      const out = redactDiagnosticsObject(input) as any;
      expect(out.bearerToken).toBe("<redacted:daemon-bearer>");
      expect(out.port).toBe(7764);
    });

    it("re-exports redactMessage and redactObject from base redact", () => {
      expect(typeof redactMessage).toBe("function");
      expect(typeof redactObject).toBe("function");
    });
  });
});
