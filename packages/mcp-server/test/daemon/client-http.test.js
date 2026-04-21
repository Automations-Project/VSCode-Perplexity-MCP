import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/launcher.ts";
import {
  exportHistoryViaDaemon,
  syncCloudHistoryViaDaemon,
} from "../../src/daemon/client-http.ts";

const tempDirs = [];

afterEach(async () => {
  delete process.env.PERPLEXITY_CONFIG_DIR;

  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("daemon client-http helpers", () => {
  it("exports history through the daemon MCP transport", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-daemon-http-"));
    tempDirs.push(configDir);
    process.env.PERPLEXITY_CONFIG_DIR = configDir;

    const { appendHistory } = await import("../../src/history-store.js");
    const entry = appendHistory({
      tool: "perplexity_search",
      query: "export me",
      body: "body",
      threadSlug: "thread-export-1",
      threadUrl: "https://www.perplexity.ai/search/thread-export-1",
      answerPreview: "preview",
      createdAt: "2026-04-21T00:00:00.000Z",
      status: "completed",
    });

    const daemon = await startDaemon({
      configDir,
      createClient: () => ({
        init: async () => undefined,
        shutdown: async () => undefined,
        exportThread: async () => ({
          filename: "export.pdf",
          buffer: Buffer.from("daemon-pdf"),
          contentType: "application/pdf",
        }),
      }),
    });

    try {
      const exported = await exportHistoryViaDaemon(entry.id, "pdf", { configDir });
      expect(exported.savedPath).toMatch(/export\.pdf$/);
      expect(exported.bytes).toBe(Buffer.byteLength("daemon-pdf"));
      expect(exported.contentType).toBe("application/pdf");
    } finally {
      await daemon.close();
      await daemon.closed;
    }
  });

  it("relays cloud sync progress over daemon SSE", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-daemon-sync-"));
    tempDirs.push(configDir);
    process.env.PERPLEXITY_CONFIG_DIR = configDir;

    let calls = 0;
    const daemon = await startDaemon({
      configDir,
      createClient: () => ({
        init: async () => undefined,
        shutdown: async () => undefined,
        listCloudThreads: async ({ limit, offset }) => {
          calls += 1;
          if (calls > 1) {
            return { items: [], total: 2 };
          }
          return {
            total: 2,
            items: [
              {
                backendUuid: `backend-${offset + 1}`,
                queryStr: `query-${offset + 1}`,
                title: `query-${offset + 1}`,
                createdAt: "2026-04-21T00:00:00.000Z",
                slug: `thread-${offset + 1}`,
                threadStatus: "completed",
                displayModel: "pplx_pro",
                mode: "copilot",
                sources: [{ title: "Source", url: "https://example.com" }],
              },
              {
                backendUuid: `backend-${offset + 2}`,
                queryStr: `query-${offset + 2}`,
                title: `query-${offset + 2}`,
                createdAt: "2026-04-21T00:00:00.000Z",
                slug: `thread-${offset + 2}`,
                threadStatus: "completed",
                displayModel: "pplx_pro",
                mode: "copilot",
                sources: [{ title: "Source", url: "https://example.com" }],
              },
            ].slice(0, limit),
          };
        },
      }),
    });

    try {
      const phases = [];
      const result = await syncCloudHistoryViaDaemon({
        configDir,
        pageSize: 20,
        onProgress: (progress) => {
          phases.push(progress.phase);
        },
      });

      expect(result).toEqual({
        fetched: 2,
        inserted: 2,
        updated: 0,
        skipped: 0,
      });
      expect(phases).toContain("starting");
      expect(phases).toContain("syncing");
      expect(phases).toContain("done");
    } finally {
      await daemon.close();
      await daemon.closed;
    }
  });
});
