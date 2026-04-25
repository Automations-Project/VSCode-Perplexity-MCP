import { useEffect, useRef, useState } from "react";

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
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    inputRef.current?.focus();
  }, [open, defaultValue]);

  if (!open) return null;

  function handleConfirm() {
    onConfirm(value);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleConfirm();
    if (e.key === "Escape") onCancel();
  }

  return (
    <div className="rich-view-overlay" role="dialog" aria-modal="true" aria-labelledby="prompt-modal-title">
      <div
        className="glass-panel"
        style={{ alignSelf: "center", width: "min(420px, 100%)", padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="prompt-modal-title" style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>{title}</h3>
        {description && (
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>{description}</p>
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid var(--border-color)",
            borderRadius: "8px",
            padding: "7px 10px",
            fontSize: "0.8rem",
            color: "var(--text-primary)",
            width: "100%",
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button className="ghost-button" onClick={onCancel}>{cancelLabel}</button>
          <button className="primary-button" onClick={handleConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
