import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonRuntime = vi.hoisted(() => ({
  exportHistoryFromDaemon: vi.fn(),
  hydrateCloudEntryFromDaemon: vi.fn(),
  syncCloudHistoryFromDaemon: vi.fn(),
}));

const historyStore = vi.hoisted(() => ({
  deleteEntry: vi.fn(),
  get: vi.fn(),
  getAttachmentsDir: vi.fn(),
  pin: vi.fn(),
  rebuildIndex: vi.fn(),
  readHistory: vi.fn(),
  tag: vi.fn(),
}));

vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn() },
  env: { openExternal: vi.fn() },
  Uri: {
    file: vi.fn((fsPath: string) => ({ fsPath })),
    parse: vi.fn((value: string) => ({ value })),
  },
}));

vi.mock("perplexity-user-mcp", () => historyStore);
vi.mock("perplexity-user-mcp/viewers", () => ({
  buildViewerUrl: vi.fn(),
  listViewers: vi.fn(() => []),
  saveViewerConfig: vi.fn(),
}));
vi.mock("perplexity-user-mcp/viewer-detect", () => ({
  detectAllViewers: vi.fn(async () => ({})),
}));
vi.mock("../src/daemon/runtime.js", () => daemonRuntime);

describe("open-handlers daemon routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyStore.get.mockReturnValue({
      id: "hist_1",
      mdPath: "C:/tmp/history.md",
      attachmentsDir: "C:/tmp/attachments",
      threadSlug: "thread-1",
    });
  });

  it("routes export calls through the daemon helper", async () => {
    const expected = {
      savedPath: "C:/tmp/attachments/export.pdf",
      bytes: 12,
      contentType: "application/pdf",
    };
    daemonRuntime.exportHistoryFromDaemon.mockResolvedValue(expected);
    const { runExport } = await import("../src/history/open-handlers.js");

    await expect(runExport("hist_1", "pdf")).resolves.toEqual(expected);
    expect(daemonRuntime.exportHistoryFromDaemon).toHaveBeenCalledWith("hist_1", "pdf");
  });

  it("routes cloud sync calls through the daemon helper", async () => {
    const progress = vi.fn();
    const expected = { fetched: 3, inserted: 2, updated: 1, skipped: 0 };
    daemonRuntime.syncCloudHistoryFromDaemon.mockResolvedValue(expected);
    const { runCloudSync } = await import("../src/history/open-handlers.js");

    await expect(runCloudSync(progress, { pageSize: 25 })).resolves.toEqual(expected);
    expect(daemonRuntime.syncCloudHistoryFromDaemon).toHaveBeenCalledWith(progress, { pageSize: 25 });
  });

  it("routes hydrate calls through the daemon helper", async () => {
    const expected = { action: "hydrated" };
    daemonRuntime.hydrateCloudEntryFromDaemon.mockResolvedValue(expected);
    const { hydrateCloudEntry } = await import("../src/history/open-handlers.js");

    await expect(hydrateCloudEntry("hist_1")).resolves.toEqual(expected);
    expect(daemonRuntime.hydrateCloudEntryFromDaemon).toHaveBeenCalledWith("hist_1");
  });
});
