import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.js";
import type { HistoryEntry } from "./format.js";

export const HISTORY_LIMIT = 50;

export interface HistoryItem extends HistoryEntry {
  id: string;
  createdAt: string;
}

const HISTORY_FILE = join(CONFIG_DIR, "history.json");

interface HistoryEnvelope {
  items: HistoryItem[];
}

function readEnvelope(): HistoryEnvelope {
  if (!existsSync(HISTORY_FILE)) {
    return { items: [] };
  }

  try {
    return JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as HistoryEnvelope;
  } catch {
    return { items: [] };
  }
}

function writeEnvelope(envelope: HistoryEnvelope): void {
  mkdirSync(dirname(HISTORY_FILE), { recursive: true });
  const tempPath = `${HISTORY_FILE}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  renameSync(tempPath, HISTORY_FILE);
}

export function getHistoryPath(): string {
  return HISTORY_FILE;
}

export function readHistory(limit = HISTORY_LIMIT): HistoryItem[] {
  return readEnvelope().items.slice(0, limit);
}

export function appendHistory(entry: Omit<HistoryItem, "id" | "createdAt"> & Partial<Pick<HistoryItem, "id" | "createdAt">>): HistoryItem {
  const item: HistoryItem = {
    id: entry.id ?? randomUUID(),
    createdAt: entry.createdAt ?? new Date().toISOString(),
    ...entry
  };

  const existing = readEnvelope();
  const next = [item, ...existing.items].slice(0, HISTORY_LIMIT);
  writeEnvelope({ items: next });
  return item;
}
