import { ChevronDown, Copy, FileArchive, KeyRound, Power, RefreshCcw, ServerCog, Skull } from "lucide-react";
import { useEffect, useState } from "react";
import type { DaemonAuditEntry, DaemonStatusState, WebviewMessage } from "@perplexity-user-mcp/shared";
import { useDashboardStore, type TunnelProbeState } from "../store";
import { DaemonActionButton } from "./DaemonActionButton";
import { RelativeTime } from "./RelativeTime";
import { StatusDot } from "./StatusDot";
import { TunnelManager, type TunnelProvidersState, deriveCfNamedState } from "./TunnelManager";

export { deriveCfNamedState };

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

export function DaemonStatus({ send }: { send: SendFn }) {
  const status = useDashboardStore((store) => store.daemonStatus);
  const auditTail = useDashboardStore((store) => store.daemonAuditTail);
  const tokenRotatedAt = useDashboardStore((store) => store.daemonTokenRotatedAt);
  const tunnelProviders = useDashboardStore((store) => store.tunnelProviders);
  const tunnelProbe = useDashboardStore((store) => store.tunnelProbe);
  const revealedBearer = useDashboardStore((store) => store.revealedBearer);
  const clearRevealedBearer = useDashboardStore((store) => store.clearRevealedBearer);
  return (
    <DaemonStatusView
      status={status}
      auditTail={auditTail}
      tokenRotatedAt={tokenRotatedAt}
      tunnelProviders={tunnelProviders}
      tunnelProbe={tunnelProbe}
      revealedBearer={revealedBearer}
      clearRevealedBearer={clearRevealedBearer}
      send={send}
    />
  );
}

