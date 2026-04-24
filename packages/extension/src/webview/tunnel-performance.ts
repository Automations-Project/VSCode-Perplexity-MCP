import type {
  DaemonAuditEntry,
  TunnelPerformanceMcpBucket,
  TunnelPerformanceSnapshot,
  TunnelProviderIdShared,
} from "@perplexity-user-mcp/shared";

export interface ParseTunnelPerformanceOptions {
  /** Reserved for forward compatibility — enable history is stitched in by the caller. */
  enableHistoryLimit?: number;
  /** Window size for the rolling health-latency average. Default 10. */
  healthLatencyWindowSize?: number;
}

const DEFAULT_HEALTH_WINDOW = 10;

const EMPTY_BUCKET = (): TunnelPerformanceMcpBucket => ({
  ok: 0,
  unauthorized: 0,
  serverError: 0,
  other: 0,
});

/**
 * Pure parser: derives a {@link TunnelPerformanceSnapshot} from the daemon
 * audit tail. `enableHistory` is left empty; the caller (DashboardProvider)
 * merges in the session-local ring buffer since audit entries do not record
 * tunnel enable/disable events as their own rows.
 *
 * @param auditTail Recent audit entries. Order is NOT required — we sort by
 *                  timestamp internally where it matters (health latency).
 * @param currentProvider The currently-selected tunnel provider, or null when
 *                        unknown.
 */
export function parseTunnelPerformance(
  auditTail: readonly DaemonAuditEntry[],
  currentProvider: TunnelProviderIdShared | null,
  options: ParseTunnelPerformanceOptions = {},
): TunnelPerformanceSnapshot {
  const healthWindow = options.healthLatencyWindowSize ?? DEFAULT_HEALTH_WINDOW;

  const mcpStatusBySource: Record<"loopback" | "tunnel", TunnelPerformanceMcpBucket> = {
    loopback: EMPTY_BUCKET(),
    tunnel: EMPTY_BUCKET(),
  };
  let mcpTotal = 0;
  let lastAuditTs: string | null = null;

  // Health latency: collect all loopback GET /daemon/health durations, then
  // sort newest-first and take the top N. Ignoring tunnel health hits because
  // loopback is the only channel that reliably represents the daemon's own
  // responsiveness — tunnel latency would conflate network RTT.
  const healthSamples: Array<{ ts: string; durationMs: number }> = [];

  for (const entry of auditTail) {
    if (typeof entry.timestamp === "string") {
      if (lastAuditTs === null || entry.timestamp > lastAuditTs) {
        lastAuditTs = entry.timestamp;
      }
    }

    const tool = entry.tool ?? "";

    // /daemon/health latency — loopback only.
    if (entry.source === "loopback" && tool.startsWith("http:GET") && tool.includes("/daemon/health")) {
      if (typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)) {
        healthSamples.push({ ts: entry.timestamp, durationMs: entry.durationMs });
      }
      continue;
    }

    // /mcp status bucketing — group by audit source.
    // Some audit lines encode the method: "http:POST /mcp", others record a
    // tool name like "http:POST" with `path` set. Match either shape.
    const isMcpHttp =
      (tool.startsWith("http:") && tool.includes("/mcp")) ||
      (tool.startsWith("http:") && (entry as DaemonAuditEntry & { path?: string }).path === "/mcp");
    if (!isMcpHttp) {
      continue;
    }

    // Extract HTTP status when available. The daemon audit writes `httpStatus`
    // on the underlying entry; DaemonAuditEntry (the webview-safe type) does
    // NOT include that field, so we read it defensively.
    const httpStatus = (entry as DaemonAuditEntry & { httpStatus?: number }).httpStatus;
    const bucket = mcpStatusBySource[entry.source === "tunnel" ? "tunnel" : "loopback"];
    mcpTotal += 1;
    classifyMcpHit(bucket, httpStatus, entry.ok);
  }

  // Sort newest-first and average the last N.
  healthSamples.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const windowed = healthSamples.slice(0, Math.max(1, healthWindow));
  const healthLatencySamples = windowed.length;
  const healthLatencyAvgMs =
    healthLatencySamples === 0
      ? null
      : roundTo1(windowed.reduce((acc, s) => acc + s.durationMs, 0) / healthLatencySamples);

  return {
    currentProvider,
    enableHistory: [],
    healthLatencyAvgMs,
    healthLatencySamples,
    mcpStatusBySource,
    mcpTotal,
    lastAuditTs,
  };
}

function classifyMcpHit(
  bucket: TunnelPerformanceMcpBucket,
  httpStatus: number | undefined,
  ok: boolean,
): void {
  if (typeof httpStatus === "number") {
    if (httpStatus >= 200 && httpStatus < 300) {
      bucket.ok += 1;
      return;
    }
    if (httpStatus === 401) {
      bucket.unauthorized += 1;
      return;
    }
    if (httpStatus >= 500 && httpStatus < 600) {
      bucket.serverError += 1;
      return;
    }
    bucket.other += 1;
    return;
  }
  // No httpStatus — fall back to the `ok` boolean. We cannot distinguish 401
  // from 4xx here, so everything ok=false lands in `other`.
  if (ok) {
    bucket.ok += 1;
  } else {
    bucket.other += 1;
  }
}

function roundTo1(value: number): number {
  return Math.round(value * 10) / 10;
}
