import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readAuditTail } from "../../src/daemon/audit.ts";
import { startDaemonServer } from "../../src/daemon/server.ts";

function createMockClient() {
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

function readPackageVersion() {
  return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
}

describe("daemon server integration", () => {
  let configDir;
  let daemon;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-daemon-server-"));
    daemon = await startDaemonServer({
      configDir,
      version: "0.6.0-test",
      bearerToken: "test-bearer-token",
      createClient: () => createMockClient(),
    });
  });

  afterEach(async () => {
    await daemon?.close?.();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("returns 401 for /mcp requests without a bearer token", async () => {
    const response = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    expect(response.status).toBe(401);
  });

  it("uses the package version when no daemon version override is supplied", async () => {
    await daemon.close();
    daemon = await startDaemonServer({
      configDir,
      bearerToken: "test-bearer-token",
      createClient: () => createMockClient(),
    });

    expect(daemon.getHealth().version).toBe(readPackageVersion());
  });

  it("serves a real MCP roundtrip over streamable HTTP and writes an audit line", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${daemon.bearerToken}`,
          "x-perplexity-client-id": "integration-client",
        },
      },
    });
    const client = new Client({
      name: "integration-client",
      version: "1.0.0",
    }, {
      capabilities: {},
    });

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "perplexity_models")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "perplexity_sync_cloud")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "perplexity_hydrate_cloud_entry")).toBe(true);

    const result = await client.callTool({ name: "perplexity_models" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toMatch(/Account tier/i);

    // Phase 6a: security middleware also writes HTTP-level audit lines per
    // request (POST /mcp initialize, POST /mcp tools/call, GET /mcp SSE).
    // Filter down to the tool-call audit entry written by the tool handler.
    const auditTail = readAuditTail(10, { auditPath: daemon.auditPath });
    const toolEntry = auditTail.find((entry) => entry.tool === "perplexity_models");
    expect(toolEntry).toBeDefined();
    expect(toolEntry.clientId).toBe("integration-client");
    expect(toolEntry.ok).toBe(true);

    await client.close();
    await transport.close();
  });

  // Bug-1 regression: if options.onShutdown throws, the rest of the shutdown
  // sequence (httpServer.close) MUST still run. Previously, an onShutdown
  // rejection short-circuited close() and left the port bound.
  it("releases the port even when onShutdown throws", async () => {
    await daemon.close();

    let onShutdownCalls = 0;
    daemon = await startDaemonServer({
      configDir,
      version: "0.6.0-test",
      bearerToken: "test-bearer-token",
      createClient: () => createMockClient(),
      onShutdown: async () => {
        onShutdownCalls += 1;
        throw new Error("finalize blew up");
      },
    });

    const boundPort = daemon.port;
    expect(boundPort).toBeGreaterThan(0);

    // close() must resolve (not throw), onShutdown must have been called, and
    // the port must be free afterwards.
    await expect(daemon.close()).resolves.toBeUndefined();
    expect(onShutdownCalls).toBe(1);

    // The port is now free if we can bind another socket to it.
    const reclaimer = createServer();
    await new Promise((resolve, reject) => {
      reclaimer.once("error", reject);
      reclaimer.listen(boundPort, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => reclaimer.close(resolve));

    // Re-assign so the afterEach close() call is a no-op.
    daemon = { close: async () => undefined };
  });

  // Bug-3 regression: when the configured port is already in use, startup
  // must fail with an EADDRINUSE-shaped error and NOT leave a dangling
  // httpServer bound. Tests with a pinned port use the intentionally-busy
  // listener to force the conflict deterministically.
  it("surfaces EADDRINUSE when the pinned port is occupied", async () => {
    // Find a truly-unused port by binding, reading the assigned port, then
    // KEEPING the socket bound so the port is guaranteed occupied when the
    // daemon tries to listen. Event-based (no timing races).
    const squatter = createServer();
    await new Promise((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(0, "127.0.0.1", resolve);
    });
    const busyPort = squatter.address().port;

    try {
      await expect(
        startDaemonServer({
          configDir,
          version: "0.6.0-test",
          bearerToken: "pinned-port-test",
          createClient: () => createMockClient(),
          port: busyPort,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });
});
