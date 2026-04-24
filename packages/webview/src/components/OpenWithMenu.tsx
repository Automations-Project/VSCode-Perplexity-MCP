import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  Eye,
  ExternalLink,
  Globe,
  Sparkles,
} from "lucide-react";
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
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        toggleRef.current?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = containerRef.current?.querySelectorAll<HTMLElement>(".hist-menu-item:not(:disabled)");
        if (!items || items.length === 0) return;
        const active = document.activeElement;
        const idx = Array.from(items).indexOf(active as HTMLElement);
        const next = e.key === "ArrowDown"
          ? items[(idx + 1) % items.length]
          : items[(idx - 1 + items.length) % items.length];
        next?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [open, close]);

  const onToggleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen((v) => !v);
    }
  };

  const externalViewerHasVaultIssue = (v: ExternalViewer) =>
    v.detected && v.needsVaultBridge && !v.vaultPath;

  return (
    <div ref={containerRef} className="hist-menu">
      <button
        ref={toggleRef}
        type="button"
        className="hist-action-btn hist-action-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onToggleKey}
      >
        <ExternalLink size={12} />
        Open with
        <ChevronDown size={11} className="hist-action-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="hist-menu-popover" role="menu">
          <div className="hist-menu-section-label">Built-in</div>
          <button
            className="hist-menu-item"
            role="menuitem"
            onClick={() => { send({ type: "history:open-rich", payload: { historyId: item.id } }); close(); }}
          >
            <span className="hist-menu-item-icon"><Sparkles size={14} /></span>
            <span className="hist-menu-item-body">
              <span className="hist-menu-item-label">Rich View</span>
              <span className="hist-menu-item-hint">Styled overlay with metadata</span>
            </span>
          </button>
          <button
            className="hist-menu-item"
            role="menuitem"
            onClick={() => { send({ type: "history:open-preview", payload: { historyId: item.id } }); close(); }}
          >
            <span className="hist-menu-item-icon"><Eye size={14} /></span>
            <span className="hist-menu-item-body">
              <span className="hist-menu-item-label">VS Code preview</span>
              <span className="hist-menu-item-hint">Raw Markdown in editor</span>
            </span>
          </button>

          <div className="hist-menu-divider" />
          <div className="hist-menu-section-label">External</div>
          <button
            className="hist-menu-item"
            role="menuitem"
            onClick={() => { send({ type: "history:open-with", payload: { historyId: item.id, viewerId: "system" } }); close(); }}
          >
            <span className="hist-menu-item-icon"><Globe size={14} /></span>
            <span className="hist-menu-item-body">
              <span className="hist-menu-item-label">System default</span>
              <span className="hist-menu-item-hint">Open with default .md handler</span>
            </span>
          </button>
          {viewers.map((viewer) => {
            const vaultIssue = externalViewerHasVaultIssue(viewer);
            const disabled = !viewer.detected || vaultIssue;
            const hint = !viewer.detected
              ? "Not detected — install to enable"
              : vaultIssue
              ? "Vault bridge required"
              : undefined;
            return (
              <button
                key={viewer.id}
                className="hist-menu-item"
                role="menuitem"
                disabled={disabled}
                onClick={() => { send({ type: "history:open-with", payload: { historyId: item.id, viewerId: viewer.id } }); close(); }}
              >
                <span className="hist-menu-item-icon"><BookOpen size={14} /></span>
                <span className="hist-menu-item-body">
                  <span className="hist-menu-item-label">{viewer.label}</span>
                  {hint ? <span className="hist-menu-item-hint">{hint}</span> : null}
                </span>
              </button>
            );
          })}

          <div className="hist-menu-footer">
            <kbd className="hist-menu-footer-kbd">↑</kbd>
            <kbd className="hist-menu-footer-kbd">↓</kbd>
            <span>navigate</span>
            <kbd className="hist-menu-footer-kbd">Esc</kbd>
            <span>close</span>
          </div>
        </div>
      )}
    </div>
  );
}

