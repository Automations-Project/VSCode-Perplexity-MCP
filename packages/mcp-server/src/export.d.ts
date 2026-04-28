export type ExportFormat = "pdf" | "markdown" | "docx";

export interface ExportResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

export declare const FORMAT_TO_CONTENT_TYPE: Record<ExportFormat, string>;
export declare function resolveExportApiFormat(format: ExportFormat): "pdf" | "md" | "docx";
export declare function exportThread(options: {
  entryUuid: string;
  format: ExportFormat;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  baseUrl?: string;
  headers?: HeadersInit;
}): Promise<ExportResult>;
