import type { McpTransportId } from "@perplexity-user-mcp/shared";

/** The format a config file ingests — each builder supports one or both. */
export type TransportFormat = "json" | "toml";

/**
 * The shape a builder produces. Caller (applyIdeConfig in 8.6.4) merges this into
 * the IDE's native config file. Discriminated on presence of `command` vs `url`:
 * stdio variants produce `{ command, args, env? }`; http variants produce
 * `{ url, headers? }`. The two shapes never overlap — no builder returns both.
 */
export type McpServerEntry =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };

/**
 * Inputs every builder receives. `applyIdeConfig` decides `bearerKind` BEFORE
 * calling build; builders never mint tokens themselves (that's `issueLocalToken`
 * in `daemon/local-tokens.ts` for `"local"`, and `getDaemonBearer` for `"static"`).
 *
 * - `bearerKind === "local"` requires `localToken` (per-IDE scoped, revocable).
 * - `bearerKind === "static"` requires `staticBearer` (daemon's shared static
 *   token — accepted on loopback by the daemon's source-aware `verifyAccessToken`).
 * - `bearerKind === "none"` is the OAuth variant (no headers written).
 */
export interface TransportBuildInput {
  launcherPath: string;
  daemonPort: number | null;
  tunnelUrl: string | null;
  tunnelProviderId: "cf-quick" | "ngrok" | "cf-named" | null;
  tunnelReservedDomain: boolean;
  bearerKind: "none" | "local" | "static";
  localToken?: string;
  staticBearer?: string;
  chromePath?: string;
  nodePath?: string;
}

export interface TransportBuilder {
  id: McpTransportId;
  supportedFormats: ReadonlyArray<TransportFormat>;
  /** Throws `UnsupportedTransportError` or `StabilityGateError` for structured rejections. */
  build(input: TransportBuildInput): McpServerEntry;
}

export class UnsupportedTransportError extends Error {
  readonly code = "UnsupportedTransportError" as const;
  constructor(public readonly ideDisplayName: string, public readonly transportId: McpTransportId, detail?: string) {
    super(`${ideDisplayName} does not support transport "${transportId}"${detail ? `: ${detail}` : ""}.`);
    this.name = "UnsupportedTransportError";
  }
}

export class StabilityGateError extends Error {
  readonly code = "StabilityGateError" as const;
  constructor(public readonly transportId: McpTransportId, public readonly reason: string) {
    super(`Transport "${transportId}" rejected by stability gate: ${reason}.`);
    this.name = "StabilityGateError";
  }
}

import { stdioInProcessBuilder } from "./stdio-in-process.js";
import { stdioDaemonProxyBuilder } from "./stdio-daemon-proxy.js";
import { httpLoopbackBuilder } from "./http-loopback.js";
import { httpTunnelBuilder } from "./http-tunnel.js";

const BUILDERS: Record<McpTransportId, TransportBuilder> = {
  "stdio-in-process": stdioInProcessBuilder,
  "stdio-daemon-proxy": stdioDaemonProxyBuilder,
  "http-loopback": httpLoopbackBuilder,
  "http-tunnel": httpTunnelBuilder,
};

export function getTransportBuilder(id: McpTransportId): TransportBuilder {
  const builder = BUILDERS[id];
  if (!builder) throw new Error(`No transport builder registered for "${id}".`);
  return builder;
}
