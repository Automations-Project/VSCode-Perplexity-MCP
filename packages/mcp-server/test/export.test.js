import { afterEach, describe, expect, it, vi } from "vitest";
import { exportThread, resolveExportApiFormat } from "../src/export.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("export", () => {
  it("maps markdown to the native md format", () => {
    expect(resolveExportApiFormat("markdown")).toBe("md");
    expect(resolveExportApiFormat("pdf")).toBe("pdf");
    expect(resolveExportApiFormat("docx")).toBe("docx");
  });

  it("posts to the captured rest/entry/export endpoint and decodes the file", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://www.perplexity.ai/rest/entry/export?version=2.18&source=default");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        accept: "application/json",
        "content-type": "application/json",
        "x-test": "1",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        entry_uuid: "entry-123",
        format: "md",
      });
      return new Response(JSON.stringify({
        file_content_64: Buffer.from("# Exported\n\nHello world", "utf8").toString("base64"),
        filename: "entry-123.md",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await exportThread({
      entryUuid: "entry-123",
      format: "markdown",
      headers: { "x-test": "1" },
      fetchImpl,
    });

    expect(result.filename).toBe("entry-123.md");
    expect(result.contentType).toBe("text/markdown; charset=utf-8");
    expect(result.buffer.toString("utf8")).toContain("Hello world");
  });

  it("throws a readable error when Perplexity returns a non-200 status", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(exportThread({
      entryUuid: "entry-123",
      format: "pdf",
      fetchImpl,
    })).rejects.toThrow(/403/);
  });
});
