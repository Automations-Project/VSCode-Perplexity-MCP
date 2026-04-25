import { useState } from "react";
import { ChevronDown, ChevronUp, Wrench } from "lucide-react";
import type { DoctorCheck, DoctorStatus, WebviewMessage } from "@perplexity-user-mcp/shared";
import { type DotVariant, StatusDot } from "./StatusDot";

type SendFn = (m: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

const STATUS_LABEL: Record<DoctorStatus, string> = {
  pass: "healthy",
  warn: "warning",
  fail: "failure",
  skip: "skipped",
};

const STATUS_TO_VARIANT: Record<DoctorStatus, DotVariant> = {
  pass: "ok",
  warn: "warn",
  fail: "err",
  skip: "off",
};

export function DoctorCategoryCard({
  category,
  status,
  checks,
  send,
}: {
  category: string;
  status: DoctorStatus;
  checks: DoctorCheck[];
  send?: SendFn;
}) {
  const [open, setOpen] = useState(status === "fail" || status === "warn");
  return (
    <section className="doctor-card">
      <button
        className="ghost-button doctor-category-header"
        onClick={() => setOpen((o) => !o)}
      >
        <StatusDot variant={STATUS_TO_VARIANT[status]} decorative />
        <span className="doctor-category-name">{category}</span>
        <span className="doctor-category-status">{STATUS_LABEL[status]}</span>
        {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>
      {open && (
        <ul className="doctor-check-list">
          {checks.map((c) => (
            <li key={c.name} className="doctor-check-item">
              <div className="doctor-check-row">
                <StatusDot variant={STATUS_TO_VARIANT[c.status]} decorative />
                <code className="doctor-check-code">{c.name}</code>
                <span className="doctor-check-message">{c.message}</span>
              </div>
              {c.hint && (
                <p className="doctor-check-hint">
                  Hint: {c.hint}
                </p>
              )}
              {c.action && send && (
                <button
                  className="ghost-button doctor-check-action"
                  onClick={() =>
                    send({ type: "doctor:action", payload: { commandId: c.action!.commandId, args: c.action!.args } })
                  }
                >
                  <Wrench size={12} /> {c.action.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
