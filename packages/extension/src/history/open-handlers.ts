import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import type { ExportFormat, ExtensionMessage, ExternalViewer } from "@perplexity-user-mcp/shared";
import {
  PerplexityClient,
  deleteEntry,
  get,
  getAttachmentsDir,
  pin,
  rebuildIndex,
  readHistory,
  tag,
  syncCloudHistory,
  hydrateCloudHistoryEntry,
} from "perplexity-user-mcp";
import { buildViewerUrl, listViewers, saveViewerConfig } from "perplexity-user-mcp/viewers";
import { detectAllViewers } from "perplexity-user-mcp/viewer-detect";

function requireEntry(historyId: string) {
  const entry = get(historyId);
  if (!entry) {
    throw new Error(`History entry '${historyId}' not found.`);
  }
  return entry;
}

export async function openPreview(historyId: string): Promise<void> {
  const entry = requireEntry(historyId);
  await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(entry.mdPath));
}

export async function openRichView(
  historyId: string,
  postMessage: (message: ExtensionMessage) => Thenable<boolean> | Promise<boolean | void> | boolean | void,
): Promise<void> {
  const entry = requireEntry(historyId);
  await postMessage({ type: "history:entry", payload: entry });
}

export async function listExternalViewers(): Promise<ExternalViewer[]> {
  const detected = await detectAllViewers();
  return listViewers().map((viewer) => ({
    ...viewer,
    detected: detected[viewer.id] ?? false,
  }));
}

export async function configureExternalViewer(viewer: ExternalViewer): Promise<ExternalViewer[]> {
  saveViewerConfig(viewer);
  return listExternalViewers();
}

export async function openExternalViewer(historyId: string, viewerId: string): Promise<void> {
  const entry = requireEntry(historyId);
  if (viewerId === "system") {
    await vscode.env.openExternal(vscode.Uri.file(entry.mdPath));
    return;
  }

  const viewers = await listExternalViewers();
  const viewer = viewers.find((item) => item.id === viewerId);
  if (!viewer) {
    throw new Error(`Unknown viewer '${viewerId}'.`);
  }

  const target = buildViewerUrl({ viewer, mdPath: entry.mdPath });
  await vscode.env.openExternal(vscode.Uri.parse(target));
}

export async function runExport(historyId: string, format: ExportFormat): Promise<{
  savedPath: string;
  bytes: number;
  contentType: string;
}> {
  const entry = requireEntry(historyId);
  const attachmentsDir = getAttachmentsDir(historyId) ?? entry.attachmentsDir;
  mkdirSync(attachmentsDir, { recursive: true });

  if (format === "markdown") {
    const savedPath = join(attachmentsDir, entry.mdPath.split(/[\\/]/).pop() || `${entry.id}.md`);
    const contents = readFileSync(entry.mdPath, "utf8");
    writeFileSync(savedPath, contents, "utf8");
    return {
      savedPath,
      bytes: Buffer.byteLength(contents),
      contentType: "text/markdown; charset=utf-8",
    };
  }

  if (!entry.threadSlug) {
    throw new Error("This history entry has no Perplexity thread slug, so only local markdown export is available.");
  }

  const client = new PerplexityClient();
  try {
    await client.init();
    const exported = await client.exportThread({ threadSlug: entry.threadSlug, format });
    const savedPath = join(attachmentsDir, exported.filename);
    mkdirSync(dirname(savedPath), { recursive: true });
    writeFileSync(savedPath, exported.buffer);
    return {
      savedPath,
      bytes: exported.buffer.length,
      contentType: exported.contentType,
    };
  } finally {
    await client.shutdown().catch(() => undefined);
  }
}

export function pinHistoryEntry(historyId: string, pinned: boolean) {
  return pin(historyId, pinned);
}

export function tagHistoryEntry(historyId: string, tags: string[]) {
  return tag(historyId, tags);
}

export function deleteHistoryEntry(historyId: string) {
  return deleteEntry(historyId);
}

export function rebuildHistoryEntries() {
  return rebuildIndex();
}

export function listHistoryEntries(limit = 50) {
  return readHistory({ limit });
}

export interface CloudSyncProgressPayload {
  phase: "starting" | "syncing" | "done" | "cancelled" | "error";
  fetched?: number;
  total?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  error?: string;
}

export async function runCloudSync(
  onProgress: (evt: CloudSyncProgressPayload) => void,
  opts: { pageSize?: number } = {},
): Promise<{ fetched: number; inserted: number; updated: number; skipped: number }> {
  const client = new PerplexityClient();
  try {
    await client.init();
    const result = await syncCloudHistory({
      client,
      pageSize: opts.pageSize,
      onProgress,
    });
    return {
      fetched: result.fetched,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
    };
  } finally {
    await client.shutdown().catch(() => undefined);
  }
}

export async function hydrateCloudEntry(historyId: string): Promise<{ action: "hydrated" | "skipped-local" | "skipped-hydrated" }> {
  const client = new PerplexityClient();
  try {
    await client.init();
    const res = await hydrateCloudHistoryEntry(historyId, { client });
    return { action: res.action };
  } finally {
    await client.shutdown().catch(() => undefined);
  }
}
