import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDaemonServer } from "../../src/daemon/server.ts";

// Regression: getClient() previously cached a rejected clientInitPromise on
// init() failure, poisoning every subsequent call for the daemon's lifetime
// (observed 2026-04-26 — same pid + same playwright temp profile dir reused
// across 4 unrelated tool calls over 20 minutes, durations dropped from
// 1542 ms to 0–32 ms because the cached rejection short-circuited).

function makeMockClient() {
  return {
    authenticated: true,
    userId: "user-test",
    accountInfo: {
      isMax: false,
      isPro: true,
      isEnterprise: false,
      canUseComputer: false,
      modelsConfig: null,
      rateLimits: null,
    },
    init: async () => undefined,
    shutdown: async () => undefined,
  };
}

describe("daemon getClient init retry", () => {
  let configDir;
  let daemon;
  let prevConfigDir;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-getclient-retry-"));
    // Point the cache-resolver helpers (which read the global config dir
    // via `getActivePaths`) at our empty tempdir so `perplexity_models`
    // misses the on-disk cache and exercises the getClient init path
    // this test is about. Without this the cache short-circuits the
    // call and init() is never invoked. (0.8.27 — Agent C cache path.)
    prevConfigDir = process.env.PERPLEXITY_CONFIG_DIR;
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    await daemon?.close?.();
    rmSync(configDir, { recursive: true, force: true });
    if (prevConfigDir === undefined) delete process.env.PERPLEXITY_CONFIG_DIR;
    else process.env.PERPLEXITY_CONFIG_DIR = prevConfigDir;
  });

  it("constructs a fresh client and retries init() after a rejected init", async () => {
    let createCalls = 0;
    let initCalls = 0;

    daemon = await startDaemonServer({
      configDir,
      version: "0.7.2-test",
      bearerToken: "retry-token",
      createClient: () => {
        createCalls += 1;
        const c = makeMockClient();
        c.init = async () => {
          initCalls += 1;
          if (initCalls === 1) {
            throw new Error("init failed: browser launch transient");
          }
        };
        return c;
      },
    });

    const callModels = async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${daemon.bearerToken}`,
            "x-perplexity-client-id": "retry-test",
          },
        },
      });
      const client = new Client({ name: "retry-test", version: "1.0.0" }, { capabilities: {} });
      try {
        await client.connect(transport);
        return await client.callTool({ name: "perplexity_models" });
      } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }
    };

    const first = await callModels();
    expect(first.isError).toBe(true);
    expect(JSON.stringify(first.content)).toMatch(/init failed/i);

    const second = await callModels();
    expect(second.isError).toBeFalsy();
    expect(second.content[0]?.type).toBe("text");
    expect(second.content[0]?.text).toMatch(/Account tier/i);

    expect(createCalls).toBe(2);
    expect(initCalls).toBe(2);
  });
});
