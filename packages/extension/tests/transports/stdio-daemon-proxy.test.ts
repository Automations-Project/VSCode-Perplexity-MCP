import { describe, expect, it } from "vitest";

import { stdioDaemonProxyBuilder } from "../../src/auto-config/transports/stdio-daemon-proxy.js";
import type { TransportBuildInput } from "../../src/auto-config/transports/index.js";

function baseInput(overrides: Partial<TransportBuildInput> = {}): TransportBuildInput {
  return {
    launcherPath: "/home/user/.perplexity-mcp/launcher.cjs",
    daemonPort: null,
    tunnelUrl: null,
    tunnelProviderId: null,
    tunnelReservedDomain: false,
    bearerKind: "none",
    ...overrides,
  };
}

describe("stdioDaemonProxyBuilder", () => {
  it("has id 'stdio-daemon-proxy'", () => {
    expect(stdioDaemonProxyBuilder.id).toBe("stdio-daemon-proxy");
  });

  it("declares support for both json and toml formats", () => {
    expect(stdioDaemonProxyBuilder.supportedFormats).toContain("json");
    expect(stdioDaemonProxyBuilder.supportedFormats).toContain("toml");
  });

  it("produces the minimal stdio proxy shape without PERPLEXITY_NO_DAEMON", () => {
    const result = stdioDaemonProxyBuilder.build(baseInput());

    expect(result).toEqual({
      command: process.execPath,
      args: ["/home/user/.perplexity-mcp/launcher.cjs"],
      env: { PERPLEXITY_HEADLESS_ONLY: "1" },
    });
    // Critical: proxy variant must NOT force the launcher into no-daemon mode.
    expect("env" in result ? result.env : {}).not.toHaveProperty("PERPLEXITY_NO_DAEMON");
  });

  it("honors an explicit nodePath override", () => {
    const result = stdioDaemonProxyBuilder.build(
      baseInput({ nodePath: "/usr/local/bin/node-custom" }),
    );

    expect("command" in result ? result.command : null).toBe("/usr/local/bin/node-custom");
    expect("args" in result ? result.args : []).toEqual([
      "/home/user/.perplexity-mcp/launcher.cjs",
    ]);
  });

  it("propagates chromePath into env when provided", () => {
    const result = stdioDaemonProxyBuilder.build(
      baseInput({ chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }),
    );

    const env = "env" in result ? result.env ?? {} : {};
    expect(env.PERPLEXITY_CHROME_PATH).toBe(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(env.PERPLEXITY_HEADLESS_ONLY).toBe("1");
    expect(env).not.toHaveProperty("PERPLEXITY_NO_DAEMON");
  });

  it("omits PERPLEXITY_CHROME_PATH when chromePath is absent", () => {
    const result = stdioDaemonProxyBuilder.build(baseInput());
    const env = "env" in result ? result.env ?? {} : {};
    expect(env).not.toHaveProperty("PERPLEXITY_CHROME_PATH");
  });

  it("throws TypeError when launcherPath is empty", () => {
    expect(() => stdioDaemonProxyBuilder.build(baseInput({ launcherPath: "" }))).toThrow(
      TypeError,
    );
    expect(() => stdioDaemonProxyBuilder.build(baseInput({ launcherPath: "" }))).toThrow(
      /launcherPath is required/,
    );
  });

  it("ignores bearerKind 'local' + localToken (no Authorization, no token in env)", () => {
    const result = stdioDaemonProxyBuilder.build(
      baseInput({
        bearerKind: "local",
        localToken: "super-secret-local-token-xyz",
      }),
    );

    // The stdio proxy transport never speaks HTTP, so bearer material must be dropped.
    expect(result).toEqual({
      command: process.execPath,
      args: ["/home/user/.perplexity-mcp/launcher.cjs"],
      env: { PERPLEXITY_HEADLESS_ONLY: "1" },
    });

    const env = "env" in result ? result.env ?? {} : {};
    for (const value of Object.values(env)) {
      expect(value).not.toContain("super-secret-local-token-xyz");
    }
    // Defensive: stdio entries never carry HTTP headers.
    expect(result).not.toHaveProperty("headers");
    expect(result).not.toHaveProperty("url");
  });
});
