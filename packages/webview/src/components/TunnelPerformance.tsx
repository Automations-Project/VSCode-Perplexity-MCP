import { Activity } from "lucide-react";
import type {
  TunnelEnableRecord,
  TunnelPerformanceMcpBucket,
  TunnelPerformanceSnapshot,
} from "@perplexity-user-mcp/shared";
import { useDashboardStore } from "../store";

/**
 * v0.8.5 tunnel performance dashboard card.
 *
 * Surfaces three signals the 0.8.4 smoke run exposed as opaque:
 *   - recent tunnel-enable durations (cf-quick was ~5.5s vs cf-named ~1.5s)
 *   - rolling /daemon/health latency (loopback — pure daemon responsiveness)
 *   - /mcp status ratios bucketed by source (loopback vs tunnel); 401s on the
 *     tunnel channel are the tell for a missing Cloudflare WAF Skip rule.
 *
 * Renders nothing pre-hydrate (snapshot === null). Every sub-section renders
 * its own empty state rather than disappearing, so the card's shape stays
 * predictable across reloads.
 */
export function TunnelPerformance() {
  const snapshot = useDashboardStore((store) => store.tunnelPerformance);
  if (!snapshot) return null;
  return <TunnelPerformanceView snapshot={snapshot} />;
}

/** Threshold at which the tunnel 401 ratio triggers the CF-WAF hint. */
export const UNAUTH_WARNING_THRESHOLD = 0.1;

export function TunnelPerformanceView({ snapshot }: { snapshot: TunnelPerformanceSnapshot }) {
  const tunnelBucket = snapshot.mcpStatusBySource.tunnel;
  const loopbackBucket = snapshot.mcpStatusBySource.loopback;
  const tunnelTotal = bucketTotal(tunnelBucket);
  const unauthRatio = tunnelTotal === 0 ? 0 : tunnelBucket.unauthorized / tunnelTotal;
  const showUnauthHint = unauthRatio > UNAUTH_WARNING_THRESHOLD;

  return (
    <div
      className="daemon-inset-panel"
      style={{ marginTop: 8 }}
      data-testid="tunnel-performance-card"
    >
      <div className="flex items-center gap-1" style={{ fontSize: "0.72rem", fontWeight: 600 }}>
        <Activity size={12} aria-hidden="true" />
        <span className="text-[var(--text-primary)]">Tunnel performance</span>
      </div>

      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: "0.66rem", fontWeight: 600 }} className="text-[var(--text-muted)]">
          Last enables
        </div>
        {snapshot.enableHistory.length === 0 ? (
          <div
            style={{ fontSize: "0.66rem", marginTop: 2 }}
            className="text-[var(--text-muted)]"
            data-testid="tunnel-performance-enables-empty"
          >
            No enables recorded in this session.
          </div>
        ) : (
          <div className="flex flex-col gap-1" style={{ marginTop: 3 }}>
            {snapshot.enableHistory.slice(0, 5).map((record, idx) => (
              <EnableRow key={`${record.startedAt}-${idx}`} record={record} />
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: "0.66rem", fontWeight: 600 }} className="text-[var(--text-muted)]">
          Health check latency (last {Math.max(1, snapshot.healthLatencySamples)})
        </div>
        <div
          style={{ fontSize: "0.7rem", marginTop: 2 }}
          className="text-[var(--text-primary)]"
          data-testid="tunnel-performance-health-avg"
        >
          {snapshot.healthLatencySamples === 0 || snapshot.healthLatencyAvgMs === null
            ? "—"
            : `${snapshot.healthLatencyAvgMs} ms avg`}
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: "0.66rem", fontWeight: 600 }} className="text-[var(--text-muted)]">
          /mcp requests (audit window: {snapshot.mcpTotal})
        </div>
        <div className="flex flex-col gap-1" style={{ marginTop: 3 }}>
          <McpRow label="loopback" bucket={loopbackBucket} />
          <McpRow label="tunnel" bucket={tunnelBucket} />
        </div>
        {showUnauthHint ? (
          <div
            style={{ fontSize: "0.64rem", marginTop: 5 }}
            className="text-[#fca5a5]"
            data-testid="tunnel-performance-unauth-hint"
          >
            High unauth rate ({formatPercent(unauthRatio)}) &mdash; see tunnel setup
            (Cloudflare WAF Skip rule may be missing).
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EnableRow({ record }: { record: TunnelEnableRecord }) {
  return (
    <div
      className="list-row"
      style={{ padding: 4, fontSize: "0.66rem" }}
      data-testid="tunnel-performance-enable-row"
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <span className="text-[var(--text-primary)]">{record.provider}</span>
        <span className="text-[var(--text-muted)]" style={{ marginLeft: 6 }}>
          {formatDuration(record.durationMs)}
        </span>
        <span className="text-[var(--text-muted)]" style={{ marginLeft: 6 }}>
          {formatAgo(record.startedAt)}
        </span>
      </div>
      <span
        className={`chip ${record.ok ? "chip-pro" : "chip-danger"}`}
        style={{ padding: "1px 6px" }}
      >
        {record.ok ? "ok" : "failed"}
      </span>
    </div>
  );
}

function McpRow({ label, bucket }: { label: string; bucket: TunnelPerformanceMcpBucket }) {
  const total = bucketTotal(bucket);
  return (
    <div
      className="list-row"
      style={{ padding: 4, fontSize: "0.66rem" }}
      data-testid={`tunnel-performance-mcp-row-${label}`}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <span className="text-[var(--text-primary)]">{label}</span>
      </div>
      <div className="text-[var(--text-muted)]">
        {total === 0
          ? "—"
          : `${bucket.ok} ok / ${bucket.unauthorized} unauth / ${bucket.serverError} server / ${bucket.other} other`}
      </div>
    </div>
  );
}

function bucketTotal(bucket: TunnelPerformanceMcpBucket): number {
  return bucket.ok + bucket.unauthorized + bucket.serverError + bucket.other;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatAgo(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const deltaSec = Math.floor((Date.now() - ts) / 1000);
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
