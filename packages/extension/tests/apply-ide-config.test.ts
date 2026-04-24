import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep mocking confined to this file. We re-export every public symbol from
// the real shared package and only override IDE_METADATA so we can exercise
// capability matrices that no shipping IDE has yet (e.g. httpBearerLoopback).
vi.mock("@perplexity-user-mcp/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@perplexity-user-mcp/shared")>();
  return {
    ...actual,
    // A fresh, mutable copy — tests reach in via the getIdeMeta helper below
    // to adjust one IDE's capabilities per-case.
    IDE_METADATA: {
      ...actual.IDE_METADATA,
      // Synthetic "bearer-capable" cursor clone for http-loopback bearer
      // fallback tests. Keeps the real cursor entry untouched.
      cursorBearer: {
        displayName: "Cursor (Bearer fallback test)",
        configFormat: "json",
        autoConfigurable: true,
        capabilities: {
          stdio: true,
          httpBearerLoopback: true,
          httpOAuthLoopback: false,
          httpOAuthTunnel: true,
        },
      },
      cursorOauthLoopback: {
        displayName: "Cursor (OAuth loopback test)",
        configFormat: "json",
        autoConfigurable: true,
        capabilities: {
          stdio: true,
          httpBearerLoopback: false,
          httpOAuthLoopback: true,
          httpOAuthTunnel: true,
        },
      },
      cursorTunnel: {
        displayName: "Cursor (tunnel test)",
        configFormat: "json",
        autoConfigurable: true,
        capabilities: {
          stdio: true,
          httpBearerLoopback: false,
          httpOAuthLoopback: false,
          httpOAuthTunnel: true,
        },
      },
    },
  };
});

// Intentionally import AFTER the vi.mock call; vitest hoists mocks but this
// keeps the intent legible.
import {
  applyIdeConfig,
  removeIdeConfig,
  type ApplyIdeConfigDeps,
} from "../src/auto-config/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "perplexity-apply-ide-config-"));
  tempDirs.push(root);
  return root;
}

interface AuditEntry {
  ideTag: string;
  transportId: string;
  configPath: string;
  bearerKind: "none" | "local" | "static";
  resultCode: string;
  ts: string;
}

// Helper — build a deps object with passthrough defaults and an audit sink.
// Tests override individual fields as needed.
function makeDeps(overrides: Partial<ApplyIdeConfigDeps> = {}): {
  deps: ApplyIdeConfigDeps;
  audit: AuditEntry[];
} {
  const audit: AuditEntry[] = [];
  const deps: ApplyIdeConfigDeps = {
    confirmTransport: async () => true,
    warnSyncFolder: async () => "cancel",
    nudgePortPin: () => {},
    auditGenerated: (entry) => audit.push(entry),
    getDaemonPort: () => 12345,
    getActiveTunnel: () => null,
    syncFolderPatterns: [],
    homeDir: () => "/home/admin",
    isGitTracked: () => false,
    ...overrides,
  };
  return { deps, audit };
}

