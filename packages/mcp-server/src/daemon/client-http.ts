import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { TextDecoder } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureDaemon, type EnsureDaemonOptions } from "./launcher.js";

type DaemonEnsureOptions = Pick<
  EnsureDaemonOptions,
  "configDir" | "host" | "port" | "tunnel" | "startTimeoutMs" | "pollIntervalMs" | "healthTimeoutMs" | "spawnDaemon"
>;

export interface DaemonClientRequestOptions extends DaemonEnsureOptions {
  clientId?: string;
  source?: "loopback" | "tunnel";
}

export interface DaemonExportResult {
  savedPath: string;
  bytes: number;
  contentType: string;
}

export interface DaemonCloudSyncProgress {
  phase: "starting" | "syncing" | "done" | "cancelled" | "error";
  fetched?: number;
  total?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  error?: string;
}

export interface DaemonCloudSyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export interface DaemonHydrateResult {
  action: "hydrated" | "skipped-local" | "skipped-hydrated";
}

export async function exportHistoryViaDaemon(
  historyId: string,
  format: "pdf" | "markdown" | "docx",
  options: DaemonClientRequestOptions = {},
): Promise<DaemonExportResult> {
  const clientId = options.clientId ?? `daemon-export-${randomUUID()}`;
  const result = await callDaemonTool(
    "perplexity_export",
    {
      history_id: historyId,
      format,
    },
    { ...options, clientId },
  );
  const savedPath = extractBacktickedPath(result.text);
  const bytes = statSync(savedPath).size;
  return {
    savedPath,
    bytes,
    contentType: getExportContentType(format),
  };
}

export async function syncCloudHistoryViaDaemon(
  options: DaemonClientRequestOptions & {
    pageSize?: number;
    onProgress?: (progress: DaemonCloudSyncProgress) => void;
  } = {},
): Promise<DaemonCloudSyncResult> {
  const clientId = options.clientId ?? `daemon-sync-${randomUUID()}`;
  const daemon = await ensureDaemon(options);
  const relay = options.onProgress
    ? await subscribeToToolProgress(daemon, clientId, "perplexity_sync_cloud", options.onProgress)
    : null;

  try {
    const result = await callDaemonTool(
      "perplexity_sync_cloud",
      options.pageSize ? { page_size: options.pageSize } : {},
      { ...options, clientId },
    );
    await relay?.waitForPhase("done", 250).catch(() => undefined);
    return parseCloudSyncResult(result.text);
  } finally {
    await relay?.close();
  }
}

export async function hydrateCloudHistoryEntryViaDaemon(
  historyId: string,
  options: DaemonClientRequestOptions = {},
): Promise<DaemonHydrateResult> {
  const clientId = options.clientId ?? `daemon-hydrate-${randomUUID()}`;
  const result = await callDaemonTool(
    "perplexity_hydrate_cloud_entry",
    {
      history_id: historyId,
    },
    { ...options, clientId },
  );
  return parseHydrateResult(result.text);
}

