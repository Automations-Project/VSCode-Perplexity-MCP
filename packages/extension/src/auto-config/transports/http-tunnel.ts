import type { TransportBuilder, TransportBuildInput, McpServerEntry } from "./index.js";
import { StabilityGateError } from "./index.js";

/**
 * `http-tunnel` — the persistent-URL transport. Client reaches the daemon over a
 * tunnel (cf-named reserved domain or ngrok with a reserved domain). See Phase
 * 8.6 design §7.5 for the rationale. This builder NEVER writes `headers`:
 * clients MUST authenticate via OAuth against the tunnel. Baking a scoped bearer
 * into a config that goes over the public internet would be a security disaster.
 *
 * Stability gate rejections (throw `StabilityGateError`):
 *   - tunnelUrl is null/empty (nothing to write).
 *   - tunnelProviderId is null while URL is set (provider unknown).
 *   - tunnelProviderId === "cf-quick" (ephemeral URL, changes on every start).
 *   - tunnelProviderId === "ngrok" && tunnelReservedDomain === false.
 *
 * Accepted:
 *   - tunnelProviderId === "cf-named" (always persistent by design — ignores tunnelReservedDomain).
 *   - tunnelProviderId === "ngrok" && tunnelReservedDomain === true.
 *
 * URL normalization: append `/mcp` to the tunnel root if not already present;
 * strip any trailing slash. Scheme (http vs https) is not enforced here — the
 * dispatcher decides policy.
 */
function buildHttpTunnel(input: TransportBuildInput): McpServerEntry {
  const { tunnelUrl, tunnelProviderId, tunnelReservedDomain } = input;

  if (tunnelUrl === null || tunnelUrl === "") {
    throw new StabilityGateError(
      "http-tunnel",
      "tunnel URL unavailable — enable the tunnel on the dashboard before generating an http-tunnel config"
    );
  }

  if (tunnelProviderId === null) {
    throw new StabilityGateError(
      "http-tunnel",
      "tunnel provider unknown — cannot evaluate stability"
    );
  }

  if (tunnelProviderId === "cf-quick") {
    throw new StabilityGateError(
      "http-tunnel",
      "cf-quick tunnels are ephemeral — switch to cf-named (Cloudflare named tunnel on your domain) or ngrok with a reserved domain for persistent http-tunnel configs"
    );
  }

  if (tunnelProviderId === "ngrok" && tunnelReservedDomain === false) {
    throw new StabilityGateError(
      "http-tunnel",
      "ngrok tunnel lacks a reserved domain — pin Perplexity ngrok to a reserved domain before generating an http-tunnel config, or switch to cf-named"
    );
  }

  // cf-named and ngrok-with-reserved-domain fall through as accepted.

  const normalized = normalizeTunnelUrl(tunnelUrl);

  // Intentionally NO headers. `bearerKind === "local"` is silently ignored
  // (defense-in-depth): the dispatcher in 8.6.4 should have forced "none"
  // for this transport, but if someone calls directly with "local" we refuse
  // to leak the token into a public-internet config.
  return { url: normalized };
}

function normalizeTunnelUrl(raw: string): string {
  // Strip an existing trailing `/mcp` (with or without trailing slashes) AND
  // any remaining trailing slashes, then re-append `/mcp`. This unifies all of
  //   "https://host/"       → "https://host/mcp"
  //   "https://host"        → "https://host/mcp"
  //   "https://host/mcp"    → "https://host/mcp"
  //   "https://host/mcp/"   → "https://host/mcp"  (NOT "/mcp/mcp")
  //   "https://host/mcp//"  → "https://host/mcp"
  const stripped = raw.replace(/\/mcp\/*$/, "").replace(/\/+$/, "");
  return `${stripped}/mcp`;
}

export const httpTunnelBuilder: TransportBuilder = {
  id: "http-tunnel",
  supportedFormats: ["json"] as const,
  build: buildHttpTunnel,
};
