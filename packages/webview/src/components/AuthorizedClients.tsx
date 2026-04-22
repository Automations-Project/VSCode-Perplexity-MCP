import React from "react";

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
  if (!clients || clients.length === 0) {
    return (
      <section className="pplx-card" aria-labelledby="authorized-clients-heading">
        <h2 id="authorized-clients-heading">Authorized OAuth clients</h2>
        <p className="pplx-empty-state">No external MCP clients have registered yet.</p>
      </section>
    );
  }
  return (
    <section className="pplx-card" aria-labelledby="authorized-clients-heading">
      <header className="pplx-card-header">
        <h2 id="authorized-clients-heading">Authorized OAuth clients</h2>
        <button type="button" onClick={onRevokeAll}>Revoke all</button>
      </header>
      <table className="pplx-client-table">
        <thead>
          <tr>
            <th scope="col">Client</th>
            <th scope="col">Client ID</th>
            <th scope="col">Last used</th>
            <th scope="col">Consent approved</th>
            <th scope="col">Active tokens</th>
            <th scope="col" aria-label="Actions"></th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.clientId}>
              <td>{c.clientName ?? "(unnamed)"}</td>
              <td><code title={c.clientId}>{truncate(c.clientId)}</code></td>
              <td>{formatDate(c.lastUsedAt)}</td>
              <td>{formatDate(c.consentLastApprovedAt)}</td>
              <td>{c.activeTokens} tokens</td>
              <td><button type="button" onClick={() => onRevoke(c.clientId)}>Revoke</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
