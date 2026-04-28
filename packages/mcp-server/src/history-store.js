import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import matter from "gray-matter";
import { getActiveName, getProfilePaths } from "./profiles.js";

export const HISTORY_LIMIT = 50;
const INDEX_VERSION = 2;

function getActiveProfileName() {
  return process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
}

function getActivePaths() {
  return getProfilePaths(getActiveProfileName());
}

export function getHistoryDir() {
  return getActivePaths().history;
}

export function getAttachmentsRoot() {
  return getActivePaths().attachments;
}

export function getIndexPath() {
  return join(getHistoryDir(), "index.json");
}

function ensureStoreDirs() {
  mkdirSync(getHistoryDir(), { recursive: true });
  mkdirSync(getAttachmentsRoot(), { recursive: true });
}

function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, contents);
  renameSync(tempPath, path);
}

function stripInternal(record) {
  const { filename, body, mdPath, attachmentsDir, ...item } = record;
  return item;
}

function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function buildPreview(body, error) {
  if (error) return collapseWhitespace(error).slice(0, 220);
  return collapseWhitespace(body).slice(0, 220);
}

function slugifyQuery(query) {
  const normalized = String(query ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .replace(/[-\s]+/g, " ")
    .trim()
    .toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean).slice(0, 6);
  const slug = words.join("-").slice(0, 60).replace(/^-+|-+$/g, "");
  return slug || "entry";
}

function isoFileStamp(createdAt) {
  return String(createdAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(toArray(values).map((value) => String(value).trim()).filter(Boolean))];
}

function cleanSources(sources) {
  return toArray(sources)
    .map((source, index) => ({
      n: typeof source?.n === "number" ? source.n : index + 1,
      title: String(source?.title ?? "").trim(),
      url: String(source?.url ?? "").trim(),
      ...(source?.snippet ? { snippet: String(source.snippet) } : {}),
    }))
    .filter((source) => source.title || source.url);
}

