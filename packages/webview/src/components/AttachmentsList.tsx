import type { HistoryAttachment } from "@perplexity-user-mcp/shared";

export function AttachmentsList({ attachments }: { attachments?: HistoryAttachment[] }) {
  if (!attachments?.length) {
    return <div className="empty-state">No sidecar attachments saved for this entry.</div>;
  }

  return (
    <div className="attachment-list">
      {attachments.map((attachment) => (
        <div key={`${attachment.relPath}-${attachment.filename}`} className="list-row">
          <div className="attachment-body">
            <div className="attachment-title">
              {attachment.filename}
            </div>
            <div className="attachment-path">
              {attachment.relPath}
            </div>
          </div>
          <span className="chip chip-muted">{attachment.kind ?? "file"}</span>
        </div>
      ))}
    </div>
  );
}