async function callDaemonTool(
  name: string,
  args: Record<string, unknown>,
  options: DaemonClientRequestOptions,
): Promise<{ text: string }> {
  const daemon = await ensureDaemon(options);
  const clientId = options.clientId ?? `daemon-client-${randomUUID()}`;
  const transport = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${daemon.bearerToken}`,
        "x-perplexity-client-id": clientId,
        "x-perplexity-source": options.source ?? "loopback",
      },
    },
  });
  const client = new Client(
    {
      name: clientId,
      version: "0.5.0",
    },
    {
      capabilities: {},
    },
  );

  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      throw new Error(getToolText(result));
    }
    return { text: getToolText(result) };
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

async function subscribeToToolProgress(
  daemon: Awaited<ReturnType<typeof ensureDaemon>>,
  clientId: string,
  tool: string,
  onProgress: (progress: DaemonCloudSyncProgress) => void,
): Promise<{
  close: () => Promise<void>;
  waitForPhase: (phase: DaemonCloudSyncProgress["phase"], timeoutMs: number) => Promise<void>;
}> {
  const controller = new AbortController();
  const phaseWaiters = new Map<string, Array<() => void>>();
  const seenPhases = new Set<string>();
  const response = await fetch(`${daemon.url}/daemon/events`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${daemon.bearerToken}`,
      "x-perplexity-client-id": clientId,
    },
    signal: controller.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Could not subscribe to daemon events (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = consumeSseFrames(buffer, (event, payload) => {
          if (event !== "daemon:tool-progress") {
            return;
          }
          if (payload?.clientId !== clientId || payload?.tool !== tool) {
            return;
          }
          const progress = payload.progress as DaemonCloudSyncProgress;
          seenPhases.add(progress.phase);
          onProgress(progress);
          const waiters = phaseWaiters.get(progress.phase);
          if (!waiters?.length) {
            return;
          }
          phaseWaiters.delete(progress.phase);
          for (const resolve of waiters) {
            resolve();
          }
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        throw error;
      }
    }
  })();

  return {
    close: async () => {
      controller.abort();
      await drain.catch(() => undefined);
    },
    waitForPhase: async (phase: DaemonCloudSyncProgress["phase"], timeoutMs: number) => {
      if (seenPhases.has(phase)) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        let wrappedResolve: (() => void) | undefined;
        const timer = setTimeout(() => {
          const waiters = phaseWaiters.get(phase);
          if (waiters && wrappedResolve) {
            phaseWaiters.set(phase, waiters.filter((candidate) => candidate !== wrappedResolve));
          }
          reject(new Error(`Timed out waiting for daemon progress phase '${phase}'.`));
        }, timeoutMs);
        wrappedResolve = () => {
          clearTimeout(timer);
          resolve();
        };
        const waiters = phaseWaiters.get(phase) ?? [];
        waiters.push(wrappedResolve);
        phaseWaiters.set(phase, waiters);
      });
    },
  };
}

function consumeSseFrames(
  buffer: string,
  onFrame: (event: string, payload: Record<string, unknown>) => void,
): string {
  while (true) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary < 0) {
      return buffer;
    }

    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    if (!frame.trim()) {
      continue;
    }

    let event = "message";
    const dataLines: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (rawLine.startsWith("event:")) {
        event = rawLine.slice(6).trim();
      } else if (rawLine.startsWith("data:")) {
        dataLines.push(rawLine.slice(5).trim());
      }
    }

    if (!dataLines.length) {
      continue;
    }

    try {
      onFrame(event, JSON.parse(dataLines.join("\n")) as Record<string, unknown>);
    } catch {
      // Ignore malformed daemon events.
    }
  }
}

function parseCloudSyncResult(text: string): DaemonCloudSyncResult {
  const match = text.match(/fetched=(\d+)\s+inserted=(\d+)\s+updated=(\d+)\s+skipped=(\d+)/i);
  if (!match) {
    throw new Error(`Could not parse cloud sync result: ${text}`);
  }
  return {
    fetched: Number(match[1]),
    inserted: Number(match[2]),
    updated: Number(match[3]),
    skipped: Number(match[4]),
  };
}

function parseHydrateResult(text: string): DaemonHydrateResult {
  const match = text.match(/^Cloud hydrate ([a-z-]+):/i);
  if (!match) {
    throw new Error(`Could not parse cloud hydrate result: ${text}`);
  }

  const action = match[1] as DaemonHydrateResult["action"];
  if (action !== "hydrated" && action !== "skipped-local" && action !== "skipped-hydrated") {
    throw new Error(`Unexpected cloud hydrate action '${action}'.`);
  }

  return { action };
}

function getToolText(result: any): string {
  const textItem = result?.content?.find?.((item: any) => item?.type === "text" && typeof item.text === "string");
  if (typeof textItem?.text !== "string" || textItem.text.length === 0) {
    throw new Error("Daemon tool response did not contain text output.");
  }
  return textItem.text;
}

function extractBacktickedPath(text: string): string {
  const match = text.match(/`([^`]+)`/);
  if (!match?.[1]) {
    throw new Error(`Could not parse saved path from daemon export response: ${text}`);
  }
  return match[1];
}

function getExportContentType(format: "pdf" | "markdown" | "docx"): string {
  if (format === "markdown") {
    return "text/markdown; charset=utf-8";
  }
  if (format === "pdf") {
    return "application/pdf";
  }
  return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}