function cleanAttachments(attachments) {
  return toArray(attachments)
    .map((attachment) => ({
      filename: String(attachment?.filename ?? "").trim(),
      relPath: String(attachment?.relPath ?? "").replace(/\\/g, "/").trim(),
      ...(attachment?.mimeType ? { mimeType: String(attachment.mimeType) } : {}),
      ...(typeof attachment?.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
      ...(attachment?.kind ? { kind: attachment.kind } : {}),
    }))
    .filter((attachment) => attachment.filename && attachment.relPath);
}

function normalizeStatus(value, error) {
  if (value === "completed" || value === "pending" || value === "failed") {
    return value;
  }
  return error ? "failed" : "completed";
}

function normalizeEntry(entry, body) {
  const createdAt = typeof entry?.createdAt === "string" && entry.createdAt
    ? entry.createdAt
    : new Date().toISOString();
  const error = entry?.error ? String(entry.error) : undefined;
  const sources = cleanSources(entry?.sources);
  const attachments = cleanAttachments(entry?.attachments);
  const status = normalizeStatus(entry?.status, error);
  const answerPreview = entry?.answerPreview
    ? String(entry.answerPreview).slice(0, 220)
    : buildPreview(body, error);
  const sourceCount = typeof entry?.sourceCount === "number" ? entry.sourceCount : sources.length;
  const tier = entry?.tier ?? undefined;
  const normalized = {
    id: entry?.id ? String(entry.id) : randomUUID(),
    tool: String(entry?.tool ?? "perplexity_search"),
    query: String(entry?.query ?? ""),
    model: entry?.model ?? null,
    mode: entry?.mode ?? null,
    language: entry?.language ?? null,
    createdAt,
    answerPreview,
    sourceCount,
    ...(entry?.threadUrl ? { threadUrl: String(entry.threadUrl) } : {}),
    ...(status ? { status } : {}),
    ...(entry?.completedAt ? { completedAt: String(entry.completedAt) } : status === "completed" ? { completedAt: createdAt } : {}),
    ...(tier ? { tier } : {}),
    ...(entry?.threadSlug !== undefined ? { threadSlug: entry.threadSlug ?? null } : {}),
    ...(entry?.backendUuid !== undefined ? { backendUuid: entry.backendUuid ?? null } : {}),
    ...(entry?.readWriteToken !== undefined ? { readWriteToken: entry.readWriteToken ?? null } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(uniqueStrings(entry?.tags).length > 0 ? { tags: uniqueStrings(entry.tags) } : {}),
    ...(entry?.pinned !== undefined ? { pinned: !!entry.pinned } : {}),
    ...(entry?.source ? { source: String(entry.source) } : {}),
    ...(entry?.cloudHydratedAt ? { cloudHydratedAt: String(entry.cloudHydratedAt) } : {}),
    ...(error ? { error } : {}),
  };

  return normalized;
}

function buildFilename(createdAt, query) {
  return `${isoFileStamp(createdAt)}-${slugifyQuery(query)}.md`;
}

function ensureUniqueFilename(baseFilename) {
  const historyDir = getHistoryDir();
  let filename = baseFilename;
  let attempt = 1;
  while (existsSync(join(historyDir, filename))) {
    const suffix = `-${attempt}`;
    filename = baseFilename.endsWith(".md")
      ? `${baseFilename.slice(0, -3)}${suffix}.md`
      : `${baseFilename}${suffix}.md`;
    attempt += 1;
  }
  return filename;
}

function toFrontmatter(entry) {
  const frontmatter = {
    id: entry.id,
    tool: entry.tool,
    query: entry.query,
    model: entry.model,
    mode: entry.mode,
    language: entry.language,
    createdAt: entry.createdAt,
    answerPreview: entry.answerPreview,
    sourceCount: entry.sourceCount,
    threadUrl: entry.threadUrl,
    status: entry.status,
    completedAt: entry.completedAt,
    tier: entry.tier,
    threadSlug: entry.threadSlug,
    backendUuid: entry.backendUuid,
    readWriteToken: entry.readWriteToken,
    sources: entry.sources,
    attachments: entry.attachments,
    tags: entry.tags,
    pinned: entry.pinned,
    source: entry.source,
    cloudHydratedAt: entry.cloudHydratedAt,
    error: entry.error,
  };

  const cleaned = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function serializeRecord(entry, body) {
  const content = body ? String(body).trimEnd() : "";
  return `${matter.stringify(content, toFrontmatter(entry)).trimEnd()}\n`;
}

function parseMarkdownFile(path, filenameOverride) {
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  const filename = filenameOverride ?? basename(path);
  const stem = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
  const body = String(parsed.content ?? "").trim();
  const normalized = normalizeEntry(parsed.data ?? {}, body);
  if (!normalized.id || !normalized.query || !normalized.tool) {
    return null;
  }

  return {
    ...normalized,
    filename,
    body,
    mdPath: path,
    attachmentsDir: join(getAttachmentsRoot(), stem),
  };
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => {
    const rightTime = Date.parse(right.createdAt ?? "") || 0;
    const leftTime = Date.parse(left.createdAt ?? "") || 0;
    return rightTime - leftTime;
  });
}

function writeIndex(entries) {
  const payload = {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    items: sortEntries(entries).map((entry) => ({
      filename: entry.filename,
      ...stripInternal(entry),
    })),
  };
  atomicWrite(getIndexPath(), `${JSON.stringify(payload, null, 2)}\n`);
}

function readIndex() {
  if (!existsSync(getIndexPath())) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(getIndexPath(), "utf8"));
    if (raw?.version !== INDEX_VERSION || !Array.isArray(raw.items)) {
      return null;
    }
    return raw.items.map((entry) => ({
      ...entry,
      filename: String(entry.filename ?? ""),
    }));
  } catch {
    return null;
  }
}

function loadIndexedEntries() {
  ensureStoreDirs();
  const indexed = readIndex();
  if (indexed) {
    return sortEntries(indexed);
  }
  return rebuildIndex().items;
}

function readRecordByFilename(filename) {
  const mdPath = join(getHistoryDir(), filename);
  if (!existsSync(mdPath)) {
    return null;
  }
  return parseMarkdownFile(mdPath, filename);
}

function findIndexedEntry(id) {
  return loadIndexedEntries().find((entry) => entry.id === id) ?? null;
}

function resolveRecord(id) {
  const indexed = findIndexedEntry(id);
  if (!indexed) {
    return null;
  }

  const record = readRecordByFilename(indexed.filename);
  if (record) {
    return record;
  }

  const rebuilt = rebuildIndex().items.find((entry) => entry.id === id) ?? null;
  return rebuilt ? readRecordByFilename(rebuilt.filename) : null;
}

