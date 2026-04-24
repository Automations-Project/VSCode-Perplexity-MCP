import { describe, expect, it } from "vitest";
import { stdioInProcessBuilder } from "../../src/auto-config/transports/stdio-in-process.js";
import type { TransportBuildInput } from "../../src/auto-config/transports/index.js";

/**
 * Helper: build a TransportBuildInput with sensible no-op defaults. Each test
 * overrides the fields it cares about via the `overrides` arg.
 *
 * Defaults chosen so unrelated paths stay inert: no tunnel, no daemon, no
 * bearer. `launcherPath` is the one field we require in nearly every happy-
 * path test, so it has a plausible default; tests exercising the "empty
 * launcher" error explicitly override it.
 */
function makeInput(overrides: Partial<TransportBuildInput> = {}): TransportBuildInput {
  return {
    launcherPath: "/home/user/.perplexity-mcp/start.mjs",
    daemonPort: null,
    tunnelUrl: null,
    tunnelProviderId: null,
    tunnelReservedDomain: false,
    bearerKind: "none",
    ...overrides,
  };
}

/** Narrowing helper — stdio builders produce the `{ command, args, env? }` arm. */
function assertCommandEntry(
  entry: ReturnType<typeof stdioInProcessBuilder.build>,
): asserts entry is { command: string; args: string[]; env?: Record<string, string> } {
  if (!("command" in entry)) {
    throw new Error(`expected stdio command entry, got ${JSON.stringify(entry)}`);
  }
}

describe("stdioInProcessBuilder", () => {
  it("has id 'stdio-in-process'", () => {
    expect(stdioInProcessBuilder.id).toBe("stdio-in-process");
  });

  it("supports both json and toml formats", () => {
    expect(stdioInProcessBuilder.supportedFormats).toEqual(
      expect.arrayContaining(["json", "toml"]),
    );
    expect(stdioInProcessBuilder.supportedFormats).toHaveLength(2);
  });

  it("produces the canonical in-process entry from minimal input", () => {
    const entry = stdioInProcessBuilder.build(
      makeInput({ launcherPath: "/home/user/.perplexity-mcp/start.mjs" }),
    );
    assertCommandEntry(entry);
    expect(entry).toEqual({
      command: process.execPath,
      args: ["/home/user/.perplexity-mcp/start.mjs"],
      env: {
        PERPLEXITY_HEADLESS_ONLY: "1",
        PERPLEXITY_NO_DAEMON: "1",
      },
    });
  });

  it("honors input.nodePath over process.execPath", () => {
    const entry = stdioInProcessBuilder.build(
      makeInput({ nodePath: "/usr/bin/node" }),
    );
    assertCommandEntry(entry);
    expect(entry.command).toBe("/usr/bin/node");
    // sanity: the builder should not accidentally fall back to execPath when
    // a custom nodePath is given.
    expect(entry.command).not.toBe(process.execPath);
  });

  it("falls back to process.execPath when nodePath is an empty string", () => {
    // Regression: earlier code used `input.nodePath ?? process.execPath`,
    // which only falls back on `undefined`/`null`. An empty string would leak
    // through as `command: ""` and the IDE's MCP client would fail to spawn
    // with an opaque error. Fix switched to `||`.
    const entry = stdioInProcessBuilder.build(makeInput({ nodePath: "" }));
    assertCommandEntry(entry);
    expect(entry.command).toBe(process.execPath);
    expect(entry.command).not.toBe("");
  });

  it("adds PERPLEXITY_CHROME_PATH to env when chromePath is set", () => {
    const entry = stdioInProcessBuilder.build(
      makeInput({ chromePath: "/opt/google/chrome/chrome" }),
    );
    assertCommandEntry(entry);
    expect(entry.env).toMatchObject({
      PERPLEXITY_HEADLESS_ONLY: "1",
      PERPLEXITY_NO_DAEMON: "1",
      PERPLEXITY_CHROME_PATH: "/opt/google/chrome/chrome",
    });
  });

  it("omits PERPLEXITY_CHROME_PATH when chromePath is undefined", () => {
    const entry = stdioInProcessBuilder.build(makeInput({ chromePath: undefined }));
    assertCommandEntry(entry);
    expect(entry.env).not.toHaveProperty("PERPLEXITY_CHROME_PATH");
  });

  it("omits PERPLEXITY_CHROME_PATH when chromePath is an empty string", () => {
    const entry = stdioInProcessBuilder.build(makeInput({ chromePath: "" }));
    assertCommandEntry(entry);
    expect(entry.env).not.toHaveProperty("PERPLEXITY_CHROME_PATH");
  });

  it("throws TypeError when launcherPath is empty", () => {
    expect(() => stdioInProcessBuilder.build(makeInput({ launcherPath: "" }))).toThrow(
      TypeError,
    );
    expect(() => stdioInProcessBuilder.build(makeInput({ launcherPath: "" }))).toThrow(
      /launcherPath is required/,
    );
  });

  it("throws TypeError when launcherPath is undefined (cast)", () => {
    // bearerKind is valid; we're specifically poking launcherPath. Cast at the
    // boundary because TransportBuildInput.launcherPath is typed as `string`
    // but the builder still needs to be defensive.
    const badInput = makeInput();
    (badInput as { launcherPath: string | undefined }).launcherPath = undefined;
    expect(() => stdioInProcessBuilder.build(badInput)).toThrow(TypeError);
  });

  it("ignores bearerKind='local' and localToken (stdio has no auth surface)", () => {
    const entry = stdioInProcessBuilder.build(
      makeInput({
        bearerKind: "local",
        localToken: "pplx_local_test_SECRETXXXXXXXXXXXXXXXXXXXXXXXX",
      }),
    );
    assertCommandEntry(entry);

    // No Authorization / bearer in env.
    expect(entry.env).not.toHaveProperty("Authorization");
    expect(entry.env).not.toHaveProperty("PERPLEXITY_BEARER");
    expect(entry.env).not.toHaveProperty("PERPLEXITY_TOKEN");

    // No bearer leaks anywhere else on the entry. Walk every string value and
    // make sure the token substring never appears.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("pplx_local_test_SECRET");
    expect(serialized).not.toContain("Bearer");

    // And the entry should be a pure command entry — no url/headers arm.
    expect(entry).not.toHaveProperty("url");
    expect(entry).not.toHaveProperty("headers");
  });

  it("ignores tunnel fields (they are meaningless for in-process stdio)", () => {
    const entry = stdioInProcessBuilder.build(
      makeInput({
        tunnelUrl: "https://abc.trycloudflare.com",
        tunnelProviderId: "cf-quick",
        tunnelReservedDomain: true,
        daemonPort: 57321,
      }),
    );
    assertCommandEntry(entry);
    // Env still only carries the in-process flags — nothing about tunnels/ports.
    expect(entry.env).toEqual({
      PERPLEXITY_HEADLESS_ONLY: "1",
      PERPLEXITY_NO_DAEMON: "1",
    });
    expect(entry.args).toEqual([makeInput().launcherPath]);
  });
});
