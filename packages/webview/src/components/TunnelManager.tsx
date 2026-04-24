import { Activity, Copy, Globe2, RefreshCcw, RotateCw, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { DaemonStatusState, WebviewMessage } from "@perplexity-user-mcp/shared";
import { useDashboardStore, useIsActionPending, type TunnelProbeState } from "../store";
import { CfNamedRow, deriveCfNamedState } from "./CfNamedRow";
import { DaemonActionButton } from "./DaemonActionButton";
import { NgrokRow } from "./NgrokRow";
import { RemoteAccessOptIn } from "./RemoteAccessOptIn";
import { TunnelPerformance } from "./TunnelPerformance";

export { deriveCfNamedState };

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;
export type TunnelProvidersState = NonNullable<ReturnType<typeof useDashboardStore.getState>["tunnelProviders"]>;

/**
 * v0.8.5: loopback-default posture. If `settings.enableTunnels === false`
 * (the default for fresh installs, and the migrated state for users with no
 * tunnel-settings.json), render a minimal opt-in card instead of the full
 * provider picker + enable/disable controls.
 *
 * `enableTunnels` can be supplied as a prop (preferred — explicit data flow
 * from DaemonStatus, and robust to SSR where zustand falls back to its
 * initial-state snapshot). When omitted, falls back to the store. The prop
 * path is what DaemonStatus actually uses in production.
 */
export function TunnelManager({
  status,
  tunnelProviders,
  tunnelProbe,
  enableTunnels,
  send,
}: {
  status: DaemonStatusState | null;
  tunnelProviders?: TunnelProvidersState | null;
  tunnelProbe?: TunnelProbeState | null;
  enableTunnels?: boolean;
  send: SendFn;
}) {
  const storeEnableTunnels = useDashboardStore(
    (store) => store.state?.settings.enableTunnels ?? false
  );
  const effectiveEnableTunnels = enableTunnels ?? storeEnableTunnels;

  if (!effectiveEnableTunnels) {
    return <RemoteAccessOptIn send={send} />;
  }

  return (
    <FullTunnelManager
      status={status}
      tunnelProviders={tunnelProviders}
      tunnelProbe={tunnelProbe}
      send={send}
    />
  );
}

function FullTunnelManager({
  status,
  tunnelProviders,
  tunnelProbe,
  send,
}: {
  status: DaemonStatusState | null;
  tunnelProviders?: TunnelProvidersState | null;
  tunnelProbe?: TunnelProbeState | null;
  send: SendFn;
}) {
  const [revealed, setRevealed] = useState(false);
  const [tunnelFeedback, setTunnelFeedback] = useState<string | null>(null);
  const [pendingProvider, setPendingProvider] = useState<"cf-quick" | "ngrok" | "cf-named" | null>(null);

  useEffect(() => {
    if (!tunnelProviders) {
      send({ type: "daemon:list-tunnel-providers" });
    }
  }, [tunnelProviders, send]);

  useEffect(() => {
    if (pendingProvider && tunnelProviders?.activeProvider === pendingProvider) {
      setPendingProvider(null);
    }
  }, [pendingProvider, tunnelProviders?.activeProvider]);

  const activeProvider = tunnelProviders?.activeProvider ?? "cf-quick";
  const ngrokEntry = tunnelProviders?.providers.find((p) => p.id === "ngrok");
  const cfNamedEntry = tunnelProviders?.providers.find((p) => p.id === "cf-named");
  const tunnel = status?.tunnel ?? { status: "disabled", url: null, pid: null, error: null };
  const tunnelActive = tunnel.status === "enabled" || tunnel.status === "starting";
  const tunnelUrl = tunnel.url ?? null;
  const pendingEnableTunnel = useIsActionPending("daemon:enable-tunnel");
  const pendingDisableTunnel = useIsActionPending("daemon:disable-tunnel");
  const pendingProviderSwitch = useIsActionPending("daemon:set-tunnel-provider");
  const pendingProbe = useIsActionPending("daemon:tunnel-probe");
  const tunnelBusy = pendingEnableTunnel || pendingDisableTunnel || tunnel.status === "starting";

  const flashTunnel = (msg: string) => {
    setTunnelFeedback(msg);
    window.setTimeout(() => setTunnelFeedback((prev) => (prev === msg ? null : prev)), 1500);
  };

  const copyTunnelUrl = async () => {
    if (!tunnelUrl || !revealed || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(tunnelUrl);
      flashTunnel("Copied tunnel URL");
    } catch {
      flashTunnel("Copy failed");
    }
  };

  const retryTunnel = () => {
    send({ type: "daemon:disable-tunnel" });
    window.setTimeout(() => send({ type: "daemon:enable-tunnel" }), 400);
  };

  return (
    <>
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
            {pendingProviderSwitch ? (
              <RefreshCcw size={11} className="refresh-spin text-[var(--text-muted)]" />
            ) : null}
            <select
              className="setting-select"
              style={{ padding: "4px 8px", fontSize: "0.7rem", width: "auto", minWidth: 120 }}
              value={pendingProvider ?? activeProvider}
              disabled={pendingProviderSwitch}
              onChange={(event) => {
                const next = event.target.value as "cf-quick" | "ngrok" | "cf-named";
                setPendingProvider(next);
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

      <div className="daemon-section-divider" aria-hidden="true" />

      <NgrokRow
        active={activeProvider === "ngrok"}
        configured={tunnelProviders?.ngrok.configured ?? false}
        domain={tunnelProviders?.ngrok.domain}
        setupReady={ngrokEntry?.setup.ready}
        send={send}
      />

      <CfNamedRow
        active={activeProvider === "cf-named"}
        entry={cfNamedEntry}
        cfNamed={tunnelProviders?.cfNamed}
        send={send}
      />

      {activeProvider === "cf-named" && tunnel.status === "enabled" && tunnelUrl ? (
        <div
          className="cf-named-waf-warning"
          data-testid="cf-named-waf-warning"
          role="note"
        >
          <ShieldAlert size={14} aria-hidden="true" style={{ flex: "0 0 auto", marginTop: 1 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div>
              <strong>Cloudflare challenge may block MCP clients.</strong>{" "}
              Before connecting any MCP client to <code>{tunnelUrl}/mcp</code>, exempt that path
              from Cloudflare Access and the Zone&apos;s challenge rules. The simplest option:
              add a WAF Skip rule for requests to <code>Path = &quot;/mcp&quot;</code> on this
              hostname. Without this, MCP requests get served the Cloudflare Challenge page
              instead of reaching the daemon.
            </div>
            <div style={{ marginTop: 4 }}>
              <a
                href="https://developers.cloudflare.com/waf/custom-rules/skip/"
                target="_blank"
                rel="noopener noreferrer"
                data-testid="cf-named-waf-warning-docs"
              >
                Cloudflare WAF Skip rule docs
              </a>
            </div>
          </div>
        </div>
      ) : null}

      <div className="daemon-section-divider" aria-hidden="true" />

      <div className="list-row" style={{ marginTop: 10, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
            {activeProvider === "ngrok"
              ? "ngrok tunnel"
              : activeProvider === "cf-named"
                ? "Cloudflare Named Tunnel"
                : "Cloudflare Quick Tunnel"}
          </div>
          <div style={{ fontSize: "0.7rem", marginTop: 3, overflowWrap: "anywhere" }} className="text-[var(--text-muted)]">
            {tunnelUrl ? (revealed ? tunnelUrl : maskTunnelUrl(tunnelUrl)) : "No public tunnel URL."}
          </div>
          {tunnel.error ? (
            <div style={{ fontSize: "0.68rem", marginTop: 4 }} className="text-[#fca5a5]">{tunnel.error}</div>
          ) : null}
          {tunnel.error && /ERR_NGROK_334/.test(tunnel.error) ? (
            <div className="flex items-center gap-1 flex-wrap" style={{ marginTop: 6 }}>
              <button
                className="primary-button btn-sm"
                disabled={tunnelBusy}
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
          {(tunnel.status === "crashed" || (tunnel.error && !/ERR_NGROK_334/.test(tunnel.error))) ? (
            <div className="flex items-center gap-1 flex-wrap" style={{ marginTop: 6 }}>
              <button
                className="primary-button btn-sm"
                disabled={tunnelBusy}
                onClick={retryTunnel}
                title="Disable then re-enable the tunnel. Cleanly releases the previous process/URL before retrying."
                data-testid="tunnel-retry"
              >
                {tunnelBusy ? (
                  <RefreshCcw size={11} className="refresh-spin" />
                ) : (
                  <RotateCw size={11} />
                )}
                Retry tunnel
              </button>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1 flex-wrap" style={{ justifyContent: "flex-end" }}>
          {tunnelUrl ? (
            <>
              <button className="ghost-button btn-sm" onClick={() => setRevealed((value) => !value)}>
                {revealed ? "Hide URL" : "Reveal URL"}
              </button>
              <button className="ghost-button btn-sm" disabled={!revealed} onClick={() => void copyTunnelUrl()}>
                <Copy size={11} />
                Copy
              </button>
            </>
          ) : null}
          <DaemonActionButton
            type={tunnelActive ? "daemon:disable-tunnel" : "daemon:enable-tunnel"}
            label={tunnelActive ? "Disable" : "Enable"}
            pendingLabel={tunnelActive ? "Disabling…" : "Enabling…"}
            icon={<Globe2 size={11} />}
            className={tunnelActive ? "danger-button btn-sm" : "primary-button btn-sm"}
            disabled={tunnel.status === "starting"}
            title="Tunnel enablement is confirmed by the extension host before any public URL is created."
            onClick={() => {
              const msgType = tunnelActive ? "daemon:disable-tunnel" : "daemon:enable-tunnel";
              console.log("[trace] DaemonStatus click", { button: msgType, status: status ?? null, tunnel });
              send({ type: msgType });
            }}
          />
          <DaemonActionButton
            type="daemon:tunnel-probe"
            label="Test URL"
            pendingLabel="Testing…"
            icon={<Activity size={11} />}
            disabled={!tunnelUrl || pendingProbe}
            onClick={() => send({ type: "daemon:tunnel-probe", payload: { targets: ["/", "/mcp"], timeoutMs: 5000 } })}
          />
          {tunnelFeedback ? (
            <span style={{ fontSize: "0.66rem", width: "100%", textAlign: "right" }} className="text-[var(--text-muted)]">
              {tunnelFeedback}
            </span>
          ) : null}
        </div>
      </div>

      <TunnelPerformance />

      <div
        className="remote-access-disable-row"
        style={{ marginTop: 8, textAlign: "right" }}
      >
        <button
          className="ghost-button btn-sm"
          data-testid="remote-access-optin-disable"
          onClick={() =>
            // Routed through settings:update; the extension host intercepts
            // enableTunnels=false to run the VS Code modal + shut down any
            // active tunnel atomically before writing the setting.
            send({
              type: "settings:update",
              payload: { enableTunnels: false },
            })
          }
          title="Hide tunnel options and switch the dashboard back to loopback-only."
        >
          Disable tunnel options
        </button>
      </div>

      {tunnelProbe ? (
        <div className="daemon-inset-panel" style={{ marginTop: 8 }} data-testid="tunnel-probe-result">
          <div style={{ fontSize: "0.72rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
            Tunnel probe
          </div>
          {tunnelProbe.error ? (
            <div style={{ fontSize: "0.66rem", marginTop: 3 }} className="text-[#fca5a5]">
              {tunnelProbe.error}
            </div>
          ) : null}
          <div className="flex flex-col gap-1" style={{ marginTop: 6 }}>
            {tunnelProbe.results.map((result) => (
              <div key={result.target} className="list-row" style={{ padding: 6 }}>
                <div>
                  <div style={{ fontSize: "0.7rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
                    {result.target}
                  </div>
                  <div style={{ fontSize: "0.64rem" }} className="text-[var(--text-muted)]">
                    status {result.status ?? result.error ?? "n/a"}
                    {result.cfMitigated ? " / cf-mitigated challenge" : ""}
                  </div>
                </div>
                <span className={`chip ${probeChipClass(result.verdict)}`}>{probeLabel(result.verdict)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
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

function probeChipClass(verdict: string): string {
  if (verdict === "ok") return "chip-pro";
  if (verdict === "security-flag" || verdict === "challenge") return "chip-danger";
  if (verdict === "retryable") return "chip-warn";
  return "chip-neutral";
}

function probeLabel(verdict: string): string {
  if (verdict === "security-flag") return "security flag";
  if (verdict === "challenge") return "Cloudflare challenge";
  if (verdict === "retryable") return "retryable";
  if (verdict === "ok") return "ok";
  return "unknown";
}
