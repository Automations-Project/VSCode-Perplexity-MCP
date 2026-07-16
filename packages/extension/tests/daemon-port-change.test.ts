import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock vscode for transitive imports (settings.ts).
vi.mock("vscode", () => ({
  window: { showInputBox: async () => undefined },
}));

// Replace ensureDaemon with a controllable stub; keep the rest of the daemon
// module real (readDaemonLock etc. are used by reapStaleVersionedDaemon).
vi.mock("perplexity-user-mcp/daemon", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ensureDaemon: vi.fn(),
  };
});

// Pin settings: daemonPort configurable per test.
const settingsState = { daemonPort: 0 };
vi.mock("../src/settings", () => ({
  getSettingsSnapshot: () => ({ daemonPort: settingsState.daemonPort, oauthConsentCacheTtlHours: 24 }),
}));

import { ensureDaemon } from "perplexity-user-mcp/daemon";
import {
  configureDaemonRuntime,
  ensureBundledDaemon,
  onBundledDaemonPortChange,
} from "../src/daemon/runtime";

const ensureDaemonMock = ensureDaemon as unknown as ReturnType<typeof vi.fn>;

const info = (port: number) => ({
  pid: 4242,
  uuid: "u",
  port,
  url: `http://127.0.0.1:${port}`,
  bearerToken: "b",
  version: "0.0.0",
  startedAt: new Date(0).toISOString(),
});

// Issue #14: the daemon binds an ephemeral port each start and VS Code caches
// the URL baked into the McpHttpServerDefinition. The runtime must (a) notice
// when the observed port moves so the extension can re-fire
// serverDefinitionsChanged, and (b) actually pass the pinned
// Perplexity.daemonPort to ensureDaemon — the setting was dead code, making
// the extension's own "Pin a port now" nudge a no-op.
describe("bundled daemon port handling (issue #14)", () => {
  beforeEach(() => {
    ensureDaemonMock.mockReset();
    settingsState.daemonPort = 0;
    configureDaemonRuntime({
      configDir: "/tmp/perp-port-test",
      serverPath: "/tmp/perp-port-test/server.mjs",
      bundledVersion: "0.0.0",
    });
  });

  it("notifies the listener only when the observed port changes", async () => {
    const seen: number[] = [];
    onBundledDaemonPortChange((port) => seen.push(port));

    ensureDaemonMock.mockResolvedValueOnce(info(1111));
    await ensureBundledDaemon();
    expect(seen).toEqual([]); // first observation is not a change

    ensureDaemonMock.mockResolvedValueOnce(info(1111));
    await ensureBundledDaemon();
    expect(seen).toEqual([]); // same port — no event

    ensureDaemonMock.mockResolvedValueOnce(info(2222));
    await ensureBundledDaemon();
    expect(seen).toEqual([2222]); // respawn on a new port — re-fire
  });

  it("passes a valid pinned Perplexity.daemonPort through to ensureDaemon", async () => {
    settingsState.daemonPort = 49217;
    ensureDaemonMock.mockResolvedValue(info(49217));
    await ensureBundledDaemon();
    expect(ensureDaemonMock.mock.calls.at(-1)?.[0]).toMatchObject({ port: 49217 });
  });

  it("omits the port when the setting is 0 or out of range", async () => {
    ensureDaemonMock.mockResolvedValue(info(3333));
    await ensureBundledDaemon();
    expect(ensureDaemonMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("port");

    settingsState.daemonPort = 80; // below 1024 — refuse to pin
    await ensureBundledDaemon();
    expect(ensureDaemonMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("port");
  });
});
