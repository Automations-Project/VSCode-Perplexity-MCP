import { Stethoscope, RefreshCcw, Download, Zap, AlertOctagon, FileArchive } from "lucide-react";
import type { DoctorCategory, DoctorReport, WebviewMessage } from "@perplexity-user-mcp/shared";
import { DoctorCategoryCard } from "./DoctorCategoryCard";
import { useIsActionPending } from "../store";

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
  const capturing = useIsActionPending("diagnostics:capture");
  return (
    <div className="doctor-shell">
      <header className="doctor-header">
        <Stethoscope size={18} />
        <h2 className="doctor-title">Doctor</h2>
        <div className="doctor-actions">
          <button className="ghost-button" disabled={running} onClick={() => send({ type: "doctor:run", payload: {} })}>
            <RefreshCcw size={14} /> Run
          </button>
          <button className="ghost-button" disabled={running} onClick={() => send({ type: "doctor:probe", payload: {} })}>
            <Zap size={14} /> Deep check
          </button>
          <button className="ghost-button" disabled={!report} onClick={() => send({ type: "doctor:export", payload: {} })}>
            <Download size={14} /> Export
          </button>
          <button
            className="ghost-button"
            disabled={running || capturing}
            aria-busy={capturing || undefined}
            onClick={() => send({ type: "diagnostics:capture" })}
            title="Bundle a redacted .zip of daemon logs, config, and the latest doctor report — share this when filing a bug."
          >
            {capturing ? <RefreshCcw size={14} className="refresh-spin" /> : <FileArchive size={14} />}
            {capturing ? "Capturing…" : "Capture diagnostics"}
          </button>
        </div>
      </header>

      {running && <p>Running checks…</p>}
      {!report && !running && <p className="doctor-empty">Click Run to audit your install.</p>}
      {report && (
        <>
          <p className="doctor-summary">
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
            <footer className="doctor-report-footer">
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
