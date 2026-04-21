import type { Readable, Writable } from "node:stream";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureDaemon } from "./launcher.js";

export interface AttachToDaemonOptions {
  configDir?: string;
  stdin?: Readable;
  stdout?: Writable;
  clientId?: string;
}

export async function attachToDaemon(options: AttachToDaemonOptions = {}): Promise<void> {
  const daemon = await ensureDaemon({ configDir: options.configDir });
  const sourceIn = options.stdin ?? process.stdin;
  const sourceOut = options.stdout ?? process.stdout;
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

  await Promise.all([stdio.start(), http.start()]);
  await completion;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
