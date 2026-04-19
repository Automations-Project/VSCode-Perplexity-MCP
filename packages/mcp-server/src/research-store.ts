import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { CONFIG_DIR, type SearchResult, type ASIFile } from "./config.js";

export interface SavedResearch {
  id: string;
  query: string;
  tool: string;
  model: string | null;
  mode: string | null;
  language: string | null;
  status: "completed" | "pending" | "failed";
  createdAt: string;
  completedAt?: string;
  threadSlug: string | null;
  backendUuid: string | null;
  readWriteToken?: string | null;
  threadUrl?: string;
  answer?: string;
  reasoning?: string;
  sources?: Array<{ title: string; url: string; snippet: string }>;
  media?: Array<{ type: string; url: string; name: string }>;
  files?: ASIFile[];
  suggestedFollowups?: string[];
  error?: string;
}

const RESEARCH_DIR = join(CONFIG_DIR, "researches");
const MAX_RESEARCHES = 200;

function ensureDir(): void {
  if (!existsSync(RESEARCH_DIR)) {
    mkdirSync(RESEARCH_DIR, { recursive: true });
  }
}

function researchPath(id: string): string {
  return join(RESEARCH_DIR, `${id}.json`);
}

export function saveResearch(opts: {
  query: string;
  tool: string;
  model: string | null;
  mode: string | null;
  language: string | null;
  threadSlug: string | null;
  backendUuid: string | null;
  readWriteToken?: string | null;
  result?: SearchResult;
  error?: string;
}): SavedResearch {
  ensureDir();

  const id = randomUUID();
  const now = new Date().toISOString();
  const hasResult = !!opts.result?.answer && !opts.result.answer.startsWith("ASI task timed out");

  const research: SavedResearch = {
    id,
    query: opts.query,
    tool: opts.tool,
    model: opts.model,
    mode: opts.mode,
    language: opts.language,
    status: opts.error ? "failed" : hasResult ? "completed" : "pending",
    createdAt: now,
    completedAt: hasResult ? now : undefined,
    threadSlug: opts.threadSlug,
    backendUuid: opts.backendUuid,
    readWriteToken: opts.readWriteToken,
    threadUrl: opts.result?.threadUrl,
    answer: opts.result?.answer,
    reasoning: opts.result?.reasoning,
    sources: opts.result?.sources,
    media: opts.result?.media,
    files: opts.result?.files,
    suggestedFollowups: opts.result?.suggestedFollowups,
    error: opts.error,
  };

  writeFileSync(researchPath(id), JSON.stringify(research, null, 2));

  // Prune oldest if over limit
  pruneOldResearches();

  return research;
}

export function updateResearch(id: string, updates: Partial<SavedResearch>): SavedResearch | null {
  const existing = getResearch(id);
  if (!existing) return null;

  const updated = { ...existing, ...updates };
  writeFileSync(researchPath(id), JSON.stringify(updated, null, 2));
  return updated;
}

export function getResearch(id: string): SavedResearch | null {
  const path = researchPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SavedResearch;
  } catch {
    return null;
  }
}

export function listResearches(opts?: {
  status?: "completed" | "pending" | "failed";
  tool?: string;
  limit?: number;
}): SavedResearch[] {
  ensureDir();

  const limit = opts?.limit ?? 50;
  const files = readdirSync(RESEARCH_DIR).filter(f => f.endsWith(".json"));

  const researches: SavedResearch[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(RESEARCH_DIR, file), "utf-8")) as SavedResearch;
      if (opts?.status && data.status !== opts.status) continue;
      if (opts?.tool && data.tool !== opts.tool) continue;
      researches.push(data);
    } catch { /* skip corrupt files */ }
  }

  // Sort newest first
  researches.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return researches.slice(0, limit);
}

export function findPendingByThread(threadSlug: string): SavedResearch | null {
  ensureDir();
  const files = readdirSync(RESEARCH_DIR).filter(f => f.endsWith(".json"));
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(RESEARCH_DIR, file), "utf-8")) as SavedResearch;
      if (data.threadSlug === threadSlug && data.status === "pending") {
        return data;
      }
    } catch { /* skip */ }
  }
  return null;
}

export function deleteResearch(id: string): boolean {
  const path = researchPath(id);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function pruneOldResearches(): void {
  const all = listResearches({ limit: MAX_RESEARCHES + 50 });
  if (all.length <= MAX_RESEARCHES) return;

  const toDelete = all.slice(MAX_RESEARCHES);
  for (const r of toDelete) {
    deleteResearch(r.id);
  }
}
