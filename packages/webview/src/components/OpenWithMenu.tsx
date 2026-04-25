import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  Eye,
  ExternalLink,
  Globe,
  Sparkles,
} from "lucide-react";
import type { ExternalViewer, HistoryItem, WebviewMessage } from "@perplexity-user-mcp/shared";
import { useDisclosureMenu } from "../lib/useDisclosureMenu";

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
  const [menuPosition, setMenuPosition] = useState<React.CSSProperties>();
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const updateMenuPosition = useCallback(() => {
    const rect = toggleRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportMargin = 12;
    const popoverWidth = Math.min(220, Math.max(0, viewportWidth - viewportMargin * 2));
    const preferredRight = Math.max(viewportMargin, Math.round(viewportWidth - rect.right));
    const maxRight = Math.max(viewportMargin, Math.round(viewportWidth - viewportMargin - popoverWidth));
    const top = Math.max(8, Math.round(rect.bottom + 8));
    const right = Math.min(preferredRight, maxRight);
    setMenuPosition({
      "--hist-menu-top": `${top}px`,
      "--hist-menu-right": `${right}px`,
      "--hist-menu-width": `${popoverWidth}px`,
    } as React.CSSProperties);
  }, []);

  const toggleMenu = useCallback(() => {
    if (open) {
      close();
      return;
    }
    updateMenuPosition();
    setOpen(true);
  }, [close, open, updateMenuPosition]);

  useLayoutEffect(() => {
    if (open) updateMenuPosition();
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const onPlacementChange = () => updateMenuPosition();
    window.addEventListener("resize", onPlacementChange);
    window.addEventListener("scroll", onPlacementChange, true);
    return () => {
      window.removeEventListener("resize", onPlacementChange);
      window.removeEventListener("scroll", onPlacementChange, true);
    };
  }, [open, updateMenuPosition]);

  useDisclosureMenu({ triggerRef: toggleRef, menuRef: containerRef, isOpen: open, onClose: close });

  const onToggleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleMenu();
    }
  };

  const externalViewerHasVaultIssue = (v: ExternalViewer) =>
    v.detected && v.needsVaultBridge && !v.vaultPath;

  return (
    <div ref={containerRef} className="hist-menu hist-menu-right">
      <button
        ref={toggleRef}
        type="button"
        className="hist-action-btn hist-action-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleMenu}
        onKeyDown={onToggleKey}
      >
        <ExternalLink size={12} />
        Open with
        <ChevronDown size={11} className="hist-action-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="hist-menu-popover hist-menu-popover-fixed" role="menu" style={menuPosition}>
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
