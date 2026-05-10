import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "node:child_process";

// Mock vscode for any transitive imports.
vi.mock("vscode", () => ({
  window: { showInputBox: async () => undefined },
}));

// Mock spawn — we inspect its calls; we never actually fork a daemon.
// Use importOriginal so other consumers (e.g. mcp-server bundle pulling in
// execFile) still see the rest of the module.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

// Mock node:fs to neutralize daemon-log filesystem ops without affecting
// other consumers of node:fs that runtime.ts transitively pulls in.
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(() => 99),
    closeSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0 })),
    renameSync: vi.fn(),
  };
});

import { configureDaemonRuntime, ensureBundledDaemon } from "../src/daemon/runtime";

const spawnMock = childProcess.spawn as unknown as ReturnType<typeof vi.fn>;

function fakeChild() {
  return { on: vi.fn(), unref: vi.fn() } as unknown as ReturnType<typeof childProcess.spawn>;
}

// ensureBundledDaemon would normally poll the (mocked, never-actually-
// running) daemon for ~15s before throwing. Each test catches that throw
// and asserts on the captured spawn() options. We pass a tiny
// startTimeoutMs (200ms) so the polling loop fails fast — this keeps the
// suite under ~2s instead of ~75s and avoids vitest worker-pool stress
// on Windows + Node 24 CI runners that surfaced as flaky failures.
const FAST_DEADLINE_MS = 200;

describe("spawnBundledDaemon merges buildDaemonEnv result", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(fakeChild);
  });

  afterEach(() => {
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
  });

  it("merges provider env into spawn() options.env", async () => {
    configureDaemonRuntime({
      configDir: "/tmp/perp-test",
      serverPath: "/tmp/perp-test/server.mjs",
      bundledVersion: "0.8.41",
      buildDaemonEnv: async () => ({ PERPLEXITY_VAULT_PASSPHRASE: "test-pass" }),
    });
    try { await ensureBundledDaemon({ startTimeoutMs: FAST_DEADLINE_MS }); } catch { /* health-check failure is expected */ }
    expect(spawnMock).toHaveBeenCalled();
    const opts = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(opts.env.PERPLEXITY_VAULT_PASSPHRASE).toBe("test-pass");
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(opts.env.PERPLEXITY_CONFIG_DIR).toBe("/tmp/perp-test");
  });

  it("does not set PERPLEXITY_VAULT_PASSPHRASE when provider returns {}", async () => {
    configureDaemonRuntime({
      configDir: "/tmp/perp-test",
      serverPath: "/tmp/perp-test/server.mjs",
      bundledVersion: "0.8.41",
      buildDaemonEnv: async () => ({}),
    });
    try { await ensureBundledDaemon({ startTimeoutMs: FAST_DEADLINE_MS }); } catch { /* expected */ }
    const opts = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(opts.env.PERPLEXITY_VAULT_PASSPHRASE).toBeUndefined();
  });

  it("hard-coded overrides win over provider env", async () => {
    configureDaemonRuntime({
      configDir: "/tmp/perp-test",
      serverPath: "/tmp/perp-test/server.mjs",
      bundledVersion: "0.8.41",
      // Provider tries to clobber critical overrides — must not succeed.
      buildDaemonEnv: async () => ({ ELECTRON_RUN_AS_NODE: "0", PERPLEXITY_CONFIG_DIR: "/evil" }),
    });
    try { await ensureBundledDaemon({ startTimeoutMs: FAST_DEADLINE_MS }); } catch { /* expected */ }
    const opts = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(opts.env.PERPLEXITY_CONFIG_DIR).toBe("/tmp/perp-test");
  });

  it("works without a provider (back-compat)", async () => {
    configureDaemonRuntime({
      configDir: "/tmp/perp-test",
      serverPath: "/tmp/perp-test/server.mjs",
      bundledVersion: "0.8.41",
    });
    try { await ensureBundledDaemon({ startTimeoutMs: FAST_DEADLINE_MS }); } catch { /* expected */ }
    const opts = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("does not mutate process.env after spawn", async () => {
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    configureDaemonRuntime({
      configDir: "/tmp/perp-test",
      serverPath: "/tmp/perp-test/server.mjs",
      bundledVersion: "0.8.41",
      buildDaemonEnv: async () => ({ PERPLEXITY_VAULT_PASSPHRASE: "must-not-leak" }),
    });
    try { await ensureBundledDaemon({ startTimeoutMs: FAST_DEADLINE_MS }); } catch { /* expected */ }
    expect(process.env.PERPLEXITY_VAULT_PASSPHRASE).toBeUndefined();
  });
});
