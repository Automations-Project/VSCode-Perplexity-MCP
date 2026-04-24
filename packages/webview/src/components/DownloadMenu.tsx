import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Download,
  FileCode2,
  FileDown,
  FileText,
  type LucideIcon,
} from "lucide-react";
import type { ExportFormat, HistoryItem, WebviewMessage } from "@perplexity-user-mcp/shared";

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

interface FormatConfig {
  id: ExportFormat;
  label: string;
  hint: string;
  icon: LucideIcon;
  nativeOnly: boolean;
}

const FORMATS: FormatConfig[] = [
  { id: "markdown", label: "Markdown", hint: ".md source with front-matter", icon: FileCode2, nativeOnly: false },
  { id: "pdf", label: "PDF", hint: "Perplexity-native export", icon: FileDown, nativeOnly: true },
  { id: "docx", label: "Word document", hint: "Perplexity-native export", icon: FileText, nativeOnly: true },
];

export function DownloadMenu({ item, send }: { item: HistoryItem; send: SendFn }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const hasMarkdown = item.answerPreview.trim().length > 0;
  const toggleDisabled = !hasMarkdown && !item.threadSlug;
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

  const formatIsDisabled = (format: FormatConfig): { disabled: boolean; reason?: string } => {
    if (format.id === "markdown") {
      if (!hasMarkdown) return { disabled: true, reason: "No markdown body available" };
      return { disabled: false };
    }
    if (!item.threadSlug) return { disabled: true, reason: "Thread slug missing" };
    if (item.tier === "Anonymous") return { disabled: true, reason: "Sign in to export" };
    return { disabled: false };
  };

  return (
    <div ref={containerRef} className="hist-menu">
      <button
        ref={toggleRef}
        type="button"
        className="hist-action-btn hist-action-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={toggleDisabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onToggleKey}
      >
        <Download size={12} />
        Download
        <ChevronDown size={11} className="hist-action-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="hist-menu-popover" role="menu">
          <div className="hist-menu-section-label">Export as</div>
          {FORMATS.map((format) => {
            const { disabled, reason } = formatIsDisabled(format);
            const Icon = format.icon;
            return (
              <button
                key={format.id}
                className="hist-menu-item"
                role="menuitem"
                disabled={disabled}
                onClick={() => { send({ type: "history:export", payload: { historyId: item.id, format: format.id } }); close(); }}
              >
                <span className="hist-menu-item-icon"><Icon size={14} /></span>
                <span className="hist-menu-item-body">
                  <span className="hist-menu-item-label">{format.label}</span>
                  <span className="hist-menu-item-hint">{disabled && reason ? reason : format.hint}</span>
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
