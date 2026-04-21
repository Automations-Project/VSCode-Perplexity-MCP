import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureToken, getTokenPath, readToken, rotateToken } from "../../src/daemon/token.ts";

describe("daemon token", () => {
  let configDir;
  let tokenPath;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-daemon-token-"));
    tokenPath = getTokenPath(configDir);
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("creates a bearer token on first ensure", () => {
    const record = ensureToken({ tokenPath, now: () => "2026-04-21T00:00:00.000Z" });
    expect(record.version).toBe(1);
    expect(record.bearerToken).toHaveLength(43);
    expect(readToken({ tokenPath })).toEqual(record);
  });

  it("reuses the existing token until rotated", () => {
    const first = ensureToken({ tokenPath, now: () => "2026-04-21T00:00:00.000Z" });
    const second = ensureToken({ tokenPath, now: () => "2026-04-21T01:00:00.000Z" });
    expect(second).toEqual(first);
  });

  it("rotating invalidates the previous bearer", () => {
    const first = ensureToken({ tokenPath, now: () => "2026-04-21T00:00:00.000Z" });
    const rotated = rotateToken({ tokenPath, now: () => "2026-04-21T01:00:00.000Z" });

    expect(rotated.version).toBe(2);
    expect(rotated.createdAt).toBe(first.createdAt);
    expect(rotated.rotatedAt).toBe("2026-04-21T01:00:00.000Z");
    expect(rotated.bearerToken).not.toBe(first.bearerToken);
    expect(readToken({ tokenPath })).toEqual(rotated);
  });

  it("uses 0600 perms on POSIX", () => {
    const record = ensureToken({ tokenPath, now: () => "2026-04-21T00:00:00.000Z" });
    expect(record.version).toBe(1);

    if (process.platform === "win32") {
      expect(readToken({ tokenPath })?.bearerToken).toBe(record.bearerToken);
      return;
    }

    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
