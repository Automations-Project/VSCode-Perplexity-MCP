import type { Readable, Writable } from "node:stream";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureDaemon } from "./launcher.js";

export class DaemonAttachError extends Error {
  readonly code = "DAEMON_UNREACHABLE";
  readonly remediation: readonly string[];
  override readonly cause?: unknown;
  constructor(message: string, remediation: readonly string[], cause?: unknown) {
    super(message);
    this.name = "DaemonAttachError";
    this.remediation = remediation;
    if (cause !== undefined) this.cause = cause;
  }
}

const DEFAULT_REMEDIATION: readonly string[] = [
  "Reload the VS Code window so the extension restarts the daemon.",
  "In the VS Code Perplexity dashboard, switch this client's transport to http-loopback.",
  "(Advanced) Set PERPLEXITY_NO_DAEMON=1 in this client's MCP env block, then run `npx perplexity-user-mcp setup-vault` once.",
] as const;

export interface AttachToDaemonOptions {
  configDir?: string;
  stdin?: Readable;
  stdout?: Writable;
  clientId?: string;
  /**
   * When true, any failure to reach/start the daemon (or wire up the HTTP
   * transport) falls back to running the in-process stdio MCP `main()` so the
   * client still gets a working server. A single machine-parseable warning is
   * written to stderr before the fallback. When false/omitted, the original
   * error propagates to the caller.
   */
  fallbackStdio?: boolean;
  /**
   * Propagated to `ensureDaemon` as `startTimeoutMs`. Defaults to 15_000 when
   * unset (same default as the launcher).
   */
  ensureTimeoutMs?: number;
  /**
   * Test-only dependency injection seam. Not exposed through the CLI.
   */
  dependencies?: {
    ensureDaemon?: typeof ensureDaemon;
    runStdioMain?: () => Promise<void>;
  };
}

export async function attachToDaemon(options: AttachToDaemonOptions = {}): Promise<void> {
  const ensure = options.dependencies?.ensureDaemon ?? ensureDaemon;
  const sourceIn = options.stdin ?? process.stdin;
  const sourceOut = options.stdout ?? process.stdout;

  let daemon: Awaited<ReturnType<typeof ensureDaemon>>;
  try {
    daemon = await ensure({
      configDir: options.configDir,
      startTimeoutMs: options.ensureTimeoutMs ?? 15_000,
    });
  } catch (error) {
    if (options.fallbackStdio) {
      await runFallback(error, options);
      return;
    }
    throw new DaemonAttachError(
      `Cannot reach the extension-managed daemon: ${asError(error).message}`,
      DEFAULT_REMEDIATION,
      error,
    );
  }

  const stdio = new StdioServerTransport(sourceIn, sourceOut);
  const http = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${daemon.bearerToken}`,
        "x-perplexity-client-id": options.clientId ?? `daemon-attach-${process.pid}`,
        "x-perplexity-source": "loopback",
      },
    },
  });

  const completion = new Promise<void>((resolve, reject) => {
    let settled = false;
    const handleInputClosed = () => settle();

    const settle = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      sourceIn.off("end", handleInputClosed);
      sourceIn.off("close", handleInputClosed);
      void Promise.all([
        http.close().catch(() => undefined),
        stdio.close().catch(() => undefined),
      ]).finally(() => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    };

    stdio.onmessage = (message) => {
      void http.send(message).catch((error) => settle(asError(error)));
    };
    stdio.onclose = () => settle();
    stdio.onerror = (error) => settle(error);

    http.onmessage = (message) => {
      void stdio.send(message).catch((error) => settle(asError(error)));
    };
    http.onclose = () => settle();
    http.onerror = (error) => settle(error);

    sourceIn.on("end", handleInputClosed);
    sourceIn.on("close", handleInputClosed);
  });

  try {
    await Promise.all([stdio.start(), http.start()]);
  } catch (error) {
    // Clean up both transports so we don't leak handles before falling back.
    await Promise.all([
      stdio.close().catch(() => undefined),
      http.close().catch(() => undefined),
    ]);
    if (options.fallbackStdio) {
      await runFallback(error, options);
      return;
    }
    throw new DaemonAttachError(
      `Daemon attached but transport failed to start: ${asError(error).message}`,
      DEFAULT_REMEDIATION,
      error,
    );
  }
  await completion;
}

async function runFallback(error: unknown, options: AttachToDaemonOptions): Promise<void> {
  const reason = truncate(asError(error).message, 120);
  // Must go to stderr — stdout is the stdio MCP framed JSON-RPC channel.
  process.stderr.write(
    `[perplexity-mcp] daemon unreachable (${reason}); falling back to in-process stdio\n`,
  );
  const runStdioMain =
    options.dependencies?.runStdioMain ??
    (async () => {
      const mod = await import("../index.js");
      await mod.main();
    });
  await runStdioMain();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
