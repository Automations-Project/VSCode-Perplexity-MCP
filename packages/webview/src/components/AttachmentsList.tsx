import type { HistoryAttachment } from "@perplexity-user-mcp/shared";

export function AttachmentsList({ attachments }: { attachments?: HistoryAttachment[] }) {
  if (!attachments?.length) {
    return <div className="empty-state">No sidecar attachments saved for this entry.</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      {attachments.map((attachment) => (
        <div key={`${attachment.relPath}-${attachment.filename}`} className="list-row">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "0.78rem", fontWeight: 500 }} className="text-[var(--text-primary)]">
              {attachment.filename}
            </div>
            <div style={{ fontSize: "0.68rem" }} className="text-[var(--text-muted)]">
              {attachment.relPath}
            </div>
          </div>
          <span className="chip chip-muted">{attachment.kind ?? "file"}</span>
        </div>
      ))}
    </div>
  );
}
