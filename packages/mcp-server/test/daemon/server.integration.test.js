import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