export function append(entry) {
  ensureStoreDirs();
  if (entry?.id && resolveRecord(entry.id)) {
    throw new Error(`History entry '${entry.id}' already exists.`);
  }

  const body = String(entry?.body ?? "").trim();
  const normalized = normalizeEntry(entry ?? {}, body);
  const filename = ensureUniqueFilename(buildFilename(normalized.createdAt, normalized.query));
  const mdPath = join(getHistoryDir(), filename);

  atomicWrite(mdPath, serializeRecord(normalized, body));

  const record = {
    ...normalized,
    filename,
    body,
    mdPath,
    attachmentsDir: join(getAttachmentsRoot(), filename.slice(0, -3)),
  };

  const next = loadIndexedEntries().filter((item) => item.id !== normalized.id);
  next.unshift({ ...record, ...stripInternal(record) });
  writeIndex(next);
  return stripInternal(record);
}

export function update(id, patch = {}) {
  const existing = resolveRecord(id);
  if (!existing) {
    return null;
  }

  const body = patch.body !== undefined ? String(patch.body).trim() : existing.body;
  const merged = normalizeEntry(
    {
      ...existing,
      ...patch,
      id,
      createdAt: existing.createdAt,
      answerPreview: patch.answerPreview ?? existing.answerPreview,
      sourceCount: patch.sourceCount ?? existing.sourceCount,
    },
    body,
  );

  atomicWrite(existing.mdPath, serializeRecord(merged, body));

  const record = {
    ...merged,
    filename: existing.filename,
    body,
    mdPath: existing.mdPath,
    attachmentsDir: existing.attachmentsDir,
  };

  const next = loadIndexedEntries().filter((item) => item.id !== id);
  next.unshift({ ...record, ...stripInternal(record) });
  writeIndex(next);
  return stripInternal(record);
}

export function list(options = {}) {
  const {
    limit = HISTORY_LIMIT,
    status,
    tool,
    tools,
    filter,
  } = options;

  const toolSet = tools ? new Set(toArray(tools).map((value) => String(value))) : null;
  const needle = String(filter ?? "").trim().toLowerCase();

  let items = loadIndexedEntries().map((entry) => stripInternal(entry));
  if (status) {
    items = items.filter((entry) => entry.status === status);
  }
  if (tool) {
    items = items.filter((entry) => entry.tool === tool);
  }
  if (toolSet) {
    items = items.filter((entry) => toolSet.has(entry.tool));
  }
  if (needle) {
    items = items.filter((entry) =>
      entry.query.toLowerCase().includes(needle)
      || entry.tool.toLowerCase().includes(needle)
      || entry.answerPreview.toLowerCase().includes(needle)
      || toArray(entry.tags).some((tag) => String(tag).toLowerCase().includes(needle))
    );
  }

  return limit === Infinity ? items : items.slice(0, Number(limit) || HISTORY_LIMIT);
}

export function get(id) {
  const record = resolveRecord(id);
  if (!record) {
    return null;
  }

  return {
    ...stripInternal(record),
    body: record.body,
    mdPath: record.mdPath,
    attachmentsDir: record.attachmentsDir,
  };
}

export function deleteEntry(id) {
  const record = resolveRecord(id);
  if (!record) {
    return false;
  }

  rmSync(record.mdPath, { force: true });
  rmSync(record.attachmentsDir, { recursive: true, force: true });

  const next = loadIndexedEntries().filter((entry) => entry.id !== id);
  writeIndex(next);
  return true;
}

export function pin(id, pinned) {
  return update(id, { pinned: !!pinned });
}

export function tag(id, tags) {
  return update(id, { tags: uniqueStrings(tags) });
}

export function rebuildIndex() {
  ensureStoreDirs();
  const files = readdirSync(getHistoryDir())
    .filter((file) => file.endsWith(".md"));
  const items = [];
  let skipped = 0;

  for (const file of files) {
    try {
      const record = parseMarkdownFile(join(getHistoryDir(), file), file);
      if (!record) {
        skipped += 1;
        continue;
      }
      items.push(record);
    } catch {
      skipped += 1;
    }
  }

  writeIndex(items);
  return {
    scanned: files.length,
    recovered: items.length,
    skipped,
    items: sortEntries(items).map((entry) => ({
      ...stripInternal(entry),
      filename: entry.filename,
    })),
  };
}

export function getMdPath(id) {
  return resolveRecord(id)?.mdPath ?? null;
}

