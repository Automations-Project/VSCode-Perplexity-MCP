import { Buffer } from "node:buffer";
import { PERPLEXITY_URL } from "./config.js";

const FORMAT_TO_API = {
  pdf: "pdf",
  markdown: "md",
  docx: "docx",
};

const FORMAT_TO_CONTENT_TYPE = {
  pdf: "application/pdf",
  markdown: "text/markdown; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function resolveExportApiFormat(format) {
  const resolved = FORMAT_TO_API[format];
  if (!resolved) {
    throw new Error(`Unsupported export format '${format}'.`);
  }
  return resolved;
}

export async function exportThread(options) {
  const {
    entryUuid,
    format,
    fetchImpl = globalThis.fetch,
    baseUrl = PERPLEXITY_URL,
    headers = {},
  } = options;

  if (!entryUuid) {
    throw new Error("entryUuid is required for export.");
  }

  const apiFormat = resolveExportApiFormat(format);
  const response = await fetchImpl(`${baseUrl}/rest/entry/export?version=2.18&source=default`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      entry_uuid: entryUuid,
      format: apiFormat,
    }),
  });

  if (!response.ok) {
    throw new Error(`Perplexity export failed (${response.status}).`);
  }

  const payload = await response.json();
  const buffer = Buffer.from(String(payload?.file_content_64 ?? ""), "base64");
  if (buffer.length === 0) {
    throw new Error("Perplexity export returned an empty file.");
  }

  return {
    buffer,
    filename: String(payload?.filename ?? `${entryUuid}.${apiFormat}`),
    contentType: FORMAT_TO_CONTENT_TYPE[format] ?? "application/octet-stream",
  };
}
