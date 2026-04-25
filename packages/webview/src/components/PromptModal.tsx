import { useId, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../lib/useFocusTrap";

export interface PromptModalProps {
  open: boolean;
  title: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function PromptModal({
  open,
  title,
  description,
  defaultValue = "",
  placeholder,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: PromptModalProps) {
  const titleId = useId();
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    inputRef.current?.focus();
  }, [open, defaultValue]);

  // Focus trap: Tab cycling, Esc, and focus restoration on close.
  useFocusTrap({ active: open, containerRef: dialogRef, onEscape: onCancel });

  if (!open) return null;

  function handleConfirm() {
    onConfirm(value);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleConfirm();
    // Esc is handled by the focus trap at the document level.
  }

  return (
    <div className="rich-view-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div
        ref={dialogRef}
        className="glass-panel"
        style={{ alignSelf: "center", width: "min(420px, 100%)", padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>{title}</h3>
        {description && (
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>{description}</p>
        )}
        <input
          ref={inputRef}
          type="text"
          className="setting-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button className="ghost-button" onClick={onCancel}>{cancelLabel}</button>
          <button className="primary-button" onClick={handleConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
