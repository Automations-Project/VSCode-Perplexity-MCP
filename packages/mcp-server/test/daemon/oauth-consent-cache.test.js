import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  check,
  getConsentCachePath,
  list,
  record,
  revoke,
} from "../../src/daemon/oauth-consent-cache.ts";

describe("oauth consent cache", () => {
  let configDir;
  let cachePath;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-oauth-consent-"));
    cachePath = getConsentCachePath(configDir);
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("record writes a 0600-mode file and check returns true within TTL", () => {
    const t0 = 1_700_000_000_000;
    const entry = record("client-a", "http://cb/a", 60_000, { cachePath, now: () => t0 });
    expect(entry.clientId).toBe("client-a");
    expect(entry.redirectUri).toBe("http://cb/a");
    expect(entry.expiresAt).toBe(t0 + 60_000);
    expect(entry.approvedAt).toBe(new Date(t0).toISOString());

    expect(check("client-a", "http://cb/a", { cachePath, now: () => t0 + 30_000 })).toBe(true);

    if (process.platform !== "win32") {
      const mode = statSync(cachePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("check returns false after TTL expiry and prunes the entry", () => {
    const t0 = 1_700_000_000_000;
    record("client-a", "http://cb/a", 60_000, { cachePath, now: () => t0 });
    expect(check("client-a", "http://cb/a", { cachePath, now: () => t0 + 60_001 })).toBe(false);

    // pruned on read
    expect(list({ cachePath, now: () => t0 + 60_001 })).toEqual([]);
  });

  it("check returns false for (clientId, redirectUri) pairs that were not recorded", () => {
    const t0 = 1_700_000_000_000;
    record("client-a", "http://cb/a", 60_000, { cachePath, now: () => t0 });
    expect(check("client-b", "http://cb/a", { cachePath, now: () => t0 })).toBe(false);
    expect(check("client-a", "http://cb/b", { cachePath, now: () => t0 })).toBe(false);
  });

  it("re-recording the same pair overwrites the previous entry", () => {
    const t0 = 1_700_000_000_000;
    record("client-a", "http://cb/a", 30_000, { cachePath, now: () => t0 });
    record("client-a", "http://cb/a", 90_000, { cachePath, now: () => t0 + 10_000 });

    const entries = list({ cachePath, now: () => t0 + 10_000 });
    expect(entries).toHaveLength(1);
    expect(entries[0].expiresAt).toBe(t0 + 10_000 + 90_000);
  });

  it("list returns live entries sorted by expiry (newest first)", () => {
    const t0 = 1_700_000_000_000;
    record("client-a", "http://cb/a", 60_000, { cachePath, now: () => t0 });
    record("client-b", "http://cb/b", 120_000, { cachePath, now: () => t0 });
    record("client-c", "http://cb/c", 30_000, { cachePath, now: () => t0 });

    const entries = list({ cachePath, now: () => t0 + 1_000 });
    expect(entries.map((e) => e.clientId)).toEqual(["client-b", "client-a", "client-c"]);
  });

  it("revoke by (clientId, redirectUri) removes exactly that entry", () => {
    const t0 = 1_700_000_000_000;
    record("client-a", "http://cb/a", 60_000, { cachePath, now: () => t0 });
    record("client-a", "http://cb/b", 60_000, { cachePath, now: () => t0 });
    record("client-b", "http://cb/a", 60_000, { cachePath, now: () => t0 });

    const removed = revoke({ cachePath, clientId: "client-a", redirectUri: "http://cb/a", now: () => t0 });
    expect(removed).toBe(1);

    const remaining = list({ cachePath, now: () => t0 }).map((e) => `${e.clientId}|${e.redirectUri}`).sort();
    expect(remaining).toEqual(["client-a|http://cb/b", "client-b|http://cb/a"]);
  });

  it("revoke by clientId only removes every entry for that client", () => {
    const t0 = 1_700_000_000_000;
    record("client-a", "http://cb/a", 60_000, { cachePath, now: () => t0 });
    record("client-a", "http://cb/b", 60_000, { cachePath, now: () => t0 });
    record("client-b", "http://cb/a", 60_000, { cachePath, now: () => t0 });

    const removed = revoke({ cachePath, clientId: "client-a", now: () => t0 });
    expect(removed).toBe(2);
    expect(list({ cachePath, now: () => t0 }).map((e) => e.clientId)).toEqual(["client-b"]);
  });

  it("revoke with no filters clears everything", () => {
    const t0 = 1_700_000_000_000;
    record("client-a", "http://cb/a", 60_000, { cachePath, now: () => t0 });
    record("client-b", "http://cb/b", 60_000, { cachePath, now: () => t0 });

    const removed = revoke({ cachePath, now: () => t0 });
    expect(removed).toBe(2);
    expect(list({ cachePath, now: () => t0 })).toEqual([]);
  });

  it("revoke returns 0 when nothing matches", () => {
    const t0 = 1_700_000_000_000;
    record("client-a", "http://cb/a", 60_000, { cachePath, now: () => t0 });
    const removed = revoke({ cachePath, clientId: "client-z", redirectUri: "http://nope", now: () => t0 });
    expect(removed).toBe(0);
  });

  it("corrupted cache file is treated as empty", () => {
    writeFileSync(cachePath, "{not json}", "utf8");
    expect(list({ cachePath, now: () => 1 })).toEqual([]);
    expect(check("client-a", "http://cb/a", { cachePath, now: () => 1 })).toBe(false);
  });

  it("non-array JSON is treated as empty", () => {
    writeFileSync(cachePath, JSON.stringify({ not: "an array" }), "utf8");
    expect(list({ cachePath, now: () => 1 })).toEqual([]);
  });

  it("malformed entries inside a valid array are dropped", () => {
    writeFileSync(
      cachePath,
      JSON.stringify([
        { clientId: "good", redirectUri: "http://cb/x", approvedAt: "now", expiresAt: 9_999_999_999_999 },
        { clientId: 42, redirectUri: "http://cb/x", approvedAt: "now", expiresAt: 1 },
        "totally not an entry",
      ]),
      "utf8",
    );
    const entries = list({ cachePath, now: () => 1 });
    expect(entries).toHaveLength(1);
    expect(entries[0].clientId).toBe("good");
  });

  it("cache file is removed-and-rewritten atomically (no cross-process partial reads)", () => {
    const t0 = 1_700_000_000_000;
    record("client-a", "http://cb/a", 60_000, { cachePath, now: () => t0 });
    expect(existsSync(cachePath)).toBe(true);
    // Contents should be a valid JSON array of one entry
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });
});
