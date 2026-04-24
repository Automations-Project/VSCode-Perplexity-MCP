import { describe, expect, it } from "vitest";
import type { DaemonAuditEntry } from "@perplexity-user-mcp/shared";

import { parseTunnelPerformance } from "../src/webview/tunnel-performance.js";

type AuditEntryWithExtras = DaemonAuditEntry & { httpStatus?: number; path?: string };

function hit(overrides: Partial<AuditEntryWithExtras>): AuditEntryWithExtras {
  return {
    timestamp: "2026-04-24T10:00:00.000Z",
    clientId: "client",
    tool: "http:GET /daemon/health",
    durationMs: 1,
    source: "loopback",
    ok: true,
    ...overrides,
  };
}

describe("parseTunnelPerformance", () => {
  it("returns empty snapshot for an empty audit window", () => {
    const snap = parseTunnelPerformance([], "cf-quick");
    expect(snap.currentProvider).toBe("cf-quick");
    expect(snap.enableHistory).toEqual([]);
    expect(snap.healthLatencyAvgMs).toBeNull();
    expect(snap.healthLatencySamples).toBe(0);
    expect(snap.mcpTotal).toBe(0);
    expect(snap.mcpStatusBySource.loopback).toEqual({
      ok: 0,
      unauthorized: 0,
      serverError: 0,
      other: 0,
    });
    expect(snap.mcpStatusBySource.tunnel).toEqual({
      ok: 0,
      unauthorized: 0,
      serverError: 0,
      other: 0,
    });
    expect(snap.lastAuditTs).toBeNull();
  });

  it("averages the last N loopback /daemon/health durations", () => {
    const entries: AuditEntryWithExtras[] = [
      hit({ timestamp: "2026-04-24T10:00:01.000Z", durationMs: 2 }),
      hit({ timestamp: "2026-04-24T10:00:02.000Z", durationMs: 4 }),
      hit({ timestamp: "2026-04-24T10:00:03.000Z", durationMs: 6 }),
    ];
    const snap = parseTunnelPerformance(entries, "cf-quick");
    expect(snap.healthLatencySamples).toBe(3);
    expect(snap.healthLatencyAvgMs).toBe(4);
  });

  it("enforces healthLatencyWindowSize (newest-first)", () => {
    const entries: AuditEntryWithExtras[] = [
      hit({ timestamp: "2026-04-24T10:00:01.000Z", durationMs: 100 }),
      hit({ timestamp: "2026-04-24T10:00:02.000Z", durationMs: 100 }),
      hit({ timestamp: "2026-04-24T10:00:03.000Z", durationMs: 1 }),
      hit({ timestamp: "2026-04-24T10:00:04.000Z", durationMs: 1 }),
    ];
    const snap = parseTunnelPerformance(entries, "cf-quick", { healthLatencyWindowSize: 2 });
    expect(snap.healthLatencySamples).toBe(2);
    // Newest two are 1 and 1.
    expect(snap.healthLatencyAvgMs).toBe(1);
  });

  it("ignores tunnel-source health hits when computing the loopback average", () => {
    const entries: AuditEntryWithExtras[] = [
      hit({ timestamp: "2026-04-24T10:00:01.000Z", durationMs: 2, source: "loopback" }),
      hit({ timestamp: "2026-04-24T10:00:02.000Z", durationMs: 500, source: "tunnel" }),
    ];
    const snap = parseTunnelPerformance(entries, "cf-quick");
    expect(snap.healthLatencySamples).toBe(1);
    expect(snap.healthLatencyAvgMs).toBe(2);
  });

  it("classifies /mcp hits by httpStatus into ok/unauthorized/serverError/other", () => {
    const entries: AuditEntryWithExtras[] = [
      hit({ tool: "http:POST /mcp", httpStatus: 200, source: "tunnel" }),
      hit({ tool: "http:POST /mcp", httpStatus: 200, source: "tunnel" }),
      hit({ tool: "http:POST /mcp", httpStatus: 401, source: "tunnel", ok: false }),
      hit({ tool: "http:POST /mcp", httpStatus: 500, source: "tunnel", ok: false }),
      hit({ tool: "http:POST /mcp", httpStatus: 404, source: "tunnel", ok: false }),
      hit({ tool: "http:POST /mcp", httpStatus: 200, source: "loopback" }),
    ];
    const snap = parseTunnelPerformance(entries, "cf-quick");
    expect(snap.mcpTotal).toBe(6);
    expect(snap.mcpStatusBySource.tunnel).toEqual({
      ok: 2,
      unauthorized: 1,
      serverError: 1,
      other: 1,
    });
    expect(snap.mcpStatusBySource.loopback).toEqual({
      ok: 1,
      unauthorized: 0,
      serverError: 0,
      other: 0,
    });
  });

  it("matches /mcp rows that encode the path separately", () => {
    const entries: AuditEntryWithExtras[] = [
      hit({ tool: "http:POST", path: "/mcp", httpStatus: 200, source: "tunnel" }),
      hit({ tool: "http:POST", path: "/mcp", httpStatus: 401, source: "tunnel", ok: false }),
    ];
    const snap = parseTunnelPerformance(entries, "cf-quick");
    expect(snap.mcpTotal).toBe(2);
    expect(snap.mcpStatusBySource.tunnel.ok).toBe(1);
    expect(snap.mcpStatusBySource.tunnel.unauthorized).toBe(1);
  });

  it("falls back to ok flag when httpStatus is missing", () => {
    const entries: AuditEntryWithExtras[] = [
      hit({ tool: "http:POST /mcp", source: "tunnel", ok: true }),
      hit({ tool: "http:POST /mcp", source: "tunnel", ok: false }),
    ];
    const snap = parseTunnelPerformance(entries, "cf-quick");
    // No httpStatus -> ok=true lands in ok bucket, ok=false lands in other
    expect(snap.mcpStatusBySource.tunnel.ok).toBe(1);
    expect(snap.mcpStatusBySource.tunnel.other).toBe(1);
    expect(snap.mcpStatusBySource.tunnel.unauthorized).toBe(0);
  });

  it("does not count /daemon/health as /mcp", () => {
    const entries: AuditEntryWithExtras[] = [
      hit({ tool: "http:GET /daemon/health", durationMs: 3 }),
    ];
    const snap = parseTunnelPerformance(entries, "cf-quick");
    expect(snap.mcpTotal).toBe(0);
    // But it IS a health sample.
    expect(snap.healthLatencySamples).toBe(1);
  });

  it("surfaces the newest timestamp as lastAuditTs", () => {
    const entries: AuditEntryWithExtras[] = [
      hit({ timestamp: "2026-04-24T09:00:00.000Z" }),
      hit({ timestamp: "2026-04-24T10:00:00.000Z" }),
      hit({ timestamp: "2026-04-24T08:00:00.000Z" }),
    ];
    const snap = parseTunnelPerformance(entries, "cf-quick");
    expect(snap.lastAuditTs).toBe("2026-04-24T10:00:00.000Z");
  });

  it("enableHistory is always empty from the parser (caller merges the recorder)", () => {
    // The parser deliberately does NOT infer enable events from the audit log;
    // callers supply them from the TunnelEnableRecorder ring buffer instead.
    const snap = parseTunnelPerformance(
      [
        hit({ timestamp: "2026-04-24T10:00:01.000Z", durationMs: 2 }),
        hit({ tool: "http:POST /mcp", httpStatus: 200, source: "tunnel" }),
      ],
      "ngrok",
    );
    expect(snap.enableHistory).toEqual([]);
  });
});
