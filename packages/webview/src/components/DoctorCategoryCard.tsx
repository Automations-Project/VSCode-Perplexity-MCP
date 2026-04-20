import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { DoctorCheck, DoctorStatus } from "@perplexity-user-mcp/shared";
import { type DotVariant, StatusDot } from "./StatusDot";

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
}: {
  category: string;
  status: DoctorStatus;
  checks: DoctorCheck[];
}) {
  const [open, setOpen] = useState(status === "fail" || status === "warn");
  return (
    <section className="doctor-card" style={{ border: "1px solid var(--border-muted)", borderRadius: 8, marginBottom: 8 }}>
      <button
        className="ghost-button"
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}
      >
        <StatusDot variant={STATUS_TO_VARIANT[status]} />
        <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{category}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.72rem" }}>{STATUS_LABEL[status]}</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <ul style={{ padding: "4px 12px 12px", margin: 0, listStyle: "none" }}>
          {checks.map((c) => (
            <li key={c.name} style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <StatusDot variant={STATUS_TO_VARIANT[c.status]} />
                <code style={{ fontSize: "0.7rem" }}>{c.name}</code>
                <span style={{ fontSize: "0.75rem" }}>{c.message}</span>
              </div>
              {c.hint && (
                <p style={{ margin: "2px 0 0 18px", fontSize: "0.7rem", color: "var(--text-muted)" }}>
                  Hint: {c.hint}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
