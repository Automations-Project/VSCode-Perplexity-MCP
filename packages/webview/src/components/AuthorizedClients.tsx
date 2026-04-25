import { ShieldX } from "lucide-react";

export interface AuthorizedClientRow {
  clientId: string;
  clientName?: string;
  registeredAt: number;
  lastUsedAt?: string;
  consentLastApprovedAt?: string;
  activeTokens: number;
}

export interface AuthorizedClientsProps {
  clients: AuthorizedClientRow[];
  onRevoke: (clientId: string) => void;
  onRevokeAll: () => void;
}

function truncate(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function formatDate(iso?: string): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AuthorizedClients({ clients, onRevoke, onRevokeAll }: AuthorizedClientsProps) {
  return (
    <div className="glass-panel section-panel" aria-labelledby="authorized-clients-heading">
      <div className="section-header authorized-section-header">
        <div className="eyebrow">Security</div>
        <div className="title" id="authorized-clients-heading">Authorized OAuth clients</div>
      </div>

      {clients.length === 0 ? (
        <div className="empty-state">No external MCP clients have registered yet.</div>
      ) : (
        <div className="authorized-client-list">
          {clients.map((c) => (
            <div key={c.clientId} className="list-row authorized-client-row">
              <div className="authorized-client-body">
                <div className="authorized-client-name">
                  {c.clientName ?? "(unnamed)"}
                </div>
                <div className="authorized-client-id">
                  <code title={c.clientId}>{truncate(c.clientId)}</code>
                </div>
                <div className="authorized-client-meta">
                  Last used {formatDate(c.lastUsedAt)} · Consent {formatDate(c.consentLastApprovedAt)} · {c.activeTokens} active token{c.activeTokens === 1 ? "" : "s"}
                </div>
              </div>
              <button
                className="danger-button btn-sm"
                onClick={() => onRevoke(c.clientId)}
                title={`Revoke ${c.clientName ?? c.clientId}`}
              >
                <ShieldX size={11} />
                Revoke
              </button>
            </div>
          ))}
          <div className="daemon-section-divider" aria-hidden="true" />
          <div className="authorized-client-footer">
            <span className="authorized-client-count">
              {clients.length} client{clients.length === 1 ? "" : "s"}
            </span>
            <button className="danger-button btn-sm" onClick={onRevokeAll}>
              <ShieldX size={11} />
              Revoke all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