describe("applyIdeConfig — Phase 8.6.4 dispatch", () => {
  it("rejects when the IDE capability flag for the chosen transport is false", async () => {
    const root = makeTempRoot();
    const configPath = join(root, ".github", "copilot-config.json");
    const { deps, audit } = makeDeps();

    const result = await applyIdeConfig(
      {
        // copilot has stdio: false (ui-only). Forcing stdio-in-process should
        // hit the capability gate.
        target: "copilot",
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "stdio-in-process",
      },
      deps
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("unsupported");
      expect(result.transportId).toBe("stdio-in-process");
    }
    expect(audit[0]?.resultCode).toBe("rejected-unsupported");
    expect(audit[0]?.bearerKind).toBe("none");
  });

  it("rejects when the config format does not match the builder's supported formats", async () => {
    const root = makeTempRoot();
    const configPath = join(root, ".codex", "config.toml");
    const { deps, audit } = makeDeps();

    const result = await applyIdeConfig(
      {
        // codexCli is toml-only; http-loopback builder only supports json.
        target: "codexCli",
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "http-loopback",
      },
      deps
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("unsupported");
    }
    expect(audit[0]?.resultCode).toBe("rejected-unsupported");
  });

  it("calls warnSyncFolder for http-loopback static-bearer baseline and cancels on user decline", async () => {
    const root = makeTempRoot();
    // Ancestor name contains "OneDrive" — should trigger the built-in
    // sync-folder heuristic.
    const configPath = join(root, "OneDrive", "Cursor", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });

    const warnSyncCalls: Array<{ configPath: string; matchedPattern: string }> = [];
    const { deps, audit } = makeDeps({
      warnSyncFolder: async (args) => {
        warnSyncCalls.push(args);
        return "cancel";
      },
      getDaemonBearer: async () => "daemon-static-bearer-uuid-v4",
    });

    const result = await applyIdeConfig(
      {
        target: "cursorBearer" as never,
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "http-loopback",
      },
      deps
    );

    expect(warnSyncCalls.length).toBeGreaterThan(0);
    expect(warnSyncCalls[0]?.matchedPattern).toBe("OneDrive");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("sync-folder");
    }
    expect(audit[0]?.resultCode).toBe("rejected-sync");
    expect(audit[0]?.bearerKind).toBe("static");
  });

  it("proceeds past the sync-folder gate when the user overrides", async () => {
    const root = makeTempRoot();
    const configPath = join(root, "OneDrive", "Cursor", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });

    const audit: AuditEntry[] = [];
    const result = await applyIdeConfig(
      {
        target: "cursorBearer" as never,
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "http-loopback",
      },
      {
        confirmTransport: async () => true,
        warnSyncFolder: async () => "override",
        auditGenerated: (entry) => audit.push(entry),
        getDaemonPort: () => 12345,
        getDaemonBearer: async () => "daemon-static-bearer-uuid-v4",
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(true);
    expect(audit.at(-1)?.resultCode).toBe("ok");
  });

  it("skips sync-folder detection entirely for http-tunnel (no secret written)", async () => {
    const root = makeTempRoot();
    const configPath = join(root, "OneDrive", "Cursor", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });
    const warnSyncCalls: Array<{ configPath: string; matchedPattern: string }> = [];

    const result = await applyIdeConfig(
      {
        target: "cursorTunnel" as never,
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "http-tunnel",
      },
      {
        confirmTransport: async () => true,
        warnSyncFolder: async (args) => {
          warnSyncCalls.push(args);
          return "cancel";
        },
        auditGenerated: () => {},
        getDaemonPort: () => 12345,
        getActiveTunnel: () => ({
          providerId: "cf-named",
          url: "https://mcp.example.com",
          reservedDomain: true,
        }),
        isGitTracked: () => false,
      }
    );

    expect(warnSyncCalls.length).toBe(0);
    expect(result.ok).toBe(true);
  });

  it("returns cancelled when the H5 confirmation modal returns false", async () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    const audit: AuditEntry[] = [];

    const result = await applyIdeConfig(
      {
        target: "cursor",
        serverPath: "C:/bundle/server.mjs",
        configPath,
      },
      {
        confirmTransport: async () => false,
        auditGenerated: (entry) => audit.push(entry),
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("cancelled");
    }
    expect(audit[0]?.resultCode).toBe("rejected-cancelled");
  });

  it("nudges port pin (H6) when http-loopback chosen with ephemeral (0) daemon port", async () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    let nudged = 0;
    const audit: AuditEntry[] = [];

    const result = await applyIdeConfig(
      {
        target: "cursorOauthLoopback" as never,
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "http-loopback",
      },
      {
        confirmTransport: async () => true,
        // Port 0 ⇒ ephemeral. H6 spec triggers the nudge.
        getDaemonPort: () => 0,
        nudgePortPin: () => {
          nudged += 1;
        },
        auditGenerated: (entry) => audit.push(entry),
        isGitTracked: () => false,
      }
    );

    expect(nudged).toBe(1);
    // Builder will reject because daemonPort=0 is <= 0. That's expected and
    // separately covered; here we only assert the nudge fired first.
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("tunnel-unstable");
    }
  });

  it("H3: sanitized .bak redacts bearers and is cleaned up on success", async () => {
    const root = makeTempRoot();
    const configPath = join(root, "mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            Perplexity: { env: { PERPLEXITY_SOMETHING: "x" } },
            other: {
              headers: {
                Authorization:
                  "Bearer pplx_local_abc_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
              },
            },
          },
        },
        null,
        2
      )
    );

    // To observe the sanitized .bak content mid-call (before the success path
    // deletes it), we cause a deliberate failure AFTER .bak is written.
    // Pre-creating `<configPath>.tmp` as a non-empty directory makes renameSync
    // from the tempfile fail on every platform without monkey-patching fs.
    // The rollback then copies .bak over configPath before deleting .bak — so
    // the sanitized content ends up readable at configPath.
    const blockedTmp = `${configPath}.tmp`;
    mkdirSync(blockedTmp, { recursive: true });
    writeFileSync(join(blockedTmp, "blocker"), "x");

    const result = await applyIdeConfig(
      {
        target: "cursor",
        serverPath: "C:/bundle/server.mjs",
        configPath,
      },
      {
        confirmTransport: async () => true,
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("error");
    }

    // After rollback, configPath holds the sanitized .bak content; .bak itself
    // was removed. This proves:
    //  1. The .bak was written with the bearer already replaced ("<redacted>").
    //  2. The rollback path runs on failure (restore + remove).
    expect(existsSync(`${configPath}.bak`)).toBe(false);
    const restored = readFileSync(configPath, "utf8");
    expect(restored).not.toMatch(/pplx_local_abc_XXXX/);
    expect(restored).toContain("<redacted>");

    // Cleanup — the blocked tmp directory survived the failure.
    rmSync(blockedTmp, { recursive: true, force: true });
  });

  it("H3: atomic merge preserves unrelated existing server entries on success", async () => {
    const root = makeTempRoot();
    const configPath = join(root, "mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            existing: { command: "node", args: ["x"] },
            other: { command: "node", args: ["y"] },
          },
        },
        null,
        2
      )
    );

    const result = await applyIdeConfig(
      {
        target: "cursor",
        serverPath: "C:/bundle/server.mjs",
        configPath,
      },
      {
        confirmTransport: async () => true,
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(true);
    expect(existsSync(`${configPath}.bak`)).toBe(false);
    const final = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(final.mcpServers.existing).toBeTruthy();
    expect(final.mcpServers.other).toBeTruthy();
    expect(final.mcpServers.Perplexity).toBeTruthy();
  });

  it("H3: rolls back to sanitized .bak when the atomic write fails, then removes .bak", async () => {
    const root = makeTempRoot();
    const configPath = join(root, "mcp.json");
    const originalContent = JSON.stringify(
      {
        mcpServers: {
          existing: { command: "node", args: ["x"] },
          // A bearer the sanitizer should redact in the .bak.
          tainted: { token: "pplx_local_old_YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY" },
        },
      },
      null,
      2
    );
    writeFileSync(configPath, originalContent);

    // Force renameSync to fail by parking a non-empty directory at the .tmp
    // target. ESM prevents spying on `node:fs` exports, so this filesystem-
    // level block is the portable alternative.
    const blockedTmp = `${configPath}.tmp`;
    mkdirSync(blockedTmp, { recursive: true });
    writeFileSync(join(blockedTmp, "blocker"), "x");

    const audit: AuditEntry[] = [];
    const result = await applyIdeConfig(
      {
        target: "cursor",
        serverPath: "C:/bundle/server.mjs",
        configPath,
      },
      {
        confirmTransport: async () => true,
        auditGenerated: (e) => audit.push(e),
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("error");
    }
    // .bak removed after rollback.
    expect(existsSync(`${configPath}.bak`)).toBe(false);
    // configPath now holds the sanitized rollback content (not the plaintext
    // original). If the rollback had skipped sanitization, the bearer would
    // still be here.
    const restored = readFileSync(configPath, "utf8");
    expect(restored).not.toMatch(/pplx_local_old_YYYY/);
    // Positive assertion: `<redacted>` must appear so a future regression where
    // the rollback copies unredacted content can't pass trivially (the
    // plaintext bearer simply happening to not match a specific substring).
    expect(restored).toContain("<redacted>");
    expect(audit.at(-1)?.resultCode).toBe("error");

    rmSync(blockedTmp, { recursive: true, force: true });
  });

  it("propagates StabilityGateError from the http-tunnel builder as tunnel-unstable", async () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    const audit: AuditEntry[] = [];

    const result = await applyIdeConfig(
      {
        target: "cursorTunnel" as never,
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "http-tunnel",
      },
      {
        confirmTransport: async () => true,
        getActiveTunnel: () => ({
          providerId: "cf-quick",
          url: "https://ephemeral.trycloudflare.com",
          reservedDomain: false,
        }),
        auditGenerated: (entry) => audit.push(entry),
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("tunnel-unstable");
    }
    expect(audit[0]?.resultCode).toBe("rejected-tunnel-unstable");
  });

  it("http-loopback with httpBearerLoopback: true picks bearerKind 'static' and embeds the daemon bearer", async () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    const bearerCalls: number[] = [];
    let issueCalls = 0;

    const result = await applyIdeConfig(
      {
        target: "cursorBearer" as never,
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "http-loopback",
      },
      {
        confirmTransport: async () => true,
        warnSyncFolder: async () => "override",
        getDaemonBearer: async () => {
          bearerCalls.push(1);
          return "daemon-static-bearer-uuid-v4";
        },
        issueLocalToken: () => {
          issueCalls += 1;
          return {
            token: "should-not-be-used",
            metadata: { id: "nope" },
          };
        },
        getDaemonPort: () => 54321,
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.bearerKind).toBe("static");
    }
    expect(bearerCalls.length).toBe(1);
    expect(issueCalls).toBe(0);

    // Final config contains the static-bearer Authorization header.
    const final = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: { Perplexity: { headers?: { Authorization?: string } } };
    };
    expect(final.mcpServers.Perplexity.headers?.Authorization).toBe(
      "Bearer daemon-static-bearer-uuid-v4"
    );
  });

  it("returns { ok: false, reason: 'error' } when bearerKind 'static' and getDaemonBearer returns null", async () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    const audit: AuditEntry[] = [];

    const result = await applyIdeConfig(
      {
        target: "cursorBearer" as never,
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "http-loopback",
      },
      {
        confirmTransport: async () => true,
        warnSyncFolder: async () => "override",
        auditGenerated: (entry) => audit.push(entry),
        getDaemonBearer: async () => null,
        getDaemonPort: () => 54321,
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("error");
      expect(result.message).toMatch(/bearer unavailable/i);
    }
    expect(audit.at(-1)?.resultCode).toBe("error");
    expect(audit.at(-1)?.bearerKind).toBe("static");
  });

  it("returns { ok: false, reason: 'error' } when bearerKind 'static' and getDaemonBearer is not provided", async () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    const audit: AuditEntry[] = [];

    const result = await applyIdeConfig(
      {
        target: "cursorBearer" as never,
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "http-loopback",
      },
      {
        confirmTransport: async () => true,
        warnSyncFolder: async () => "override",
        auditGenerated: (entry) => audit.push(entry),
        // getDaemonBearer intentionally omitted
        getDaemonPort: () => 54321,
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("error");
      expect(result.message).toMatch(/getDaemonBearer not provided/i);
    }
    expect(audit.at(-1)?.resultCode).toBe("error");
    expect(audit.at(-1)?.bearerKind).toBe("static");
  });

  it("does NOT issue a local token when bearerKind resolves to 'none' (OAuth loopback)", async () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    let issueCalls = 0;

    const result = await applyIdeConfig(
      {
        target: "cursorOauthLoopback" as never,
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "http-loopback",
      },
      {
        confirmTransport: async () => true,
        issueLocalToken: () => {
          issueCalls += 1;
          return {
            token: "should-not-be-used",
            metadata: { id: "nope" },
          };
        },
        getDaemonPort: () => 54321,
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.bearerKind).toBe("none");
    }
    expect(issueCalls).toBe(0);
  });

  it("emits an audit entry with resultCode 'ok' on the happy path", async () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    const audit: AuditEntry[] = [];

    const result = await applyIdeConfig(
      { target: "cursor", serverPath: "C:/bundle/server.mjs", configPath },
      {
        confirmTransport: async () => true,
        auditGenerated: (entry) => audit.push(entry),
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(true);
    expect(audit.length).toBe(1);
    expect(audit[0]?.resultCode).toBe("ok");
    expect(audit[0]?.transportId).toBe("stdio-daemon-proxy");
  });

  it("home-redacts the audit configPath when the path is inside homeDir", async () => {
    const root = makeTempRoot();
    // Deliberately place the config inside a fake "home" so we can assert the
    // replacement. On Windows the path will still be redacted case-insensitively.
    const fakeHome = root;
    const configPath = join(fakeHome, ".cursor", "mcp.json");
    const audit: AuditEntry[] = [];

    const result = await applyIdeConfig(
      { target: "cursor", serverPath: "C:/bundle/server.mjs", configPath },
      {
        confirmTransport: async () => true,
        auditGenerated: (entry) => audit.push(entry),
        homeDir: () => fakeHome,
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(true);
    expect(audit[0]?.configPath.startsWith("~")).toBe(true);
    expect(audit[0]?.configPath).not.toContain(fakeHome);
  });

  it("writes the final config with 0o600 perms (bearer-kind happy path)", async () => {
    // Regression for B1 — the tempfile used by writeJsonAtomic previously had
    // default (world-readable) permissions, so during the window between
    // `writeFileSync` and `renameSync` a concurrent reader could lift the
    // embedded Bearer token. Both the tempfile and the resulting config file
    // must open at 0o600 (POSIX) / locked ACL (Windows).
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");

    const result = await applyIdeConfig(
      {
        target: "cursorBearer" as never,
        serverPath: "C:/bundle/server.mjs",
        configPath,
        transportId: "http-loopback",
      },
      {
        confirmTransport: async () => true,
        warnSyncFolder: async () => "override",
        getDaemonBearer: async () => "daemon-static-bearer-uuid-v4",
        getDaemonPort: () => 54321,
        isGitTracked: () => false,
      }
    );

    expect(result.ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    // Windows uses ACLs rather than POSIX mode bits; skip the bit check but
    // keep the existence assertion so at least the write is verified.
    if (process.platform !== "win32") {
      const mode = statSync(configPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("removeIdeConfig — sanitized .bak is written then cleaned up on success", async () => {
    // Regression for I1 — removeIdeConfig previously used a raw copyFileSync
    // into `.bak` with default perms and no cleanup, leaving a plaintext
    // bearer on disk permanently.
    const root = makeTempRoot();
    const configPath = join(root, "mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            Perplexity: {
              url: "http://127.0.0.1:54321/mcp",
              headers: {
                Authorization:
                  "Bearer pplx_local_abc_REMOVETESTxxxxxxxxxxxxxxxxxxxxxx",
              },
            },
          },
        },
        null,
        2
      )
    );

    removeIdeConfig("cursor", { configPath });

    // Success path: `.bak` was created, sanitized, then deleted. It must not
    // linger on disk — a stale redacted artifact still leaks structure.
    expect(existsSync(`${configPath}.bak`)).toBe(false);

    // The config is cleaned (Perplexity entry removed).
    const remaining = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(remaining.mcpServers?.Perplexity).toBeUndefined();
  });

  it("removeIdeConfig — rollback restores sanitized .bak when the write fails", async () => {
    const root = makeTempRoot();
    const configPath = join(root, "mcp.json");
    const originalContent = JSON.stringify(
      {
        mcpServers: {
          Perplexity: { command: "node", args: ["x"] },
          tainted: {
            headers: {
              Authorization:
                "Bearer pplx_local_old_REMOVETESTyyyyyyyyyyyyyyyyyyyyyy",
            },
          },
        },
      },
      null,
      2
    );
    writeFileSync(configPath, originalContent);

    // Force renameSync inside writeJsonAtomic to fail by parking a non-empty
    // directory at the `.tmp` path. Same trick the existing H3 rollback test
    // uses — portable across platforms without fs spy.
    const blockedTmp = `${configPath}.tmp`;
    mkdirSync(blockedTmp, { recursive: true });
    writeFileSync(join(blockedTmp, "blocker"), "x");

    removeIdeConfig("cursor", { configPath });

    // Post-rollback: `.bak` was removed, and configPath now holds the
    // sanitized content (the rollback copies `.bak` over the target). The
    // plaintext bearer must be gone and `<redacted>` present — parity with
    // the applyIdeConfig H3 rollback test.
    expect(existsSync(`${configPath}.bak`)).toBe(false);
    const restored = readFileSync(configPath, "utf8");
    expect(restored).not.toMatch(/pplx_local_old_REMOVETEST/);
    expect(restored).toContain("<redacted>");

    rmSync(blockedTmp, { recursive: true, force: true });
  });
});
