import type { WebviewMessage } from "@perplexity-user-mcp/shared";

type SendFn = (
  message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">
) => void;

/**
 * v0.8.5 loopback-default UI. Renders in place of the full TunnelManager
 * whenever `settings.enableTunnels === false`. A single "Enable tunnel
 * options" button flips the VS Code setting (via `settings:update`) and the
 * re-rendered dashboard swaps this opt-in card for the full manager.
 *
 * Intentionally minimal: no provider picker, no status, no URL. The point is
 * to surface remote-access as an explicit opt-in rather than a default.
 */
export function RemoteAccessOptIn({ send }: { send: SendFn }) {
  return (
    <div
      className="remote-access-optin"
      data-testid="remote-access-optin"
      style={{ marginTop: 10 }}
    >
      <div className="section-header">
        <div className="eyebrow">Remote access</div>
        <div className="title">Tunnel disabled</div>
        <div className="detail">
          The daemon is only reachable on 127.0.0.1 on this machine. Enable a
          tunnel if you need another machine (or a cloud service) to reach the
          MCP server over the internet.
        </div>
      </div>
      <button
        className="ghost-button btn-sm"
        data-testid="remote-access-optin-enable"
        onClick={() =>
          send({
            type: "settings:update",
            payload: { enableTunnels: true },
          })
        }
      >
        Enable tunnel options
      </button>
      <div
        className="remote-access-optin-note"
        style={{ fontSize: "0.66rem", marginTop: 6 }}
      >
        Recommended only if you need remote access. Requires choosing a
        provider (Cloudflare or ngrok) + authenticating with them. Read the
        docs before exposing the MCP server publicly.
      </div>
    </div>
  );
}
