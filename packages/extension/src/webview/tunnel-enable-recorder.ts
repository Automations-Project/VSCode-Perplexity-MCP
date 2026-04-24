import type { TunnelEnableRecord, TunnelProviderIdShared } from "@perplexity-user-mcp/shared";

export interface EnableRecordInput {
  provider: TunnelProviderIdShared;
  /** ISO timestamp captured when the user clicked Enable. */
  startedAt: string;
  /** Wall-clock ms between click and the tunnel.status flip (or failure). */
  durationMs: number;
  /** false if the enable timed out, errored, or was cancelled. */
  ok: boolean;
}

/**
 * Session-local ring buffer for tunnel enable timings. Extension-host scoped;
 * resets on window reload. Kept in-memory only — sensitive data is not
 * involved (just provider ids + wall-clock ms). Newest-first ordering on
 * {@link snapshot} matches what the webview expects.
 */
export class TunnelEnableRecorder {
  private readonly capacity: number;
  // Internal storage is newest-first; record() unshifts + trims. This makes
  // snapshot() O(1) for the common "slice small N" render path.
  private buffer: TunnelEnableRecord[] = [];

  constructor(capacity = 20) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  record(entry: EnableRecordInput): void {
    const next: TunnelEnableRecord = {
      provider: entry.provider,
      startedAt: entry.startedAt,
      // Guard against negative drift (clock skew / test fixtures passing junk).
      durationMs: Math.max(0, Math.floor(entry.durationMs)),
      ok: !!entry.ok,
    };
    this.buffer.unshift(next);
    if (this.buffer.length > this.capacity) {
      this.buffer.length = this.capacity;
    }
  }

  snapshot(): readonly TunnelEnableRecord[] {
    return this.buffer.slice();
  }

  clear(): void {
    this.buffer.length = 0;
  }

  /** Exposed for tests — do not rely on this from production paths. */
  get size(): number {
    return this.buffer.length;
  }
}
