import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];

afterEach(() => {
  vi.resetModules();
  delete process.env.PERPLEXITY_CONFIG_DIR;
  delete process.env.PERPLEXITY_PROFILE;

  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), "perplexity-history-store-"));
  tempDirs.push(dir);
  process.env.PERPLEXITY_CONFIG_DIR = dir;
  return dir;
}

describe("history-store", () => {
  it("writes markdown entries with frontmatter and lists newest first", async () => {
    makeTempConfigDir();
    const { append, getMdPath, list } = await import("../src/history-store.js");

    const first = append({
      tool: "perplexity_search",
      query: "first query",
      model: "pplx_pro",
      mode: "copilot",
      language: "en-US",
      body: "# First\n\nHello world",
      createdAt: "2026-04-21T10:00:00.000Z",
      status: "completed",
    });
    const second = append({
      tool: "perplexity_search",
      query: "second query",
      model: "pplx_pro",
      mode: "copilot",
      language: "en-US",
      body: "# Second\n\nHello again",
      createdAt: "2026-04-21T10:05:00.000Z",
      status: "completed",
    });

    const items = list();
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe(second.id);
    expect(items[1].id).toBe(first.id);

    const raw = readFileSync(getMdPath(first.id), "utf8");
    expect(raw).toMatch(/^---\n/);
    expect(raw).toContain('query: first query');
    expect(raw).toContain("# First");
  });

  it("updates fields, tags, and pin state in-place", async () => {
    makeTempConfigDir();
    const { append, get, pin, tag, update } = await import("../src/history-store.js");

    const created = append({
      tool: "perplexity_compute",
      query: "generate a report",
      model: "pplx_asi",
      mode: "asi",
      language: "en-US",
      body: "Initial body",
      status: "pending",
      threadSlug: "demo-thread",
      backendUuid: "backend-1",
    });

    pin(created.id, true);
    tag(created.id, ["report", "important", "report"]);
    update(created.id, {
      status: "completed",
      completedAt: "2026-04-21T11:00:00.000Z",
      body: "# Done\n\nExport finished.",
      sources: [{ n: 1, title: "Docs", url: "https://example.com/docs" }],
    });

    const updated = get(created.id);
    expect(updated?.pinned).toBe(true);
    expect(updated?.tags).toEqual(["report", "important"]);
    expect(updated?.status).toBe("completed");
    expect(updated?.body).toContain("Export finished");
    expect(updated?.sources?.[0]?.title).toBe("Docs");
  });

  it("rebuilds index from markdown files and skips invalid files", async () => {
    const configDir = makeTempConfigDir();
    const { append, getHistoryDir, rebuildIndex } = await import("../src/history-store.js");

    append({
      tool: "perplexity_research",
      query: "deep research topic",
      model: "pplx_alpha",
      mode: "copilot",
      language: "en-US",
      body: "Research body",
      status: "completed",
    });

    writeFileSync(join(getHistoryDir(), "broken.md"), "---\ninvalid: true\n---\n", "utf8");
    const indexPath = join(configDir, "profiles", "default", "history", "index.json");
    writeFileSync(indexPath, "{ broken json", "utf8");

    const rebuilt = rebuildIndex();
    expect(rebuilt.scanned).toBe(2);
    expect(rebuilt.recovered).toBe(1);
    expect(rebuilt.skipped).toBe(1);
    expect(JSON.parse(readFileSync(indexPath, "utf8")).items).toHaveLength(1);
  });

  it("finds pending threads and deletes entries with their attachment sidecar", async () => {
    makeTempConfigDir();
    const { append, deleteEntry, findPendingByThread, getAttachmentsDir, getMdPath } = await import("../src/history-store.js");

    const created = append({
      tool: "perplexity_compute",
      query: "pending thread",
      model: "pplx_asi",
      mode: "asi",
      language: "en-US",
      body: "Still running",
      status: "pending",
      threadSlug: "thread-123",
    });

    const attachmentsDir = getAttachmentsDir(created.id);
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(join(attachmentsDir, "artifact.txt"), "artifact", "utf8");

    const pending = findPendingByThread("thread-123");
    expect(pending?.id).toBe(created.id);
    expect(deleteEntry(created.id)).toBe(true);
    expect(getMdPath(created.id)).toBeNull();
    expect(findPendingByThread("thread-123")).toBeNull();
  });
});
