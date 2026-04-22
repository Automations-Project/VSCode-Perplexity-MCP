import { Copy, Globe2, KeyRound, Power, RefreshCcw, ServerCog, Skull } from "lucide-react";
import { useEffect, useState } from "react";
import type { DaemonAuditEntry, DaemonStatusState, WebviewMessage } from "@perplexity-user-mcp/shared";
import { useDashboardStore } from "../store";

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

type TunnelProvidersState = NonNullable<ReturnType<typeof useDashboardStore.getState>["tunnelProviders"]>;

export function DaemonStatus({ send }: { send: SendFn }) {
  const status = useDashboardStore((store) => store.daemonStatus);
  const auditTail = useDashboardStore((store) => store.daemonAuditTail);
  const tokenRotatedAt = useDashboardStore((store) => store.daemonTokenRotatedAt);
  const tunnelProviders = useDashboardStore((store) => store.tunnelProviders);
  const revealedBearer = useDashboardStore((store) => store.revealedBearer);
  const clearRevealedBearer = useDashboardStore((store) => store.clearRevealedBearer);
  return (
    <DaemonStatusView
      status={status}
      auditTail={auditTail}
      tokenRotatedAt={tokenRotatedAt}
      tunnelProviders={tunnelProviders}
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
  revealedBearer,
  clearRevealedBearer,
  send,
}: {
  status: DaemonStatusState | null;
  auditTail: DaemonAuditEntry[];
  tokenRotatedAt: string | null;
  tunnelProviders?: TunnelProvidersState | null;
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
  const [authtokenInput, setAuthtokenInput] = useState("");
  const [domainInput, setDomainInput] = useState("");
  useEffect(() => {
    if (!tunnelProviders) {
      send({ type: "daemon:list-tunnel-providers" });
    }
  }, [tunnelProviders, send]);
  const activeProvider = tunnelProviders?.activeProvider ?? "cf-quick";
  const ngrokEntry = tunnelProviders?.providers.find((p) => p.id === "ngrok");
  const ngrokConfigured = tunnelProviders?.ngrok.configured ?? false;
  const ngrokDomain = tunnelProviders?.ngrok.domain;
  const showNgrokSetup = activeProvider === "ngrok";
  const [revealed, setRevealed] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
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
  const tunnelActive = tunnel.status === "enabled" || tunnel.status === "starting";
  const tunnelUrl = tunnel.url ?? null;
  const bearerAvailable = status?.bearerAvailable ?? false;
  const loopbackUrl = status?.url ?? null;

  const flashFeedback = (msg: string) => {
    setCopyFeedback(msg);
    window.setTimeout(() => setCopyFeedback((prev) => (prev === msg ? null : prev)), 1500);
  };

  const copyText = async (value: string, label: string) => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      flashFeedback(`Copied ${label}`);
    } catch {
      flashFeedback(`Copy ${label} failed`);
    }
  };

  const copyTunnelUrl = () => {
    if (!tunnelUrl || !revealed) return;
    void copyText(tunnelUrl, "tunnel URL");
  };

  // Bearer copy + reveal are delegated to the extension host so the raw
  // token never touches the webview state / postMessage channel. See
  // daemon:bearer:copy + daemon:bearer:reveal handlers in DashboardProvider.
  const copyBearer = () => {
    if (!bearerAvailable) return;
    send({ type: "daemon:bearer:copy" });
    flashFeedback("Copy requested");
  };

  const revealBearer = () => {
    if (!bearerAvailable) return;
    send({ type: "daemon:bearer:reveal" });
    flashFeedback("Reveal requested");
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

      {tunnelProviders ? (
        <div className="list-row" style={{ marginTop: 10, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
              Tunnel provider
            </div>
            <div style={{ fontSize: "0.66rem", marginTop: 3 }} className="text-[var(--text-muted)]">
              {tunnelProviders.providers.find((p) => p.id === activeProvider)?.description}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-wrap" style={{ justifyContent: "flex-end" }}>
            <select
              className="ghost-button btn-sm"
              style={{ padding: "4px 8px", fontSize: "0.7rem" }}
              value={activeProvider}
              onChange={(event) => {
                const next = event.target.value as "cf-quick" | "ngrok";
                send({ type: "daemon:set-tunnel-provider", payload: { providerId: next } });
              }}
            >
              {tunnelProviders.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {showNgrokSetup && ngrokEntry && !ngrokEntry.setup.ready ? (
        <div
          className="glass-panel section-panel"
          style={{ marginTop: 10, padding: 10, borderRadius: 8, borderColor: "rgba(255, 180, 80, 0.3)" }}
        >
          <div style={{ fontSize: "0.72rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
            ngrok setup
          </div>
          <div style={{ fontSize: "0.66rem", marginTop: 3 }} className="text-[var(--text-muted)]">
            Paste the authtoken from{" "}
            <a
              href="https://dashboard.ngrok.com/get-started/your-authtoken"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--text-accent, #a78bfa)" }}
            >
              dashboard.ngrok.com
            </a>
            . Required once per machine.
          </div>
          <div className="flex items-center gap-1 flex-wrap" style={{ marginTop: 6 }}>
            <input
              type="password"
              autoComplete="off"
              placeholder="2a1b3c4d…ngrokAuthToken"
              value={authtokenInput}
              onChange={(event) => setAuthtokenInput(event.target.value)}
              style={{ flex: 1, minWidth: 180, fontSize: "0.7rem", padding: "4px 8px", borderRadius: 4 }}
            />
            <button
              className="primary-button btn-sm"
              disabled={authtokenInput.trim().length < 10}
              onClick={() => {
                send({ type: "daemon:set-ngrok-authtoken", payload: { authtoken: authtokenInput.trim() } });
                setAuthtokenInput("");
              }}
            >
              Save authtoken
            </button>
          </div>
        </div>
      ) : null}

      {showNgrokSetup && ngrokConfigured ? (
        <div className="list-row" style={{ marginTop: 8, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
              ngrok reserved domain <span className="text-[var(--text-muted)]">(optional)</span>
            </div>
            <div style={{ fontSize: "0.66rem", marginTop: 3 }} className="text-[var(--text-muted)]">
              Without a reserved domain ngrok gives you a new random hostname each run. Reserve one free{" "}
              <a
                href="https://dashboard.ngrok.com/domains"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--text-accent, #a78bfa)" }}
              >
                here
              </a>
              .
            </div>
          </div>
          <div className="flex items-center gap-1 flex-wrap" style={{ justifyContent: "flex-end" }}>
            <input
              type="text"
              autoComplete="off"
              placeholder={ngrokDomain ?? "yourname.ngrok-free.app"}
              value={domainInput}
              onChange={(event) => setDomainInput(event.target.value)}
              style={{ width: 220, fontSize: "0.7rem", padding: "4px 8px", borderRadius: 4 }}
            />
            <button
              className="ghost-button btn-sm"
              onClick={() => {
                send({ type: "daemon:set-ngrok-domain", payload: { domain: domainInput.trim() || null } });
                setDomainInput("");
              }}
            >
              Save
            </button>
            <button
              className="ghost-button btn-sm"
              onClick={() => send({ type: "daemon:clear-ngrok-settings" })}
            >
              Forget authtoken
            </button>
          </div>
        </div>
      ) : null}

      <div className="list-row" style={{ marginTop: 10, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
            {activeProvider === "ngrok" ? "ngrok tunnel" : "Cloudflare Quick Tunnel"}
          </div>
          <div style={{ fontSize: "0.7rem", marginTop: 3 }} className="text-[var(--text-muted)] break-all">
            {tunnelUrl ? (revealed ? tunnelUrl : maskTunnelUrl(tunnelUrl)) : "No public tunnel URL."}
          </div>
          {tunnel.error ? (
            <div style={{ fontSize: "0.68rem", marginTop: 4 }} className="text-[#fca5a5]">{tunnel.error}</div>
          ) : null}
          {tunnel.error && /ERR_NGROK_334/.test(tunnel.error) ? (
            <div className="flex items-center gap-1 flex-wrap" style={{ marginTop: 6 }}>
              <button
                className="primary-button btn-sm"
                onClick={() => {
                  console.log("[trace] DaemonStatus click", { button: "ngrok:try-ephemeral" });
                  send({ type: "daemon:set-ngrok-domain", payload: { domain: null } });
                  setTimeout(() => send({ type: "daemon:enable-tunnel" }), 400);
                }}
              >
                Try ephemeral URL
              </button>
              <a
                className="ghost-button btn-sm"
                href="https://dashboard.ngrok.com/endpoints"
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: "none" }}
              >
                Open ngrok endpoints page
              </a>
            </div>
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
            onClick={() => {
              const msgType = tunnelActive ? "daemon:disable-tunnel" : "daemon:enable-tunnel";
              console.log("[trace] DaemonStatus click", { button: msgType, status: status ?? null, tunnel });
              send({ type: msgType });
            }}
            disabled={tunnel.status === "starting"}
            title="Tunnel enablement is confirmed by the extension host before any public URL is created."
          >
            <Globe2 size={11} />
            {tunnelActive ? "Disable" : "Enable"}
          </button>
        </div>
      </div>

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
              style={{ fontSize: "0.7rem", marginTop: 3, fontFamily: "var(--font-mono, monospace)" }}
              className="text-[var(--text-muted)] break-all"
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
              Reveal / copy flows through a modal security confirmation in the VS Code host; reveal auto-clears after 30s.
            </div>
          </div>
          <div className="flex items-center gap-1 flex-wrap" style={{ justifyContent: "flex-end" }}>
            <button className="ghost-button btn-sm" onClick={revealBearer}>
              Reveal token
            </button>
            <button className="ghost-button btn-sm" onClick={copyBearer}>
              <Copy size={11} />
              Copy
            </button>
          </div>
        </div>
      ) : null}

      {copyFeedback ? (
        <div style={{ fontSize: "0.68rem", marginTop: 6 }} className="text-[var(--text-muted)]">
          {copyFeedback}
        </div>
      ) : null}

      <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 10 }}>
        <button className="ghost-button btn-sm" onClick={() => { console.log("[trace] DaemonStatus click", { button: "daemon:status" }); send({ type: "daemon:status" }); }}>
          <RefreshCcw size={11} />
          Refresh
        </button>
        <button className="ghost-button btn-sm" disabled={!status?.running} onClick={() => { console.log("[trace] DaemonStatus click", { button: "daemon:rotate-token" }); send({ type: "daemon:rotate-token" }); }}>
          <KeyRound size={11} />
          Rotate token
        </button>
        <button className="ghost-button btn-sm" onClick={() => { console.log("[trace] DaemonStatus click", { button: "daemon:restart" }); send({ type: "daemon:restart" }); }} title="Stop the current daemon and spawn a fresh one. Use after a VSIX upgrade if the daemon is out of sync.">
          <Power size={11} />
          Restart daemon
        </button>
        <button
          className="ghost-button btn-sm"
          onClick={() => { console.log("[trace] DaemonStatus click", { button: "daemon:kill" }); send({ type: "daemon:kill" }); }}
          title="Force-kill the daemon. Use when tunnels are stuck (ERR_NGROK_334), the daemon isn't responding, or you want a clean-slate reset. Does NOT auto-respawn; click Restart after."
          style={{ color: "#fca5a5" }}
        >
          <Skull size={11} />
          Kill daemon
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
