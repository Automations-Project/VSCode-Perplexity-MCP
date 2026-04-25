import { ChevronDown, KeyRound, Power, RefreshCcw, ServerCog, Skull } from "lucide-react";
import { useEffect, useState } from "react";
import type { DaemonAuditEntry, DaemonStatusState, WebviewMessage } from "@perplexity-user-mcp/shared";
import { useDashboardStore, type TunnelProbeState } from "../store";
import { BearerReveal } from "./BearerReveal";
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
  // v0.8.5 loopback-default: pull enableTunnels from the live dashboard
  // snapshot and pass explicitly so the TunnelManager wrapper decision
  // doesn't depend on zustand's SSR/client snapshot divergence. Falls back
  // to `false` pre-hydrate — the opt-in card is the right default.
  const enableTunnels = useDashboardStore(
    (store) => store.state?.settings.enableTunnels ?? false,
  );
  return (
    <DaemonStatusView
      status={status}
      auditTail={auditTail}
      tokenRotatedAt={tokenRotatedAt}
      tunnelProviders={tunnelProviders}
      tunnelProbe={tunnelProbe}
      enableTunnels={enableTunnels}
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
  enableTunnels = true,
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
   * v0.8.5: when false, the TunnelManager slot collapses to a single
   * opt-in card. Defaults to `true` so existing callers / tests keep
   * seeing the full manager without requiring a prop change — the live
   * `DaemonStatus` wrapper reads the real value from the store and
   * overrides this default.
   */
  enableTunnels?: boolean;
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

      <div className="daemon-chip-row">
        <span className={`chip ${healthChip.chip}`} data-testid="daemon-health-chip">
          <StatusDot variant={healthChip.dot} decorative />
          {healthChip.label}
        </span>
        <span className={`chip ${tunnel.status === "enabled" ? "chip-accent" : tunnel.status === "crashed" ? "chip-danger" : "chip-muted"}`}>
          Tunnel {tunnel.status === "starting" ? "connecting…" : tunnel.status}
        </span>
        {tokenRotatedAt ? (
          <span className="chip chip-neutral">Token rotated <RelativeTime iso={tokenRotatedAt} /></span>
        ) : null}
      </div>

      <div className="daemon-metric-grid">
        <DaemonMetric label="PID" value={status?.pid ? String(status.pid) : "not running"} />
        <DaemonMetric label="Port" value={status?.port ? String(status.port) : "n/a"} />
        <DaemonMetric label="Uptime" value={formatUptime(status?.uptimeMs ?? null)} />
      </div>

      <TunnelManager
        status={status}
        tunnelProviders={tunnelProviders}
        tunnelProbe={tunnelProbe}
        enableTunnels={enableTunnels}
        send={send}
      />

      <div className="daemon-section-divider" aria-hidden="true" />

      <div role="status" aria-live="polite">
        <BearerReveal
          available={bearerAvailable}
          revealed={revealedBearer ?? null}
          feedback={bearerFeedback}
          onReveal={revealBearer}
          onCopy={copyBearer}
          now={now}
        />
      </div>


      <div className="daemon-section-divider" aria-hidden="true" />

      <div className="daemon-action-row">
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
      </div>
      {status?.url ? (
        <div className="daemon-muted-note">
          Loopback {status.url}
        </div>
      ) : null}

      <details className="daemon-disclosure">
        <summary className="daemon-disclosure-summary">
          <div className="daemon-disclosure-main">
            <div className="eyebrow">Audit Tail</div>
            <div className="title">Last tool calls</div>
          </div>
          {auditTail.length > 0 ? (
            <span className="chip chip-neutral daemon-disclosure-count">
              {auditTail.length}
            </span>
          ) : null}
          <ChevronDown size={14} className="daemon-disclosure-icon text-[var(--text-muted)]" aria-hidden="true" />
        </summary>
        {auditTail.length === 0 ? (
          <div className="empty-state daemon-empty-offset">No daemon tool calls recorded yet.</div>
        ) : (
          <div className="daemon-audit-list">
            {[...auditTail].reverse().map((entry, index) => (
              <div key={`${entry.timestamp}-${entry.tool}-${index}`} className="list-row">
                <div className="daemon-audit-row-main">
                  <ServerCog size={12} className={entry.ok ? "text-[#86efac]" : "text-[#fca5a5]"} />
                  <div className="daemon-audit-entry-body">
                    <div className="daemon-audit-tool">{entry.tool}</div>
                    <div className="daemon-audit-meta">
                      {entry.clientId} / {entry.source} / <RelativeTime iso={entry.timestamp} />
                    </div>
                    {entry.error ? (
                      <div className="daemon-audit-error">{entry.error}</div>
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
    <div className="metric-card daemon-metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value daemon-metric-value">{value}</div>
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

