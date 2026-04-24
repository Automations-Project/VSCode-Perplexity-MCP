import { existsSync, readFileSync } from "node:fs";
import {
  IDE_METADATA,
  PERPLEXITY_MCP_SERVER_KEY,
  type IdeStatus,
} from "@perplexity-user-mcp/shared";
import { getIdeConfigPath } from "../auto-config/index.js";

/**
 * Phase 8.4 / v0.8.4 - Staleness detector.
 *
 * Walks each IDE that is currently marked `configured: true` in the dashboard
 * `ideStatus` snapshot, reads its MCP config off disk, and compares the
 * embedded URL / bearer against the live daemon state. Emits one stale entry
 * per IDE whose embedded values no longer match the live daemon.
 *
 * Read/parse errors for an individual IDE are SILENTLY SKIPPED - staleness
 * detection is a UX hint, not a hard signal, so a corrupt unrelated config
 * file must not poison the rest of the map. Callers can optionally log
 * skipped targets through the `onSkip` hook for trace-level observability.
 */

export interface StalenessCheckInput {
  /** Full `ideStatus` map from `buildState()` - keys are IDE tags. */
  ideStatus: Record<string, IdeStatus>;
  /** Live daemon port (OS-assigned or pinned). `null` = daemon not running. */
  daemonPort: number | null;
  /** Live tunnel URL if a tunnel is enabled. `null` otherwise. */
  tunnelUrl: string | null;
  /** Live static daemon bearer. `null` = daemon not running. */
  daemonBearer: string | null;
  /** Optional trace hook for skipped IDEs (malformed JSON, unreadable file). */
  onSkip?: (ideTag: string, reason: string) => void;
}

export interface StaleConfigEntry {
  ideTag: string;
  reason: "bearer" | "url";
}

interface ParsedServerEntry {
  url?: unknown;
  headers?: { Authorization?: unknown };
}

/**
 * Extract the Perplexity MCP server entry from a JSON config file. Returns
 * `null` if the file does not contain a Perplexity entry at all - callers
 * MUST treat that as "nothing to check" (not a stale signal).
 */
function readJsonEntry(configPath: string): ParsedServerEntry | null {
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as {
    mcpServers?: Record<string, unknown>;
  };
  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return null;
  }
  const entry = servers[PERPLEXITY_MCP_SERVER_KEY];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  return entry as ParsedServerEntry;
}

/**
 * Parse an embedded loopback URL of the form `http://127.0.0.1:<port>/mcp`.
 * Returns the port as a number if the URL matches exactly; otherwise `null`.
 */
function parseLoopbackPort(url: string): number | null {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})(?:\/.*)?$/.exec(url);
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return port;
}

/**
 * Extract a `Bearer <token>` value from an Authorization header. Returns
 * `null` for non-Bearer / malformed values (we don't flag those as stale;
 * they're likely a different transport or manual edit).
 */
function extractBearer(authorization: unknown): string | null {
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(.+)$/.exec(authorization.trim());
  return match ? match[1] : null;
}

export function detectStaleConfigs(input: StalenessCheckInput): StaleConfigEntry[] {
  const stale: StaleConfigEntry[] = [];

  for (const [ideTag, status] of Object.entries(input.ideStatus)) {
    if (!status.configured) continue;

    const meta = IDE_METADATA[ideTag];
    if (!meta || meta.configFormat !== "json") continue;

    const configPath = status.path || getIdeConfigPath(ideTag as never);
    if (!existsSync(configPath)) continue;

    let entry: ParsedServerEntry | null;
    try {
      entry = readJsonEntry(configPath);
    } catch (err) {
      input.onSkip?.(ideTag, err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!entry) continue;

    const rawUrl = typeof entry.url === "string" ? entry.url : null;
    if (!rawUrl) {
      continue;
    }

    if (rawUrl.startsWith("https://")) {
      const normalize = (u: string): string => u.replace(/\/+$/, "").replace(/\/mcp$/, "");
      const liveTunnel = input.tunnelUrl ? normalize(input.tunnelUrl) : null;
      const embedded = normalize(rawUrl);
      if (!liveTunnel || embedded !== liveTunnel) {
        stale.push({ ideTag, reason: "url" });
        continue;
      }
    } else {
      const embeddedPort = parseLoopbackPort(rawUrl);
      if (embeddedPort === null) {
        continue;
      }
      if (input.daemonPort === null || embeddedPort !== input.daemonPort) {
        stale.push({ ideTag, reason: "url" });
        continue;
      }
    }

    const embeddedBearer = extractBearer(entry.headers?.Authorization);
    if (embeddedBearer && input.daemonBearer && embeddedBearer !== input.daemonBearer) {
      stale.push({ ideTag, reason: "bearer" });
    }
  }

  return stale;
}
