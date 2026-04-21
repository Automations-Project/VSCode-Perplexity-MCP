import type { ExternalViewer, HistoryItem, WebviewMessage } from "@perplexity-user-mcp/shared";

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

export function OpenWithMenu({
  item,
  viewers,
  send,
}: {
  item: HistoryItem;
  viewers: ExternalViewer[];
  send: SendFn;
}) {
  return (
    <details className="hist-menu">
      <summary className="hist-action-btn hist-action-menu">
        Open with
        <span className="hist-action-caret" aria-hidden="true">▾</span>
      </summary>
      <div className="hist-menu-popover">
        <button className="hist-menu-item" onClick={() => send({ type: "history:open-preview", payload: { historyId: item.id } })}>
          VS Code preview
        </button>
        <button className="hist-menu-item" onClick={() => send({ type: "history:open-rich", payload: { historyId: item.id } })}>
          Rich View
        </button>
        <button className="hist-menu-item" onClick={() => send({ type: "history:open-with", payload: { historyId: item.id, viewerId: "system" } })}>
          System default
        </button>
        {viewers.map((viewer) => {
          const disabled = !viewer.detected || (viewer.needsVaultBridge && !viewer.vaultPath);
          return (
            <button
              key={viewer.id}
              className="hist-menu-item"
              disabled={disabled}
              onClick={() => send({ type: "history:open-with", payload: { historyId: item.id, viewerId: viewer.id } })}
            >
              {viewer.label}
            </button>
          );
        })}
      </div>
    </details>
  );
}
