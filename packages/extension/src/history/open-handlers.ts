import * as vscode from "vscode";
import type { ExportFormat, ExtensionMessage, ExternalViewer } from "@perplexity-user-mcp/shared";
import {
  countAllHistory,
  deleteEntry,
  get,
  pin,
  rebuildIndex,
  readHistory,
  tag,
} from "perplexity-user-mcp";
import { buildViewerUrl, listViewers, saveViewerConfig } from "perplexity-user-mcp/viewers";
import { detectAllViewers } from "perplexity-user-mcp/viewer-detect";
import {
  exportHistoryFromDaemon,
  hydrateCloudEntryFromDaemon,
  syncCloudHistoryFromDaemon,
} from "../daemon/runtime.js";

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
  requireEntry(historyId);
  return exportHistoryFromDaemon(historyId, format);
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

export function countHistoryEntries(): number {
  return countAllHistory();
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
  return syncCloudHistoryFromDaemon(onProgress, opts);
}

export async function hydrateCloudEntry(historyId: string): Promise<{ action: "hydrated" | "skipped-local" | "skipped-hydrated" }> {
  return hydrateCloudEntryFromDaemon(historyId);
}
