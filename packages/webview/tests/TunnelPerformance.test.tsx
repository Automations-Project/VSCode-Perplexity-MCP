// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { TunnelPerformanceSnapshot } from "@perplexity-user-mcp/shared";

import {
  TunnelPerformance,
  TunnelPerformanceView,
} from "../src/components/TunnelPerformance";
import { useDashboardStore } from "../src/store";

afterEach(() => {
  cleanup();
  // Reset the store slice we exercise so test ordering doesn't leak state.
  useDashboardStore.setState({ tunnelPerformance: null });
});

function baseSnapshot(overrides: Partial<TunnelPerformanceSnapshot> = {}): TunnelPerformanceSnapshot {
  return {
    currentProvider: "cf-quick",
    enableHistory: [],
    healthLatencyAvgMs: null,
    healthLatencySamples: 0,
    mcpStatusBySource: {
      loopback: { ok: 0, unauthorized: 0, serverError: 0, other: 0 },
      tunnel: { ok: 0, unauthorized: 0, serverError: 0, other: 0 },
    },
    mcpTotal: 0,
    lastAuditTs: null,
    ...overrides,
  };
}

describe("TunnelPerformance (store wrapper)", () => {
  it("renders nothing when the store slice is null", () => {
    const { container } = render(<TunnelPerformance />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the card when the store slice is populated", () => {
    useDashboardStore.setState({ tunnelPerformance: baseSnapshot() });
    render(<TunnelPerformance />);
    expect(screen.getByTestId("tunnel-performance-card")).not.toBeNull();
  });
});

describe("TunnelPerformanceView", () => {
  it("shows the empty-state message when no enables are recorded", () => {
    render(<TunnelPerformanceView snapshot={baseSnapshot()} />);
    expect(screen.getByTestId("tunnel-performance-enables-empty").textContent).toMatch(
      /No enables recorded/i,
    );
  });

  it("renders enable rows when history is non-empty", () => {
    render(
      <TunnelPerformanceView
        snapshot={baseSnapshot({
          enableHistory: [
            { provider: "cf-quick", startedAt: new Date().toISOString(), durationMs: 5500, ok: true },
            { provider: "ngrok", startedAt: new Date().toISOString(), durationMs: 2000, ok: true },
            { provider: "cf-named", startedAt: new Date().toISOString(), durationMs: 1500, ok: true },
          ],
        })}
      />,
    );
    const rows = screen.getAllByTestId("tunnel-performance-enable-row");
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain("cf-quick");
    expect(rows[0].textContent).toContain("5.5 s");
    expect(rows[2].textContent).toContain("cf-named");
    expect(rows[2].textContent).toContain("1.5 s");
  });

  it("shows an em-dash for health latency when no samples exist", () => {
    render(<TunnelPerformanceView snapshot={baseSnapshot()} />);
    expect(screen.getByTestId("tunnel-performance-health-avg").textContent).toBe("—");
  });

  it("renders the health latency average when samples exist", () => {
    render(
      <TunnelPerformanceView
        snapshot={baseSnapshot({ healthLatencyAvgMs: 1.2, healthLatencySamples: 10 })}
      />,
    );
    expect(screen.getByTestId("tunnel-performance-health-avg").textContent).toContain("1.2 ms");
  });

  it("renders loopback + tunnel /mcp rows with per-bucket counts", () => {
    render(
      <TunnelPerformanceView
        snapshot={baseSnapshot({
          mcpTotal: 27,
          mcpStatusBySource: {
            loopback: { ok: 23, unauthorized: 0, serverError: 0, other: 0 },
            tunnel: { ok: 4, unauthorized: 0, serverError: 0, other: 0 },
          },
        })}
      />,
    );
    const loopback = screen.getByTestId("tunnel-performance-mcp-row-loopback");
    const tunnel = screen.getByTestId("tunnel-performance-mcp-row-tunnel");
    expect(loopback.textContent).toContain("23 ok");
    expect(tunnel.textContent).toContain("4 ok");
  });

  it("shows the unauth hint when tunnel 401 ratio exceeds the threshold", () => {
    render(
      <TunnelPerformanceView
        snapshot={baseSnapshot({
          mcpTotal: 5,
          mcpStatusBySource: {
            loopback: { ok: 0, unauthorized: 0, serverError: 0, other: 0 },
            tunnel: { ok: 4, unauthorized: 1, serverError: 0, other: 0 },
          },
        })}
      />,
    );
    const hint = screen.getByTestId("tunnel-performance-unauth-hint");
    expect(hint.textContent).toContain("High unauth rate");
    expect(hint.textContent).toContain("20%");
    expect(hint.textContent).toContain("Cloudflare WAF");
  });

  it("hides the unauth hint when tunnel 401 ratio is at or below the threshold", () => {
    render(
      <TunnelPerformanceView
        snapshot={baseSnapshot({
          mcpTotal: 10,
          mcpStatusBySource: {
            loopback: { ok: 0, unauthorized: 0, serverError: 0, other: 0 },
            tunnel: { ok: 9, unauthorized: 1, serverError: 0, other: 0 },
          },
        })}
      />,
    );
    expect(screen.queryByTestId("tunnel-performance-unauth-hint")).toBeNull();
  });

  it("hides the unauth hint when there are zero tunnel /mcp hits", () => {
    render(<TunnelPerformanceView snapshot={baseSnapshot()} />);
    expect(screen.queryByTestId("tunnel-performance-unauth-hint")).toBeNull();
  });

  it("shows em-dash status strings when a bucket row has zero traffic", () => {
    render(<TunnelPerformanceView snapshot={baseSnapshot()} />);
    const loopback = screen.getByTestId("tunnel-performance-mcp-row-loopback");
    const tunnel = screen.getByTestId("tunnel-performance-mcp-row-tunnel");
    expect(loopback.textContent).toContain("—");
    expect(tunnel.textContent).toContain("—");
  });
});
