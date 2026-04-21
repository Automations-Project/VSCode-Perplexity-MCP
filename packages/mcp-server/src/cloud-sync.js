import { PerplexityClient } from "./client.js";
import { hydrateCloudEntry, upsertFromCloud } from "./history-store.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGES = 200; // hard cap to avoid accidental runaway (20*200 = 4000 threads)

function firstAnswerPreview(firstAnswerJson) {
  if (typeof firstAnswerJson !== "string") return "";
  try {
    const parsed = JSON.parse(firstAnswerJson);
    if (typeof parsed?.answer === "string") return parsed.answer.slice(0, 220);
  } catch { /* ignore */ }
  return "";
}

function buildHydratedBody(entries) {
  const parts = [];
  for (const entry of entries) {
    if (entry.queryStr) parts.push(`### ${entry.queryStr}\n`);
    if (entry.answer) parts.push(entry.answer.trim(), "");
    if (entry.sources?.length) {
      parts.push("**Sources:**");
      for (const s of entry.sources) parts.push(`${s.n}. [${s.title || s.url}](${s.url})`);
      parts.push("");
    }
    if (entry.mediaItems?.length) {
      parts.push("**Media:**");
      for (const m of entry.mediaItems) parts.push(`- ${m.name ? `[${m.name}](${m.url})` : m.url}`);
      parts.push("");
    }
    parts.push("---", "");
  }
  return parts.join("\n").replace(/\n?---\n$/, "").trim();
}

/**
 * Sync the user's Perplexity library (all ask threads) into local history.
 * Merges by backend_uuid. Never touches local MCP-originated entries or the
 * bodies of already-hydrated cloud entries.
 *
 * @param {object} opts
 * @param {PerplexityClient} [opts.client]
 * @param {(evt: { phase: string; fetched?: number; total?: number; inserted?: number; updated?: number; skipped?: number; error?: string }) => void} [opts.onProgress]
 * @param {number} [opts.pageSize=20]
 * @param {AbortSignal} [opts.signal]
 */
export async function syncCloudHistory(opts = {}) {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const onProgress = opts.onProgress ?? (() => {});
  const signal = opts.signal;

  let ownsClient = false;
  let client = opts.client ?? null;
  if (!client) {
    client = new PerplexityClient();
    ownsClient = true;
    await client.init();
  }

  const stats = { fetched: 0, total: 0, inserted: 0, updated: 0, skipped: 0 };
  onProgress({ phase: "starting", ...stats });

  try {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (signal?.aborted) {
        onProgress({ phase: "cancelled", ...stats });
        return { ...stats, cancelled: true };
      }
      const { items, total } = await client.listCloudThreads({ limit: pageSize, offset });
      stats.total = Math.max(stats.total, total);
      if (items.length === 0) break;

      for (const row of items) {
        if (!row.backendUuid) continue;
        const preview = row.answerPreview || firstAnswerPreview(row.firstAnswer);
        const threadUrl = row.slug ? `https://www.perplexity.ai/search/${row.slug}` : undefined;
        const result = upsertFromCloud({
          backendUuid: row.backendUuid,
          query: row.queryStr || row.title,
          answerPreview: preview,
          createdAt: row.createdAt,
          threadUrl,
          threadSlug: row.slug,
          readWriteToken: row.readWriteToken,
          mode: row.mode,
          model: row.displayModel,
          sourceCount: row.sources?.length ?? 0,
          status: row.threadStatus === "completed" ? "completed" : "pending",
          tool: "perplexity_search",
        });
        if (result.action === "inserted") stats.inserted += 1;
        else if (result.action === "updated") stats.updated += 1;
        else stats.skipped += 1;
        stats.fetched += 1;
      }

      onProgress({ phase: "syncing", ...stats });

      if (items.length < pageSize) break; // reached end
      offset += pageSize;
    }

    onProgress({ phase: "done", ...stats });
    return { ...stats, cancelled: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ phase: "error", ...stats, error: message });
    throw err;
  } finally {
    if (ownsClient) await client.shutdown().catch(() => {});
  }
}

/**
 * Lazy-hydrate a single cloud entry — fetch full thread content and
 * replace the stub body. No-op if the entry is already hydrated or
 * isn't a cloud entry.
 *
 * @param {string} historyId
 * @param {object} [opts]
 * @param {PerplexityClient} [opts.client]
 * @returns {Promise<{ action: "skipped-local" | "skipped-hydrated" | "hydrated"; id?: string }>}
 */
export async function hydrateCloudHistoryEntry(historyId, opts = {}) {
  const { get } = await import("./history-store.js");
  const entry = get(historyId);
  if (!entry) throw new Error(`History entry '${historyId}' not found.`);
  if (entry.source !== "cloud") return { action: "skipped-local", id: entry.id };
  if (entry.cloudHydratedAt) return { action: "skipped-hydrated", id: entry.id };
  if (!entry.threadSlug) throw new Error(`Entry '${historyId}' has no threadSlug.`);

  let ownsClient = false;
  let client = opts.client ?? null;
  if (!client) {
    client = new PerplexityClient();
    ownsClient = true;
    await client.init();
  }

  try {
    const thread = await client.getCloudThread(entry.threadSlug);
    const body = buildHydratedBody(thread.entries);
    const firstEntry = thread.entries[0];
    const preview = firstEntry?.answer ? firstEntry.answer.replace(/\s+/g, " ").slice(0, 220) : entry.answerPreview;
    const allSources = thread.entries.flatMap((e) => e.sources ?? []);
    hydrateCloudEntry(entry.id, {
      body,
      sources: allSources.length ? allSources.map((s, i) => ({ ...s, n: i + 1 })) : entry.sources,
      answerPreview: preview,
      sourceCount: allSources.length || entry.sourceCount,
    });
    return { action: "hydrated", id: entry.id };
  } finally {
    if (ownsClient) await client.shutdown().catch(() => {});
  }
}
