import { Copy, Link2, Trash2 } from "lucide-react";
import { useState } from "react";
import type { CfNamedManagedConfig, CfNamedTunnelSummary, WebviewMessage } from "@perplexity-user-mcp/shared";
import { DaemonActionButton } from "./DaemonActionButton";

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

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

export function CfNamedTunnelList({
  cfNamed,
  send,
}: {
  cfNamed?: CfNamedState;
  send: SendFn;
}) {
  const tunnels = cfNamed?.tunnels ?? [];
  const currentUuid = cfNamed?.config?.uuid ?? null;
  const currentHostname = cfNamed?.config?.hostname;
  const [bindHostname, setBindHostname] = useState(currentHostname ?? "");
  const [confirmByUuid, setConfirmByUuid] = useState<Record<string, string>>({});
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  const setConfirm = (uuid: string, value: string) => {
    setConfirmByUuid((prev) => ({ ...prev, [uuid]: value }));
  };

  const copyText = async (value: string) => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(value);
    setCopiedValue(value);
    window.setTimeout(() => setCopiedValue((prev) => (prev === value ? null : prev)), 1500);
  };

  const rows = dedupeTunnels([
    ...(cfNamed?.config
      ? [{
          uuid: cfNamed.config.uuid,
          name: tunnels.find((t) => t.uuid === cfNamed.config?.uuid)?.name ?? cfNamed.config.uuid,
          connections: tunnels.find((t) => t.uuid === cfNamed.config?.uuid)?.connections,
        }]
      : []),
    ...tunnels,
  ]);

  return (
    <div className="cf-named-tunnel-list" style={{ marginTop: 10 }}>
      {cfNamed?.lastDeleted?.hostname ? (
        <div className="daemon-inset-panel dns-cleanup-callout" style={{ marginBottom: 10 }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
            DNS cleanup needed
          </div>
          <div style={{ fontSize: "0.66rem", marginTop: 4 }} className="text-[var(--text-muted)]">
            The CNAME for <code>{cfNamed.lastDeleted.hostname}</code> now points at a dead tunnel.
          </div>
          <div className="flex items-center gap-1 flex-wrap" style={{ marginTop: 6 }}>
            <button
              className="ghost-button btn-sm"
              onClick={() => void copyText(cfNamed.lastDeleted?.hostname ?? "")}
            >
              <Copy size={11} />
              Copy hostname
            </button>
            <a
              className="ghost-button btn-sm"
              href={cfNamed.lastDeleted.dnsCleanupUrl}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "none" }}
            >
              Open Cloudflare DNS
            </a>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-1 flex-wrap" style={{ marginBottom: rows.length ? 8 : 0 }}>
        <input
          type="text"
          value={bindHostname}
          onChange={(event) => setBindHostname(event.target.value)}
          placeholder={currentHostname ?? "hostname for Bind"}
          style={{ flex: "1 1 180px", minWidth: 160, fontSize: "0.7rem", padding: "4px 8px", borderRadius: 4 }}
        />
        <DaemonActionButton
          type="daemon:cf-named-list"
          label="List existing"
          pendingLabel="Listing…"
          data-testid="cf-named-list-btn"
          onClick={() => send({ type: "daemon:cf-named-list" })}
        />
      </div>

      {cfNamed?.lastListError ? (
        <div style={{ fontSize: "0.66rem", marginBottom: 8 }} className="text-[#fca5a5]">
          {cfNamed.lastListError}
        </div>
      ) : null}

      {rows.length === 0 ? null : (
        <>
          <div className="cf-named-card-list">
            {rows.map((tunnel) => (
              <TunnelCard
                key={tunnel.uuid}
                tunnel={tunnel}
                current={tunnel.uuid === currentUuid}
                hostname={tunnel.uuid === currentUuid ? currentHostname : bindHostname.trim()}
                bindDisabled={!resolveBindHostname(tunnel.uuid, currentUuid, currentHostname, bindHostname)}
                confirmValue={confirmByUuid[tunnel.uuid] ?? ""}
                copied={copiedValue === tunnel.uuid}
                onConfirmChange={(value) => setConfirm(tunnel.uuid, value)}
                onCopy={() => void copyText(tunnel.uuid)}
                onBind={() => {
                  const hostname = resolveBindHostname(tunnel.uuid, currentUuid, currentHostname, bindHostname);
                  if (!hostname) return;
                  send({
                    type: "daemon:cf-named-create",
                    payload: { mode: "bind-existing", uuid: tunnel.uuid, hostname },
                  });
                }}
                onDelete={() => {
                  send({
                    type: "daemon:cf-named-delete-remote",
                    payload: {
                      uuid: tunnel.uuid,
                      name: tunnel.name,
                      ...(tunnel.uuid === currentUuid && currentHostname ? { hostname: currentHostname } : {}),
                    },
                  });
                }}
              />
            ))}
          </div>

          <table className="cf-named-tunnel-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>UUID</th>
                <th>Connections</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((tunnel) => {
                const deleteConfirm = confirmByUuid[tunnel.uuid] ?? "";
                const deleteReady = deleteConfirm === tunnel.name || deleteConfirm === tunnel.uuid;
                const hostname = resolveBindHostname(tunnel.uuid, currentUuid, currentHostname, bindHostname);
                return (
                  <tr key={tunnel.uuid}>
                    <td>
                      {tunnel.name}
                      {tunnel.uuid === currentUuid ? <span className="chip chip-pro">current</span> : null}
                    </td>
                    <td><code>{shortUuid(tunnel.uuid)}</code></td>
                    <td>{typeof tunnel.connections === "number" ? tunnel.connections : "n/a"}</td>
                    <td>
                      <div className="flex items-center gap-1 flex-wrap">
                        <button className="ghost-button btn-sm" onClick={() => void copyText(tunnel.uuid)}>
                          <Copy size={11} />
                          {copiedValue === tunnel.uuid ? "Copied" : "Copy UUID"}
                        </button>
                        <DaemonActionButton
                          type="daemon:cf-named-create"
                          label="Bind"
                          pendingLabel="Binding…"
                          icon={<Link2 size={11} />}
                          disabled={!hostname}
                          onClick={() => {
                            if (!hostname) return;
                            send({
                              type: "daemon:cf-named-create",
                              payload: { mode: "bind-existing", uuid: tunnel.uuid, hostname },
                            });
                          }}
                        />
                        <input
                          type="text"
                          value={deleteConfirm}
                          onChange={(event) => setConfirm(tunnel.uuid, event.target.value)}
                          placeholder="name or full UUID"
                          style={{ width: 140, fontSize: "0.7rem", padding: "4px 8px", borderRadius: 4 }}
                        />
                        <DaemonActionButton
                          type="daemon:cf-named-delete-remote"
                          label="Delete remote"
                          pendingLabel="Deleting…"
                          icon={<Trash2 size={11} />}
                          className="danger-button btn-sm"
                          disabled={!deleteReady}
                          onClick={() => send({
                            type: "daemon:cf-named-delete-remote",
                            payload: {
                              uuid: tunnel.uuid,
                              name: tunnel.name,
                              ...(tunnel.uuid === currentUuid && currentHostname ? { hostname: currentHostname } : {}),
                            },
                          })}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function TunnelCard({
  tunnel,
  current,
  hostname,
  bindDisabled,
  confirmValue,
  copied,
  onConfirmChange,
  onCopy,
  onBind,
  onDelete,
}: {
  tunnel: CfNamedTunnelSummary;
  current: boolean;
  hostname?: string;
  bindDisabled: boolean;
  confirmValue: string;
  copied: boolean;
  onConfirmChange: (value: string) => void;
  onCopy: () => void;
  onBind: () => void;
  onDelete: () => void;
}) {
  const deleteReady = confirmValue === tunnel.name || confirmValue === tunnel.uuid;
  return (
    <div className="daemon-inset-panel cf-named-tunnel-card">
      <div className="flex items-center gap-2" style={{ justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 600, overflowWrap: "anywhere" }} className="text-[var(--text-primary)]">
            {tunnel.name}
          </div>
          <div style={{ fontSize: "0.64rem", fontFamily: "var(--font-mono)", marginTop: 2 }} className="text-[var(--text-muted)]">
            {shortUuid(tunnel.uuid)}
          </div>
        </div>
        {current ? <span className="chip chip-pro">current</span> : null}
      </div>
      <div style={{ fontSize: "0.64rem", marginTop: 6 }} className="text-[var(--text-muted)]">
        Connections {typeof tunnel.connections === "number" ? tunnel.connections : "n/a"}
        {hostname ? <> · Hostname {hostname}</> : null}
      </div>
      <div className="flex items-center gap-1 flex-wrap" style={{ marginTop: 8 }}>
        <button className="ghost-button btn-sm" onClick={onCopy}>
          <Copy size={11} />
          {copied ? "Copied" : "Copy UUID"}
        </button>
        <DaemonActionButton
          type="daemon:cf-named-create"
          label="Bind"
          pendingLabel="Binding…"
          icon={<Link2 size={11} />}
          disabled={bindDisabled}
          onClick={onBind}
        />
      </div>
      <div className="flex items-center gap-1 flex-wrap" style={{ marginTop: 8 }}>
        <input
          type="text"
          value={confirmValue}
          onChange={(event) => onConfirmChange(event.target.value)}
          placeholder="exact name or full UUID"
          style={{ flex: "1 1 170px", minWidth: 150, fontSize: "0.7rem", padding: "4px 8px", borderRadius: 4 }}
        />
        <DaemonActionButton
          type="daemon:cf-named-delete-remote"
          label="Delete remote"
          pendingLabel="Deleting…"
          icon={<Trash2 size={11} />}
          className="danger-button btn-sm"
          disabled={!deleteReady}
          onClick={onDelete}
        />
      </div>
    </div>
  );
}

function resolveBindHostname(
  uuid: string,
  currentUuid: string | null,
  currentHostname: string | undefined,
  bindHostname: string,
): string {
  if (uuid === currentUuid && currentHostname) return currentHostname;
  return bindHostname.trim();
}

function dedupeTunnels(tunnels: CfNamedTunnelSummary[]): CfNamedTunnelSummary[] {
  const seen = new Set<string>();
  return tunnels.filter((tunnel) => {
    if (seen.has(tunnel.uuid)) return false;
    seen.add(tunnel.uuid);
    return true;
  });
}

function shortUuid(uuid: string): string {
  if (uuid.length <= 13) return uuid;
  return `${uuid.slice(0, 8)}…${uuid.slice(-4)}`;
}
