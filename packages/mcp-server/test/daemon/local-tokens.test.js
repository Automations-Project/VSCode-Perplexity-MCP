import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync as realWriteFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vi.mock is hoisted; factories proxy to real modules so the module under
// test gets spy-able namespaces for node:crypto and node:fs.
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual("node:crypto");
  return { ...actual };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return { ...actual };
});

import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import {
  issueLocalToken,
  listLocalTokens,
  revokeLocalToken,
  verifyLocalToken,
} from "../../src/daemon/local-tokens.ts";

const TOKEN_FORMAT = /^pplx_local_[a-z0-9-]+_[A-Za-z0-9_-]{32}$/;
const ID_FORMAT = /^local-[a-z0-9-]+-[A-Za-z0-9_-]{11}$/;

describe("local scoped bearer tokens", () => {
  let configDir;
  let tokenPath;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-local-tokens-"));
    tokenPath = join(configDir, "local-tokens.json");
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("issues a token with the documented format and never persists the plaintext", () => {
    const { token, metadata } = issueLocalToken(
      { ideTag: "ClaudeDesktop", label: "Claude Desktop" },
      { tokenPath, now: () => "2026-04-24T00:00:00.000Z" },
    );

    expect(token).toMatch(TOKEN_FORMAT);
    expect(metadata.id).toMatch(ID_FORMAT);
    expect(metadata.ideTag).toBe("claudedesktop");
    expect(metadata.label).toBe("Claude Desktop");
    expect(metadata.createdAt).toBe("2026-04-24T00:00:00.000Z");
    expect(metadata.revoked).toBeFalsy();
    expect(metadata.lastUsedAt).toBeUndefined();

    const raw = readFileSync(tokenPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(raw).not.toContain(token);
    expect(parsed[0].token).toBeUndefined();
  });

  it("verifies a freshly-issued token and persists lastUsedAt", () => {
    const issued = issueLocalToken(
      { ideTag: "Claude Desktop", label: "Claude Desktop" },
      { tokenPath, now: () => "2026-04-24T00:00:00.000Z" },
    );

    const verified = verifyLocalToken(issued.token, {
      tokenPath,
      now: () => "2026-04-24T00:05:00.000Z",
    });

    expect(verified).not.toBeNull();
    expect(verified?.id).toBe(issued.metadata.id);
    expect(verified?.lastUsedAt).toBe("2026-04-24T00:05:00.000Z");

    const onDisk = JSON.parse(readFileSync(tokenPath, "utf8"));
    expect(onDisk[0].lastUsedAt).toBe("2026-04-24T00:05:00.000Z");
  });

  it("returns null for a well-formed but unknown token", () => {
    issueLocalToken(
      { ideTag: "claude-desktop", label: "Claude Desktop" },
      { tokenPath },
    );

    const bogus = "pplx_local_bogus_000000000000000000000000000000AA";
    expect(verifyLocalToken(bogus, { tokenPath })).toBeNull();
  });

  it("rejects malformed tokens without reading the file", () => {
    const missingPath = join(configDir, "does-not-exist.json");
    const spy = vi.spyOn(nodeCrypto, "createHash");

    const bad = [
      "",
      "pplx_local_",
      "pplx_local_x",
      "random garbage",
      "pplx_local_x_short",
      "PPLX_local_foo_" + "A".repeat(32),
      "pplx_local_FOO_" + "A".repeat(32),
    ];

    for (const value of bad) {
      expect(verifyLocalToken(value, { tokenPath: missingPath })).toBeNull();
    }

    expect(existsSync(missingPath)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("revokes a token idempotently and blocks subsequent verification", () => {
    const issued = issueLocalToken(
      { ideTag: "cursor", label: "Cursor" },
      { tokenPath },
    );

    expect(revokeLocalToken(issued.metadata.id, { tokenPath })).toBe(true);
    expect(revokeLocalToken(issued.metadata.id, { tokenPath })).toBe(false);
    expect(revokeLocalToken("local-nope-ABCDEFGHIJK", { tokenPath })).toBe(false);

    expect(verifyLocalToken(issued.token, { tokenPath })).toBeNull();
  });

  it("lists entries in insertion order, including revoked, without exposing hash", () => {
    const a = issueLocalToken(
      { ideTag: "claude", label: "Claude Desktop" },
      { tokenPath, now: () => "2026-04-24T00:00:00.000Z" },
    );
    const b = issueLocalToken(
      { ideTag: "cursor", label: "Cursor" },
      { tokenPath, now: () => "2026-04-24T00:01:00.000Z" },
    );
    const c = issueLocalToken(
      { ideTag: "codex", label: "Codex" },
      { tokenPath, now: () => "2026-04-24T00:02:00.000Z" },
    );

    revokeLocalToken(b.metadata.id, { tokenPath });

    const listed = listLocalTokens({ tokenPath });
    expect(listed.map((entry) => entry.id)).toEqual([
      a.metadata.id,
      b.metadata.id,
      c.metadata.id,
    ]);
    expect(listed[1].revoked).toBe(true);

    for (const entry of listed) {
      expect(entry).not.toHaveProperty("hash");
    }
  });

  it("returns [] when the file does not exist and does not create it", () => {
    const missingPath = join(configDir, "nope.json");
    expect(listLocalTokens({ tokenPath: missingPath })).toEqual([]);
    expect(existsSync(missingPath)).toBe(false);
  });

  it("produces distinct ids and tokens across issues with the same ideTag", () => {
    const first = issueLocalToken(
      { ideTag: "claude", label: "Claude Desktop" },
      { tokenPath },
    );
    const second = issueLocalToken(
      { ideTag: "claude", label: "Claude Desktop" },
      { tokenPath },
    );

    expect(first.token).not.toBe(second.token);
    expect(first.metadata.id).not.toBe(second.metadata.id);
    expect(first.metadata.ideTag).toBe("claude");
    expect(second.metadata.ideTag).toBe("claude");
  });

  it("sanitizes ideTag and rejects empty sanitized tags", () => {
    const noPunct = issueLocalToken(
      { ideTag: "ClaudeDesktop!", label: "Claude Desktop" },
      { tokenPath },
    );
    expect(noPunct.metadata.ideTag).toBe("claudedesktop");

    const withSpace = issueLocalToken(
      { ideTag: "Claude Desktop!", label: "Claude Desktop" },
      { tokenPath },
    );
    expect(withSpace.metadata.ideTag).toBe("claude-desktop");

    expect(() =>
      issueLocalToken(
        { ideTag: "   ", label: "Whitespace" },
        { tokenPath },
      ),
    ).toThrow();
  });

  it("validates label: rejects empty/whitespace, trims surrounding whitespace", () => {
    expect(() =>
      issueLocalToken({ ideTag: "claude", label: "" }, { tokenPath }),
    ).toThrow();
    expect(() =>
      issueLocalToken({ ideTag: "claude", label: "   " }, { tokenPath }),
    ).toThrow();

    const issued = issueLocalToken(
      { ideTag: "claude", label: "  Claude Desktop  " },
      { tokenPath },
    );
    expect(issued.metadata.label).toBe("Claude Desktop");
  });

  it("writes the token file with 0600 permissions on POSIX", () => {
    issueLocalToken(
      { ideTag: "claude", label: "Claude Desktop" },
      { tokenPath },
    );

    if (process.platform === "win32") {
      expect(existsSync(tokenPath)).toBe(true);
      return;
    }

    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("uses crypto.timingSafeEqual when comparing hashes during verify", () => {
    const issued = issueLocalToken(
      { ideTag: "claude", label: "Claude Desktop" },
      { tokenPath },
    );

    const spy = vi.spyOn(nodeCrypto, "timingSafeEqual");
    const result = verifyLocalToken(issued.token, { tokenPath });

    expect(result).not.toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it("revokeLocalToken throws on unreadable/corrupt files instead of silently returning false", () => {
    // Missing file is not "unreadable" — readRecords handles ENOENT as [] so
    // revoke returns false (same semantics as listLocalTokens).
    const missingPath = join(configDir, "missing.json");
    expect(revokeLocalToken("local-any-ABCDEFGHIJK", { tokenPath: missingPath })).toBe(false);

    // A file whose contents are not valid JSON is unreadable; revoke must
    // surface the error now that it uses strict readRecords.
    const corruptPath = join(configDir, "corrupt.json");
    realWriteFileSync(corruptPath, "{not valid json", "utf8");
    expect(() =>
      revokeLocalToken("local-any-ABCDEFGHIJK", { tokenPath: corruptPath }),
    ).toThrow(/not valid JSON/);
  });

  it("verifyLocalToken returns metadata and warns (not throws) when the lastUsedAt write-back fails", () => {
    const issued = issueLocalToken(
      { ideTag: "claude", label: "Claude Desktop" },
      { tokenPath, now: () => "2026-04-24T00:00:00.000Z" },
    );

    // The on-disk file is already written by issue. Arm writeFileSync to
    // throw on the NEXT invocation (verify's lastUsedAt write-back) without
    // affecting anything else.
    const writeSpy = vi.spyOn(nodeFs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device, open 'local-tokens.json.tmp'");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const verified = verifyLocalToken(issued.token, {
      tokenPath,
      now: () => "2026-04-24T00:05:00.000Z",
    });

    expect(verified).not.toBeNull();
    expect(verified?.id).toBe(issued.metadata.id);
    expect(verified?.lastUsedAt).toBe("2026-04-24T00:05:00.000Z");
    expect(writeSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const warnMessage = String(warnSpy.mock.calls[0][0]);
    expect(warnMessage).toMatch(/\[local-tokens\] lastUsedAt write-back failed/);
    expect(warnMessage).toContain("ENOSPC");
    // Crucially, the plaintext token must never leak into stderr.
    expect(warnMessage).not.toContain(issued.token);
  });
});