export function getAttachmentsDir(id) {
  return resolveRecord(id)?.attachmentsDir ?? null;
}

export function findPendingByThread(threadSlug) {
  if (!threadSlug) {
    return null;
  }

  return list({ limit: Infinity, status: "pending" })
    .find((entry) => entry.threadSlug === threadSlug) ?? null;
}

export function countAll() {
  ensureStoreDirs();
  const indexed = readIndex();
  if (indexed) {
    return indexed.length;
  }
  return readdirSync(getHistoryDir()).filter((file) => file.endsWith(".md")).length;
}

export function appendHistory(entry) {
  return append(entry);
}

export function readHistory(limit = HISTORY_LIMIT) {
  return list({ limit });
}

// ── Cloud sync helpers ────────────────────────────────────────────────
// Cloud-sourced entries carry `source: "cloud"` in frontmatter. They are
// keyed by the Perplexity `backend_uuid` (stored in `backendUuid`). Merge
// rules:
//   1. If a local entry already exists with that backendUuid → no-op for
//      metadata. NEVER overwrite an MCP-originated body with a cloud stub.
//   2. If a cloud-originated row already exists → update non-body metadata
//      only (title, preview, createdAt if newer). Leaves body alone so a
//      user who already hydrated the thread keeps their answer.
//   3. Otherwise → append a stub row with placeholder body.
// Full body is fetched on-demand via hydrateCloudEntry() when the user
// opens Rich View.

export function findByBackendUuid(backendUuid) {
  if (!backendUuid) return null;
  const items = loadIndexedEntries();
  return items.find((entry) => entry.backendUuid === String(backendUuid)) ?? null;
}

const CLOUD_STUB_BODY =
  "_Click **Rich View** to fetch this thread from Perplexity._\n\n" +
  "This entry was synced from your Perplexity.ai library. The full answer and sources are fetched on demand to keep sync fast.";

export function upsertFromCloud(meta) {
  if (!meta?.backendUuid) throw new Error("upsertFromCloud requires backendUuid");
  const existing = findByBackendUuid(meta.backendUuid);
  if (existing && existing.source !== "cloud") {
    // Local MCP-originated entry — never touch it. Respect user data.
    return { action: "skipped-local", id: existing.id };
  }
  if (existing) {
    // Already synced — refresh only lightweight metadata, keep body intact.
    const patched = update(existing.id, {
      query: meta.query ?? existing.query,
      answerPreview: meta.answerPreview ?? existing.answerPreview,
      threadUrl: meta.threadUrl ?? existing.threadUrl,
      threadSlug: meta.threadSlug ?? existing.threadSlug,
      readWriteToken: meta.readWriteToken ?? existing.readWriteToken,
      mode: meta.mode ?? existing.mode,
      model: meta.model ?? existing.model,
      sourceCount: meta.sourceCount ?? existing.sourceCount,
      status: meta.status ?? existing.status,
    });
    return { action: "updated", id: patched?.id ?? existing.id };
  }
  const inserted = append({
    tool: meta.tool ?? "perplexity_search",
    query: meta.query ?? meta.title ?? "(untitled)",
    model: meta.model ?? null,
    mode: meta.mode ?? null,
    language: meta.language ?? null,
    tier: meta.tier,
    createdAt: meta.createdAt,
    answerPreview: meta.answerPreview ?? "",
    sourceCount: meta.sourceCount ?? 0,
    threadUrl: meta.threadUrl,
    threadSlug: meta.threadSlug,
    backendUuid: meta.backendUuid,
    readWriteToken: meta.readWriteToken,
    status: meta.status ?? "completed",
    source: "cloud",
    body: CLOUD_STUB_BODY,
  });
  return { action: "inserted", id: inserted.id };
}

// Replace a cloud stub's body with the real fetched answer + sources,
// preserving frontmatter fields the caller doesn't explicitly override.
export function hydrateCloudEntry(id, payload) {
  if (!id) throw new Error("hydrateCloudEntry: id required");
  const existing = resolveRecord(id);
  if (!existing) return null;
  return update(id, {
    body: payload.body ?? existing.body,
    sources: payload.sources ?? existing.sources,
    attachments: payload.attachments ?? existing.attachments,
    answerPreview: payload.answerPreview ?? existing.answerPreview,
    sourceCount: typeof payload.sourceCount === "number" ? payload.sourceCount : existing.sourceCount,
    cloudHydratedAt: new Date().toISOString(),
  });
}
