import { beforeEach, describe, expect, it, vi } from "vitest";

// Per-test bucket of overridden config values. The mocked
// configuration.inspect() reflects these via globalValue/workspaceValue so
// we can simulate "user has explicitly set enableTunnels".
const inspectValues: Record<
  string,
  { globalValue?: unknown; workspaceValue?: unknown } | undefined
> = {};
const updateCalls: Array<{ key: string; value: unknown; target: unknown }> = [];

vi.mock("vscode", () => {
  const getConfiguration = vi.fn((_section: string) => ({
    inspect: <T>(key: string) =>
      (inspectValues[key] as
        | { globalValue?: T; workspaceValue?: T }
        | undefined) ?? undefined,
    update: vi.fn(async (key: string, value: unknown, target: unknown) => {
      updateCalls.push({ key, value, target });
    }),
  }));
  return {
    workspace: { getConfiguration },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };
});

interface FakeGlobalState {
  store: Map<string, unknown>;
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

function makeContext(): {
  context: { globalState: FakeGlobalState };
  globalState: FakeGlobalState;
} {
  const store = new Map<string, unknown>();
  const globalState: FakeGlobalState = {
    store,
    get: <T>(key: string) => store.get(key) as T | undefined,
    update: async (key, value) => {
      store.set(key, value);
    },
  };
  return { context: { globalState }, globalState };
}

describe("migrateEnableTunnelsOnce", () => {
  beforeEach(() => {
    for (const k of Object.keys(inspectValues)) delete inspectValues[k];
    updateCalls.length = 0;
  });

  it("fresh install: no tunnel-settings.json → enableTunnels stays false, key marked migrated", async () => {
    const { migrateEnableTunnelsOnce, ENABLE_TUNNELS_MIGRATION_KEY } = await import(
      "../src/webview/tunnel-settings-migration.js"
    );
    const { context, globalState } = makeContext();
    await migrateEnableTunnelsOnce(context as any, {
      configDir: "/tmp/config",
      fileExists: () => false,
      readFile: () => {
        throw new Error("should not be read");
      },
    });
    expect(updateCalls).toHaveLength(0);
    expect(globalState.get(ENABLE_TUNNELS_MIGRATION_KEY)).toBe(true);
  });

  it("upgrader: tunnel-settings.json with activeProvider → flips to true, key marked migrated", async () => {
    const { migrateEnableTunnelsOnce, ENABLE_TUNNELS_MIGRATION_KEY } = await import(
      "../src/webview/tunnel-settings-migration.js"
    );
    const { context, globalState } = makeContext();
    await migrateEnableTunnelsOnce(context as any, {
      configDir: "/tmp/config",
      fileExists: () => true,
      readFile: () =>
        JSON.stringify({
          activeProvider: "ngrok",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
    });
    expect(updateCalls).toEqual([
      { key: "enableTunnels", value: true, target: 1 },
    ]);
    expect(globalState.get(ENABLE_TUNNELS_MIGRATION_KEY)).toBe(true);
  });

  it("user explicitly set enableTunnels=false → no migration write, key marked migrated", async () => {
    const { migrateEnableTunnelsOnce, ENABLE_TUNNELS_MIGRATION_KEY } = await import(
      "../src/webview/tunnel-settings-migration.js"
    );
    inspectValues.enableTunnels = { globalValue: false };
    const { context, globalState } = makeContext();
    await migrateEnableTunnelsOnce(context as any, {
      configDir: "/tmp/config",
      // Existence wouldn't matter — the explicit choice short-circuits.
      fileExists: () => true,
      readFile: () => JSON.stringify({ activeProvider: "cf-quick" }),
    });
    expect(updateCalls).toHaveLength(0);
    expect(globalState.get(ENABLE_TUNNELS_MIGRATION_KEY)).toBe(true);
  });

  it("user explicitly set enableTunnels=true → no migration write needed, key marked migrated", async () => {
    const { migrateEnableTunnelsOnce, ENABLE_TUNNELS_MIGRATION_KEY } = await import(
      "../src/webview/tunnel-settings-migration.js"
    );
    inspectValues.enableTunnels = { globalValue: true };
    const { context, globalState } = makeContext();
    await migrateEnableTunnelsOnce(context as any, {
      configDir: "/tmp/config",
      fileExists: () => false,
      readFile: () => "",
    });
    expect(updateCalls).toHaveLength(0);
    expect(globalState.get(ENABLE_TUNNELS_MIGRATION_KEY)).toBe(true);
  });

  it("second call after migration key set → no-op", async () => {
    const { migrateEnableTunnelsOnce, ENABLE_TUNNELS_MIGRATION_KEY } = await import(
      "../src/webview/tunnel-settings-migration.js"
    );
    const { context, globalState } = makeContext();
    // Simulate a prior migration run.
    await globalState.update(ENABLE_TUNNELS_MIGRATION_KEY, true);

    let fileExistsCalled = false;
    await migrateEnableTunnelsOnce(context as any, {
      configDir: "/tmp/config",
      fileExists: () => {
        fileExistsCalled = true;
        return true;
      },
      readFile: () => JSON.stringify({ activeProvider: "ngrok" }),
    });
    expect(fileExistsCalled).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  it("malformed tunnel-settings.json → leaves enableTunnels untouched, key marked migrated", async () => {
    const { migrateEnableTunnelsOnce, ENABLE_TUNNELS_MIGRATION_KEY } = await import(
      "../src/webview/tunnel-settings-migration.js"
    );
    const { context, globalState } = makeContext();
    await migrateEnableTunnelsOnce(context as any, {
      configDir: "/tmp/config",
      fileExists: () => true,
      readFile: () => "{ not json",
    });
    expect(updateCalls).toHaveLength(0);
    expect(globalState.get(ENABLE_TUNNELS_MIGRATION_KEY)).toBe(true);
  });
});
