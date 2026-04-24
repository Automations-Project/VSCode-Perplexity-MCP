import { beforeEach, describe, expect, it, vi } from "vitest";

// Bucket of values the mocked configuration should return. Keys are
// configuration property names (e.g. "mcpTransportByIde"), values are what
// `configuration.get(key, fallback)` will produce. Missing keys fall through
// to `fallback` (the real VS Code API behavior).
const configValues: Record<string, unknown> = {};

vi.mock("vscode", () => {
  const getConfiguration = vi.fn((_section: string) => ({
    get: <T>(key: string, fallback: T): T => {
      if (key in configValues) {
        return configValues[key] as T;
      }
      return fallback;
    },
    update: vi.fn(async () => undefined),
  }));
  return {
    workspace: { getConfiguration },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };
});

describe("getSettingsSnapshot transport/daemon/sync fields", () => {
  beforeEach(() => {
    for (const k of Object.keys(configValues)) delete configValues[k];
  });

  it("defaults mcpTransportByIde to {}", async () => {
    const { getSettingsSnapshot } = await import("../src/settings.js");
    const snap = getSettingsSnapshot();
    expect(snap.mcpTransportByIde).toEqual({});
  });

  it("defaults daemonPort to 0 (ephemeral)", async () => {
    const { getSettingsSnapshot } = await import("../src/settings.js");
    const snap = getSettingsSnapshot();
    expect(snap.daemonPort).toBe(0);
  });

  it("defaults syncFolderPatterns to []", async () => {
    const { getSettingsSnapshot } = await import("../src/settings.js");
    const snap = getSettingsSnapshot();
    expect(snap.syncFolderPatterns).toEqual([]);
  });

  it("defaults autoRegenerateStaleConfigs to true", async () => {
    const { getSettingsSnapshot } = await import("../src/settings.js");
    const snap = getSettingsSnapshot();
    expect(snap.autoRegenerateStaleConfigs).toBe(true);
  });

  it("propagates user-supplied values from the VS Code configuration", async () => {
    configValues.mcpTransportByIde = {
      cursor: "http-loopback",
      claudeDesktop: "stdio-daemon-proxy",
    };
    configValues.daemonPort = 49152;
    configValues.syncFolderPatterns = ["^/Users/.*/MyCloud/"];
    configValues.autoRegenerateStaleConfigs = false;

    const { getSettingsSnapshot } = await import("../src/settings.js");
    const snap = getSettingsSnapshot();

    expect(snap.mcpTransportByIde).toEqual({
      cursor: "http-loopback",
      claudeDesktop: "stdio-daemon-proxy",
    });
    expect(snap.daemonPort).toBe(49152);
    expect(snap.syncFolderPatterns).toEqual(["^/Users/.*/MyCloud/"]);
    expect(snap.autoRegenerateStaleConfigs).toBe(false);
  });
});
