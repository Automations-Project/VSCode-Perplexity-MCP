import type { ExportFormat, HistoryItem, WebviewMessage } from "@perplexity-user-mcp/shared";

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

const FORMATS: Array<{ id: ExportFormat; label: string }> = [
  { id: "markdown", label: "Markdown" },
  { id: "pdf", label: "PDF" },
  { id: "docx", label: "DOCX" },
];

export function DownloadMenu({ item, send }: { item: HistoryItem; send: SendFn }) {
  return (
    <details className="hist-menu">
      <summary className="hist-action-btn hist-action-menu">
        Download
        <span className="hist-action-caret" aria-hidden="true">▾</span>
      </summary>
      <div className="hist-menu-popover">
        {FORMATS.map((format) => {
          const nativeOnly = format.id !== "markdown";
          const disabled = nativeOnly && (!item.threadSlug || item.tier === "Anonymous");
          return (
            <button
              key={format.id}
              className="hist-menu-item"
              disabled={disabled}
              onClick={() => send({ type: "history:export", payload: { historyId: item.id, format: format.id } })}
            >
              {format.label}
            </button>
          );
        })}
      </div>
    </details>
  );
}
