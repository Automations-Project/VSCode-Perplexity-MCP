import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { CfNamedManagedConfig, CfNamedTunnelSummary, WebviewMessage } from "@perplexity-user-mcp/shared";
import { DaemonActionButton } from "./DaemonActionButton";
import { CfNamedTunnelList } from "./CfNamedTunnelList";

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

type CfNamedEntry = {
  setup: {
    ready: boolean;
    reason?: string;
  };
};

interface CfNamedState {
  config: CfNamedManagedConfig | null;
  tunnels?: CfNamedTunnelSummary[];
  lastListedAt?: string;
  lastListError?: string;
  lastDeleted?: {
    uuid: string;
    hostname?: string;
    localConfigCleared: boolean;
    dnsCleanupUrl: string;
  };
}

export function CfNamedRow({
  active,
  entry,
  cfNamed,
  send,
}: {
  active: boolean;
  entry?: CfNamedEntry;
  cfNamed?: CfNamedState;
  send: SendFn;
}) {
  const [cfNamedName, setCfNamedName] = useState("");
  const [cfNamedHostname, setCfNamedHostname] = useState("");
  const [cfNamedBindUuid, setCfNamedBindUuid] = useState("");
  const [cfNamedBindHostname, setCfNamedBindHostname] = useState("");

  if (!active || !entry) return null;

  const cfNamedState = deriveCfNamedState(entry.setup);

  return (
    <>
      {!entry.setup.ready ? (
        <div
          className="daemon-inset-panel cf-named-setup-panel"
          data-testid="cf-named-setup-box"
        >
          <div className="daemon-row-title">
            Cloudflare named-tunnel setup
          </div>
          <div className="daemon-row-detail">
            {entry.setup.reason ?? "Setup is not complete."}
          </div>

          {cfNamedState === "missing-binary" ? (
            <div className="daemon-button-row daemon-button-row-spaced">
              <DaemonActionButton
                type="daemon:install-cloudflared"
                label="Install cloudflared"
                pendingLabel="Installing…"
                className="primary-button btn-sm"
                data-testid="cf-named-install-cloudflared"
                onClick={() => send({ type: "daemon:install-cloudflared" })}
              />
            </div>
          ) : null}

          {cfNamedState === "missing-cert" ? (
            <div className="daemon-button-row daemon-button-row-spaced">
              <DaemonActionButton
                type="daemon:cf-named-login"
                label="Run cloudflared login"
                pendingLabel="Waiting for login…"
                className="primary-button btn-sm"
                data-testid="cf-named-login-btn"
                title="Spawns cloudflared tunnel login on the host. Confirmed via a VS Code modal before the browser opens."
                onClick={() => send({ type: "daemon:cf-named-login" })}
              />
            </div>
          ) : null}

          {cfNamedState === "missing-credentials" ? (
            <div
              className="cf-named-error"
              data-testid="cf-named-creds-missing"
            >
              The credentials file for this tunnel's UUID is missing. Create a new tunnel below, bind a different existing UUID, or fix the credentials path manually in <code>~/.perplexity-mcp/cloudflared-named.yml</code>.
            </div>
          ) : null}

          {cfNamedState === "missing-config" || cfNamedState === "missing-credentials" ? (
            <div className="cf-named-section">
              <div className="cf-named-section-title">
                Create a new tunnel
              </div>
              <div className="daemon-button-row daemon-button-row-form">
                <input
                  type="text"
                  placeholder="perplexity-mcp"
                  value={cfNamedName}
                  onChange={(event) => setCfNamedName(event.target.value)}
                  data-testid="cf-named-create-name"
                  className="daemon-compact-input daemon-input-sm"
                />
                <input
                  type="text"
                  placeholder="mcp.example.com"
                  value={cfNamedHostname}
                  onChange={(event) => setCfNamedHostname(event.target.value)}
                  data-testid="cf-named-create-hostname"
                  className="daemon-compact-input daemon-input-lg"
                />
                <DaemonActionButton
                  type="daemon:cf-named-create"
                  label="Create"
                  pendingLabel="Creating…"
                  className="primary-button btn-sm"
                  data-testid="cf-named-create-btn"
                  disabled={cfNamedName.trim().length < 1 || cfNamedHostname.trim().length < 3}
                  onClick={() => {
                    send({
                      type: "daemon:cf-named-create",
                      payload: {
                        mode: "create",
                        name: cfNamedName.trim(),
                        hostname: cfNamedHostname.trim(),
                      },
                    });
                    setCfNamedName("");
                    setCfNamedHostname("");
                  }}
                />
              </div>
              <div className="cf-named-section-title cf-named-section-title-spaced">
                Or bind an existing tunnel
              </div>
              <div className="cf-named-section-hint">
                If you already ran <code>cloudflared tunnel create</code>, paste the UUID + hostname here instead.
              </div>
              <div className="daemon-button-row daemon-button-row-form">
                <input
                  type="text"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  value={cfNamedBindUuid}
                  onChange={(event) => setCfNamedBindUuid(event.target.value)}
                  data-testid="cf-named-bind-uuid"
                  className="daemon-compact-input daemon-input-lg daemon-input-mono"
                />
                <input
                  type="text"
                  placeholder="mcp.example.com"
                  value={cfNamedBindHostname}
                  onChange={(event) => setCfNamedBindHostname(event.target.value)}
                  data-testid="cf-named-bind-hostname"
                  className="daemon-compact-input daemon-input-lg"
                />
                <DaemonActionButton
                  type="daemon:cf-named-create"
                  label="Bind"
                  pendingLabel="Binding…"
                  data-testid="cf-named-bind-btn"
                  disabled={cfNamedBindUuid.trim().length < 8 || cfNamedBindHostname.trim().length < 3}
                  onClick={() => {
                    send({
                      type: "daemon:cf-named-create",
                      payload: {
                        mode: "bind-existing",
                        uuid: cfNamedBindUuid.trim(),
                        hostname: cfNamedBindHostname.trim(),
                      },
                    });
                    setCfNamedBindUuid("");
                    setCfNamedBindHostname("");
                  }}
                />
                <DaemonActionButton
                  type="daemon:cf-named-list"
                  label="List existing"
                  pendingLabel="Listing…"
                  data-testid="cf-named-list-btn"
                  title="Fetch existing tunnels from cloudflared. Results appear as a notice."
                  onClick={() => send({ type: "daemon:cf-named-list" })}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {entry.setup.ready ? (
        <details className="daemon-inset-panel cf-named-managed-caveat" data-testid="cf-named-managed-caveat" open>
          <summary className="daemon-disclosure-summary">
            <span className="cf-named-managed-title">
              Config is provider-managed
            </span>
            <ChevronDown size={11} className="daemon-disclosure-icon text-[var(--text-muted)]" />
          </summary>
          <div className="cf-named-managed-body">
            This tunnel&apos;s YAML at <code>~/.perplexity-mcp/cloudflared-named.yml</code> is provider-managed.
            Adding custom ingress rules by hand will be overwritten on the next daemon start.
          </div>
          {cfNamed?.config ? (
            <div className="cf-named-config-meta">
              <div className="cf-named-config-line">
                Hostname <code>{cfNamed.config.hostname}</code>
              </div>
              <div className="cf-named-config-line">
                UUID <code>{cfNamed.config.uuid}</code>
              </div>
              <div className={cfNamed.config.credentialsPresent ? "cf-named-config-line" : "cf-named-config-line cf-named-config-line-error"}>
                Credentials {cfNamed.config.credentialsPresent ? "present" : "missing"}
              </div>
              <div className="daemon-button-row daemon-button-row-spaced">
                <DaemonActionButton
                  type="daemon:cf-named-unbind-local"
                  label="Unbind local"
                  pendingLabel="Unbinding…"
                  onClick={() => send({
                    type: "daemon:cf-named-unbind-local",
                    payload: { uuid: cfNamed.config?.uuid ?? "" },
                  })}
                />
              </div>
            </div>
          ) : null}
        </details>
      ) : null}

      <CfNamedTunnelList cfNamed={cfNamed} send={send} />
    </>
  );
}

export type CfNamedSetupState =
  | "ready"
  | "missing-binary"
  | "missing-cert"
  | "missing-config"
  | "missing-credentials"
  | "unknown";

export function deriveCfNamedState(setup: { ready: boolean; reason?: string } | undefined): CfNamedSetupState {
  if (!setup) return "unknown";
  if (setup.ready) return "ready";
  const reason = (setup.reason ?? "").toLowerCase();
  if (/not installed/.test(reason)) return "missing-binary";
  if (/credentials file not found/.test(reason)) return "missing-credentials";
  if (/login required|cert\.pem|origin cert not found/.test(reason)) return "missing-cert";
  if (/not configured|run the setup flow|named tunnel/.test(reason)) return "missing-config";
  return "missing-config";
}
