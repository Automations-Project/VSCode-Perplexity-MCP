import { Copy, Globe2, KeyRound, RefreshCcw, ServerCog } from "lucide-react";
import { useState } from "react";
import type { DaemonAuditEntry, DaemonStatusState, WebviewMessage } from "@perplexity-user-mcp/shared";
import { useDashboardStore } from "../store";

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

export function DaemonStatus({ send }: { send: SendFn }) {
  const status = useDashboardStore((store) => store.daemonStatus);
  const auditTail = useDashboardStore((store) => store.daemonAuditTail);
  const tokenRotatedAt = useDashboardStore((store) => store.daemonTokenRotatedAt);
  return <DaemonStatusView status={status} auditTail={auditTail} tokenRotatedAt={tokenRotatedAt} send={send} />;
}

export function DaemonStatusView({
  status,
  auditTail,
  tokenRotatedAt,
  send,
}: {
  status: DaemonStatusState | null;
  auditTail: DaemonAuditEntry[];
  tokenRotatedAt: string | null;
  send: SendFn;
}) {
  const [revealed, setRevealed] = useState(false);
  const tunnel = status?.tunnel ?? { status: "disabled", url: null, pid: null, error: null };
  const tunnelActive = tunnel.status === "enabled" || tunnel.status === "starting";
  const tunnelUrl = tunnel.url ?? null;

  const copyTunnelUrl = () => {
    if (!tunnelUrl || !revealed || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(tunnelUrl).catch(() => undefined);
  };

  return (
    <div className="glass-panel section-panel" data-testid="daemon-status-card">
      <div className="section-header">
        <div className="eyebrow">Singleton Daemon</div>
        <div className="title">HTTP MCP server</div>
        <div className="detail">One local daemon shared by all VS Code windows and MCP clients.</div>
      </div>

      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 10 }}>
        <span className={`chip ${status?.healthy ? "chip-pro" : status?.running ? "chip-warn" : "chip-danger"}`}>
          {status?.healthy ? "Healthy" : status?.running ? "Starting" : "Offline"}
        </span>
        <span className={`chip ${tunnel.status === "enabled" ? "chip-accent" : tunnel.status === "crashed" ? "chip-danger" : "chip-muted"}`}>
          Tunnel {tunnel.status}
        </span>
        {tokenRotatedAt ? (
          <span className="chip chip-neutral">Token rotated {formatRelative(tokenRotatedAt)}</span>
        ) : null}
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
        <DaemonMetric label="PID" value={status?.pid ? String(status.pid) : "not running"} />
        <DaemonMetric label="Port" value={status?.port ? String(status.port) : "n/a"} />
        <DaemonMetric label="Uptime" value={formatUptime(status?.uptimeMs ?? null)} />
      </div>

      <div className="list-row" style={{ marginTop: 10, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
            Cloudflare Quick Tunnel
          </div>
          <div style={{ fontSize: "0.7rem", marginTop: 3 }} className="text-[var(--text-muted)] break-all">
            {tunnelUrl ? (revealed ? tunnelUrl : maskTunnelUrl(tunnelUrl)) : "No public tunnel URL."}
          </div>
          {tunnel.error ? (
            <div style={{ fontSize: "0.68rem", marginTop: 4 }} className="text-[#fca5a5]">{tunnel.error}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-1 flex-wrap" style={{ justifyContent: "flex-end" }}>
          {tunnelUrl ? (
            <>
              <button className="ghost-button btn-sm" onClick={() => setRevealed((value) => !value)}>
                {revealed ? "Hide URL" : "Reveal URL"}
              </button>
              <button className="ghost-button btn-sm" disabled={!revealed} onClick={copyTunnelUrl}>
                <Copy size={11} />
                Copy
              </button>
            </>
          ) : null}
          <button
            className={tunnelActive ? "danger-button btn-sm" : "primary-button btn-sm"}
            onClick={() => send({ type: tunnelActive ? "daemon:disable-tunnel" : "daemon:enable-tunnel" })}
            disabled={!status?.healthy || tunnel.status === "starting"}
            title="Tunnel enablement is confirmed by the extension host before any public URL is created."
          >
            <Globe2 size={11} />
            {tunnelActive ? "Disable" : "Enable"}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 10 }}>
        <button className="ghost-button btn-sm" onClick={() => send({ type: "daemon:status" })}>
          <RefreshCcw size={11} />
          Refresh
        </button>
        <button className="ghost-button btn-sm" disabled={!status?.healthy} onClick={() => send({ type: "daemon:rotate-token" })}>
          <KeyRound size={11} />
          Rotate token
        </button>
        {status?.url ? (
          <span className="text-[var(--text-muted)]" style={{ fontSize: "0.68rem" }}>
            Loopback {status.url}
          </span>
        ) : null}
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="section-header" style={{ marginBottom: 8 }}>
          <div className="eyebrow">Audit Tail</div>
          <div className="title">Last tool calls</div>
        </div>
        {auditTail.length === 0 ? (
          <div className="empty-state">No daemon tool calls recorded yet.</div>
        ) : (
          <div className="flex flex-col gap-2" style={{ maxHeight: 220, overflow: "auto" }}>
            {[...auditTail].reverse().map((entry, index) => (
              <div key={`${entry.timestamp}-${entry.tool}-${index}`} className="list-row">
                <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                  <ServerCog size={12} className={entry.ok ? "text-[#86efac]" : "text-[#fca5a5]"} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "0.75rem", fontWeight: 600 }} className="text-[var(--text-primary)]">{entry.tool}</div>
                    <div style={{ fontSize: "0.66rem" }} className="text-[var(--text-muted)]">
                      {entry.clientId} / {entry.source} / {formatRelative(entry.timestamp)}
                    </div>
                    {entry.error ? (
                      <div style={{ fontSize: "0.66rem" }} className="text-[#fca5a5]">{entry.error}</div>
                    ) : null}
                  </div>
                </div>
                <span className={`chip ${entry.ok ? "chip-pro" : "chip-danger"}`}>{entry.durationMs}ms</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DaemonMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card" style={{ minHeight: 68 }}>
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ fontSize: "1.1rem" }}>{value}</div>
    </div>
  );
}

function formatUptime(ms: number | null): string {
  if (typeof ms !== "number" || ms < 0) {
    return "n/a";
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatRelative(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) {
    return "unknown";
  }
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function maskTunnelUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const suffix = parsed.hostname.split(".").slice(-2).join(".");
    return `${parsed.protocol}//******.${suffix}`;
  } catch {
    return "https://******.trycloudflare.com";
  }
}
