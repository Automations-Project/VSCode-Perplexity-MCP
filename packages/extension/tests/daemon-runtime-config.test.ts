import { describe, it, expect, vi } from "vitest";

// vitest's Node environment has no real "vscode" module — runtime.ts may
// import vscode-related modules transitively. Mock for safety.
vi.mock("vscode", () => ({
  window: {
    showInputBox: async () => undefined,
  },
}));

import { configureDaemonRuntime } from "../src/daemon/runtime";

describe("configureDaemonRuntime accepts buildDaemonEnv provider", () => {
  it("accepts a config with buildDaemonEnv", () => {
    const provider = vi.fn(async () => ({ FOO: "bar" }));
    expect(() =>
      configureDaemonRuntime({
        configDir: "/tmp/x",
        serverPath: "/tmp/x/server.mjs",
        bundledVersion: "0.8.41",
        buildDaemonEnv: provider,
      }),
    ).not.toThrow();
  });

  it("accepts a config without buildDaemonEnv (back-compat)", () => {
    expect(() =>
      configureDaemonRuntime({
        configDir: "/tmp/x",
        serverPath: "/tmp/x/server.mjs",
        bundledVersion: "0.8.41",
      }),
    ).not.toThrow();
  });
});
