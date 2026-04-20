import { Stethoscope, RefreshCcw, Download, Zap, AlertOctagon } from "lucide-react";
import type { DoctorCategory, DoctorReport, WebviewMessage } from "@perplexity-user-mcp/shared";
import { DoctorCategoryCard } from "./DoctorCategoryCard";

const CATEGORY_ORDER: DoctorCategory[] = [
  "runtime", "config", "profiles", "vault", "browser",
  "native-deps", "network", "ide", "mcp", "probe",
];

export function DoctorTab({
  report,
  phase,
  reportingOptOut,
  send,
}: {
  report: DoctorReport | null;
  phase: "idle" | "running" | "done" | "error";
  reportingOptOut: boolean;
  send: (m: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;
}) {
  const running = phase === "running";
  return (
    <div style={{ padding: 16 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Stethoscope size={18} />
        <h2 style={{ margin: 0, fontSize: "1rem" }}>Doctor</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="ghost-button" disabled={running} onClick={() => send({ type: "doctor:run", payload: {} })}>
            <RefreshCcw size={14} /> Run
          </button>
          <button className="ghost-button" disabled={running} onClick={() => send({ type: "doctor:probe", payload: {} })}>
            <Zap size={14} /> Deep check
          </button>
          <button className="ghost-button" disabled={!report} onClick={() => send({ type: "doctor:export", payload: {} })}>
            <Download size={14} /> Export
          </button>
        </div>
      </header>

      {running && <p>Running checks…</p>}
      {!report && !running && <p style={{ color: "var(--text-muted)" }}>Click Run to audit your install.</p>}
      {report && (
        <>
          <p style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            Overall: <strong>{report.overall}</strong> · generated{" "}
            {new Date(report.generatedAt).toLocaleString()} · {report.durationMs}ms
            {report.probeRan && " · probe ran"}
          </p>
          {CATEGORY_ORDER.map((cat) => (
            <DoctorCategoryCard
              key={cat}
              category={cat}
              status={report.byCategory[cat]?.status ?? "skip"}
              checks={report.byCategory[cat]?.checks ?? []}
              send={send}
            />
          ))}
          {report.overall === "fail" && !reportingOptOut && (
            <footer style={{ marginTop: 12 }}>
              <button
                className="primary-button"
                onClick={() => {
                  const first = Object.entries(report.byCategory).find(([, b]) => b.status === "fail");
                  if (!first) return;
                  const [cat, bucket] = first;
                  const check = bucket.checks.find((c) => c.status === "fail")?.name ?? "unknown";
                  send({ type: "doctor:report-issue", payload: { category: cat as DoctorCategory, check } });
                }}
              >
                <AlertOctagon size={14} /> Report issue
              </button>
            </footer>
          )}
        </>
      )}
    </div>
  );
}