export function DaemonStatusView({
  status,
  auditTail,
  tokenRotatedAt,
  tunnelProviders,
  tunnelProbe,
  revealedBearer,
  clearRevealedBearer,
  send,
}: {
  status: DaemonStatusState | null;
  auditTail: DaemonAuditEntry[];
  tokenRotatedAt: string | null;
  tunnelProviders?: TunnelProvidersState | null;
  tunnelProbe?: TunnelProbeState | null;
  /**
   * H0 reveal slice. Non-null only during an active 30s reveal. Raw bearer
   * is present here — the slice itself is the enforcement mechanism (TTL +
   * auto-clear) the extension host promised when it posted the response.
   */
  revealedBearer?: { bearer: string; expiresAt: number; nonce: string } | null;
  /** Invoked by the TTL effect when `Date.now() >= expiresAt`. */
  clearRevealedBearer?: () => void;
  send: SendFn;
}) {
  const [bearerFeedback, setBearerFeedback] = useState<string | null>(null);
  // H0 — live 1-second tick driving the reveal countdown. Re-runs per
  // revealedBearer (nonce change resets). `now` is state so React re-renders
  // the countdown label each second; the TTL auto-clear fires via the same
  // interval callback once expiresAt is reached.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!revealedBearer) return;
    setNow(Date.now());
    const tick = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= revealedBearer.expiresAt) {
        window.clearInterval(tick);
        clearRevealedBearer?.();
      }
    }, 1_000);
    return () => window.clearInterval(tick);
  }, [revealedBearer, clearRevealedBearer]);
  const revealRemainingSec = revealedBearer
    ? Math.max(0, Math.ceil((revealedBearer.expiresAt - now) / 1000))
    : 0;
  const isRevealLive = Boolean(revealedBearer) && revealRemainingSec > 0;
  const tunnel = status?.tunnel ?? { status: "disabled", url: null, pid: null, error: null };
  const bearerAvailable = status?.bearerAvailable ?? false;

  const flashBearer = (msg: string) => {
    setBearerFeedback(msg);
    window.setTimeout(() => setBearerFeedback((prev) => (prev === msg ? null : prev)), 1500);
  };

  // Bearer copy + reveal are delegated to the extension host so the raw
  // token never touches the webview state / postMessage channel. See
  // daemon:bearer:copy + daemon:bearer:reveal handlers in DashboardProvider.
  const copyBearer = () => {
    if (!bearerAvailable) return;
    send({ type: "daemon:bearer:copy" });
    flashBearer("Copy requested");
  };

  const revealBearer = () => {
    if (!bearerAvailable) return;
    send({ type: "daemon:bearer:reveal" });
    flashBearer("Reveal requested");
  };

  // Null-safe health chip — pre-hydrate, avoid flashing "Offline" red before
  // the first `daemon:status-updated` arrives. `status === null` is the
  // literal signal that the store slice has never been populated.
  const healthChip: { label: string; chip: string; dot: "ok" | "warn" | "off" | "info" } =
    status === null
      ? { label: "Loading…", chip: "chip-muted", dot: "info" }
      : status.healthy
        ? { label: "Healthy", chip: "chip-pro", dot: "ok" }
        : status.running
          ? { label: "Starting", chip: "chip-warn", dot: "warn" }
          : { label: "Offline", chip: "chip-danger", dot: "off" };

  return (
    <div className="glass-panel section-panel" data-testid="daemon-status-card">
      <div className="section-header">
        <div className="eyebrow">Singleton Daemon</div>
        <div className="title">HTTP MCP server</div>
        <div className="detail">One local daemon shared by all VS Code windows and MCP clients.</div>
      </div>

      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 10 }}>
        <span className={`chip ${healthChip.chip}`} data-testid="daemon-health-chip">
          <StatusDot variant={healthChip.dot} />
          {healthChip.label}
        </span>
        <span className={`chip ${tunnel.status === "enabled" ? "chip-accent" : tunnel.status === "crashed" ? "chip-danger" : "chip-muted"}`}>
          Tunnel {tunnel.status === "starting" ? "connecting…" : tunnel.status}
        </span>
        {tokenRotatedAt ? (
          <span className="chip chip-neutral">Token rotated <RelativeTime iso={tokenRotatedAt} /></span>
        ) : null}
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <DaemonMetric label="PID" value={status?.pid ? String(status.pid) : "not running"} />
        <DaemonMetric label="Port" value={status?.port ? String(status.port) : "n/a"} />
        <DaemonMetric label="Uptime" value={formatUptime(status?.uptimeMs ?? null)} />
      </div>

      <TunnelManager status={status} tunnelProviders={tunnelProviders} tunnelProbe={tunnelProbe} send={send} />

      <div className="daemon-section-divider" aria-hidden="true" />

      {bearerAvailable ? (
        <div className="list-row" style={{ marginTop: 8, alignItems: "flex-start" }} data-testid="bearer-reveal-row">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
              Bearer token
              {isRevealLive ? (
                <span
                  style={{ marginLeft: 8, fontSize: "0.66rem", fontWeight: 500 }}
                  className="text-[var(--text-muted)]"
                  data-testid="bearer-reveal-countdown"
                >
                  clears in {revealRemainingSec}s
                </span>
              ) : null}
            </div>
            <div
              style={{ fontSize: "0.7rem", marginTop: 3, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}
              className="text-[var(--text-muted)]"
              data-testid="bearer-reveal-value"
            >
              {isRevealLive && revealedBearer ? (
                // Bearer is in webview state for ≤30s by explicit user consent.
                // Raw text on purpose — the user just clicked Reveal and
                // confirmed the modal to see this value; rendering a masked
                // string here would defeat the feature.
                <code>{revealedBearer.bearer}</code>
              ) : (
                <>&lt;hidden — click Reveal or Copy&gt;</>
              )}
            </div>
            <div style={{ fontSize: "0.66rem", marginTop: 4 }} className="text-[var(--text-muted)]">
              Required in an <code>Authorization: Bearer …</code> header for every MCP request (loopback or tunnel).
              Reveal / Copy opens a modal confirmation; reveal auto-clears after 30s.
            </div>
          </div>
          <div className="flex items-center gap-1 flex-wrap" style={{ justifyContent: "flex-end" }}>
            <DaemonActionButton
              type="daemon:bearer:reveal"
              label="Reveal token"
              pendingLabel="Waiting…"
              onClick={revealBearer}
            />
            <DaemonActionButton
              type="daemon:bearer:copy"
              label="Copy"
              pendingLabel="Waiting…"
              icon={<Copy size={11} />}
              onClick={copyBearer}
            />
            {bearerFeedback ? (
              <span style={{ fontSize: "0.66rem" }} className="text-[var(--text-muted)]">
                {bearerFeedback}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="daemon-section-divider" aria-hidden="true" />

      <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 10 }}>
        <DaemonActionButton
          type="daemon:status"
          label="Refresh"
          pendingLabel="Refreshing…"
          icon={<RefreshCcw size={11} />}
          onClick={() => { console.log("[trace] DaemonStatus click", { button: "daemon:status" }); send({ type: "daemon:status" }); }}
        />
        <DaemonActionButton
          type="daemon:rotate-token"
          label="Rotate token"
          pendingLabel="Rotating…"
          icon={<KeyRound size={11} />}
          disabled={!status?.running}
          onClick={() => { console.log("[trace] DaemonStatus click", { button: "daemon:rotate-token" }); send({ type: "daemon:rotate-token" }); }}
        />
        <DaemonActionButton
          type="daemon:restart"
          label="Restart daemon"
          pendingLabel="Restarting…"
          icon={<Power size={11} />}
          title="Stop the current daemon and spawn a fresh one. Use after a VSIX upgrade if the daemon is out of sync."
          onClick={() => { console.log("[trace] DaemonStatus click", { button: "daemon:restart" }); send({ type: "daemon:restart" }); }}
        />
        <DaemonActionButton
          type="daemon:kill"
          label="Kill daemon"
          pendingLabel="Killing…"
          icon={<Skull size={11} />}
          className="danger-button btn-sm"
          title="Force-kill the daemon. Use when tunnels are stuck (ERR_NGROK_334), the daemon isn't responding, or you want a clean-slate reset. Does NOT auto-respawn; click Restart after."
          onClick={() => { console.log("[trace] DaemonStatus click", { button: "daemon:kill" }); send({ type: "daemon:kill" }); }}
        />
        <DaemonActionButton
          type="diagnostics:capture"
          label="Capture diagnostics"
          pendingLabel="Capturing…"
          icon={<FileArchive size={11} />}
          title="Package redacted daemon logs, config, and a doctor report into a .zip for bug reports."
          onClick={() => { console.log("[trace] DaemonStatus click", { button: "diagnostics:capture" }); send({ type: "diagnostics:capture" }); }}
        />
      </div>
      {status?.url ? (
        <div style={{ fontSize: "0.68rem", marginTop: 4 }} className="text-[var(--text-muted)]">
          Loopback {status.url}
        </div>
      ) : null}

      <details style={{ marginTop: 12 }}>
        <summary className="daemon-disclosure-summary" style={{ cursor: "pointer", listStyle: "none" }}>
          <div style={{ flex: 1 }}>
            <div className="eyebrow">Audit Tail</div>
            <div className="title">Last tool calls</div>
          </div>
          {auditTail.length > 0 ? (
            <span className="chip chip-neutral" style={{ marginLeft: 8, fontSize: "0.62rem" }}>
              {auditTail.length}
            </span>
          ) : null}
          <ChevronDown size={14} className="daemon-disclosure-icon text-[var(--text-muted)]" />
        </summary>
        {auditTail.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 8 }}>No daemon tool calls recorded yet.</div>
        ) : (
          <div className="flex flex-col gap-2" style={{ maxHeight: 220, overflow: "auto", marginTop: 8 }}>
            {[...auditTail].reverse().map((entry, index) => (
              <div key={`${entry.timestamp}-${entry.tool}-${index}`} className="list-row">
                <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                  <ServerCog size={12} className={entry.ok ? "text-[#86efac]" : "text-[#fca5a5]"} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "0.75rem", fontWeight: 600 }} className="text-[var(--text-primary)]">{entry.tool}</div>
                    <div style={{ fontSize: "0.66rem" }} className="text-[var(--text-muted)]">
                      {entry.clientId} / {entry.source} / <RelativeTime iso={entry.timestamp} />
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
      </details>
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

