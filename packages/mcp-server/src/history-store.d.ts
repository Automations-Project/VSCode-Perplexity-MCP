import type { HistoryEntryDetail, HistoryItem } from "@perplexity-user-mcp/shared";

export interface HistoryStoreEntryInput extends Partial<HistoryItem> {
  tool: string;
  query: string;
  body?: string;
}

export interface RebuildIndexResult {
  scanned: number;
  recovered: number;
  skipped: number;
  items: Array<HistoryItem & { filename: string }>;
}

export declare const HISTORY_LIMIT: number;
export declare function getHistoryDir(): string;
export declare function getAttachmentsRoot(): string;
export declare function getIndexPath(): string;
export declare function append(entry: HistoryStoreEntryInput): HistoryItem;
export declare function update(id: string, patch?: Partial<HistoryStoreEntryInput> & { body?: string }): HistoryItem | null;
export declare function list(options?: {
  limit?: number;
  status?: "completed" | "pending" | "failed";
  tool?: string;
  tools?: string[];
  filter?: string;
}): HistoryItem[];
export declare function get(id: string): HistoryEntryDetail | null;
export declare function deleteEntry(id: string): boolean;
export declare function pin(id: string, pinned: boolean): HistoryItem | null;
export declare function tag(id: string, tags: string[]): HistoryItem | null;
export declare function rebuildIndex(): RebuildIndexResult;
export declare function getMdPath(id: string): string | null;
export declare function getAttachmentsDir(id: string): string | null;
export declare function findPendingByThread(threadSlug: string): HistoryItem | null;
export declare function appendHistory(entry: HistoryStoreEntryInput): HistoryItem;
export declare function readHistory(limit?: number): HistoryItem[];

export interface CloudUpsertMeta {
  backendUuid: string;
  query?: string;
  answerPreview?: string;
  createdAt?: string;
  threadUrl?: string;
  threadSlug?: string | null;
  readWriteToken?: string | null;
  mode?: string | null;
  model?: string | null;
  sourceCount?: number;
  status?: "completed" | "pending" | "failed";
  tool?: string;
  tier?: HistoryItem["tier"];
  language?: string | null;
}

export declare function findByBackendUuid(backendUuid: string | null | undefined): (HistoryItem & { filename: string }) | null;
export declare function upsertFromCloud(meta: CloudUpsertMeta): { action: "inserted" | "updated" | "skipped-local"; id: string };
export declare function hydrateCloudEntry(
  id: string,
  payload: { body?: string; sources?: HistoryItem["sources"]; attachments?: HistoryItem["attachments"]; answerPreview?: string; sourceCount?: number },
): HistoryItem | null;
