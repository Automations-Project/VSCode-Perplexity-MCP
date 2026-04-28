import type { PerplexityClient } from "./client.js";

export interface CloudSyncProgressEvent {
  phase: "starting" | "syncing" | "done" | "cancelled" | "error";
  fetched?: number;
  total?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  error?: string;
}

export interface CloudSyncOptions {
  client?: PerplexityClient;
  getClient?: () => Promise<PerplexityClient>;
  onProgress?: (evt: CloudSyncProgressEvent) => void;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface CloudSyncResult {
  fetched: number;
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  cancelled: boolean;
}

export declare function syncCloudHistory(opts?: CloudSyncOptions): Promise<CloudSyncResult>;

export declare function hydrateCloudHistoryEntry(
  historyId: string,
  opts?: { client?: PerplexityClient },
): Promise<{ action: "skipped-local" | "skipped-hydrated" | "hydrated"; id?: string }>;
