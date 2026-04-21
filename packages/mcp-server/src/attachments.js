import { mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export function sanitizeAttachmentFilename(name) {
  const cleaned = String(name ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "attachment";
}

export function inferAttachmentKind(mimeType) {
  return String(mimeType ?? "").startsWith("image/") ? "image" : "file";
}

export async function downloadAttachment(options) {
  const {
    download,
    url,
    attachmentsDir,
    filename,
    mimeType,
  } = options;

  mkdirSync(attachmentsDir, { recursive: true });
  const safeFilename = sanitizeAttachmentFilename(filename || basename(new URL(url).pathname));
  const targetPath = join(attachmentsDir, safeFilename);
  await download(url, targetPath);
  const sizeBytes = statSync(targetPath).size;
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment '${safeFilename}' exceeds the 50 MB inline cap.`);
  }

  return {
    filename: safeFilename,
    path: targetPath,
    sizeBytes,
    mimeType: mimeType ?? undefined,
    kind: inferAttachmentKind(mimeType),
  };
}
