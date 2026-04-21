export interface DownloadedAttachment {
  filename: string;
  path: string;
  sizeBytes: number;
  mimeType?: string;
  kind: "image" | "file";
}

export declare const MAX_ATTACHMENT_BYTES: number;
export declare function sanitizeAttachmentFilename(name: string): string;
export declare function inferAttachmentKind(mimeType?: string): "image" | "file";
export declare function downloadAttachment(options: {
  download: (url: string, targetPath: string) => Promise<unknown>;
  url: string;
  attachmentsDir: string;
  filename?: string;
  mimeType?: string;
}): Promise<DownloadedAttachment>;
