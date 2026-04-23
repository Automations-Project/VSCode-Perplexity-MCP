import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { attachToDaemon } from "../../src/daemon/attach.ts";
import { startDaemon } from "../../src/daemon/launcher.ts";

function createMockClient() {
  return {
    authenticated: true,
    userId: "attach-test",
    accountInfo: {
      isMax: false,
      isPro: true,
      isEnterprise: false,
      canUseComputer: false,
      modelsConfig: null,
      rateLimits: null,
    },
    init: async () => undefined,
    reinit: async () => undefined,
    shutdown: async () => undefined,
  };
}

describe("daemon attach", () => {
  let configDir;
  let runtime;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-daemon-attach-"));
  });

  afterEach(async () => {
    await runtime?.close?.().catch(() => undefined);
    rmSync(configDir, { recursive: true, force: true });
  });

  it("proxies stdio MCP requests to the running daemon", async () => {
    runtime = await startDaemon({
      configDir,
      createClient: createMockClient,
    });

    const clientInput = new PassThrough();
    const clientOutput = new PassThrough();
    const attachPromise = attachToDaemon({
      configDir,
      stdin: clientInput,
      stdout: clientOutput,
      clientId: "attach-roundtrip",
    });

    const transport = new StdioServerTransport(clientOutput, clientInput);
    const client = new Client({
      name: "attach-roundtrip",
      version: "1.0.0",
    });

    await withTimeout(client.connect(transport), "client.connect");
    const tools = await withTimeout(client.listTools(), "client.listTools");
    expect(tools.tools.some((tool) => tool.name === "perplexity_models")).toBe(true);

    const response = await withTimeout(client.callTool({
      name: "perplexity_models",
      arguments: {},
    }), "client.callTool");
    expect(response.content[0]?.text).toMatch(/Account tier/i);

    await withTimeout(client.close(), "client.close");
    clientInput.end();
    clientOutput.end();
    await withTimeout(attachPromise, "attachPromise");
  }, 15_000);

  it("falls back to in-process stdio main() when daemon cannot start and fallbackStdio is true", async () => {
    const ensureError = new Error("boom: daemon refused to start");
    let ensureCalls = 0;
    let mainCalls = 0;

    const stderrChunks = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      await attachToDaemon({
        configDir,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        fallbackStdio: true,
        dependencies: {
          ensureDaemon: async () => {
            ensureCalls += 1;
            throw ensureError;
          },
          runStdioMain: async () => {
            mainCalls += 1;
          },
        },
      });
    } finally {
      process.stderr.write = origStderrWrite;
    }

    expect(ensureCalls).toBe(1);
    expect(mainCalls).toBe(1);
    const warning = stderrChunks.join("");
    expect(warning).toContain("[perplexity-mcp] daemon unreachable");
    expect(warning).toContain("boom: daemon refused to start");
    expect(warning).toContain("falling back to in-process stdio");
    expect(warning.endsWith("\n")).toBe(true);
  });

  it("rejects with the underlying error when fallbackStdio is false and daemon cannot start", async () => {
    const ensureError = new Error("no daemon here");
    let mainCalls = 0;

    await expect(
      attachToDaemon({
        configDir,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        fallbackStdio: false,
        dependencies: {
          ensureDaemon: async () => {
            throw ensureError;
          },
          runStdioMain: async () => {
            mainCalls += 1;
          },
        },
      }),
    ).rejects.toBe(ensureError);
    expect(mainCalls).toBe(0);
  });
});

async function withTimeout(promise, label) {
  return await Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), 2_000);
    }),
  ]);
}
