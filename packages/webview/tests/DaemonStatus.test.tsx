import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatusState, ExtensionMessage } from "@perplexity-user-mcp/shared";
import { DaemonStatusView } from "../src/components/DaemonStatus";
import { useDashboardStore } from "../src/store";

const daemonStatus: DaemonStatusState = {
  running: true,
  healthy: true,
  stale: false,
  configDir: "C:/Users/admin/.perplexity-mcp",
  lockPath: "C:/Users/admin/.perplexity-mcp/daemon.lock",
  tokenPath: "C:/Users/admin/.perplexity-mcp/daemon.token",
  pid: 4242,
  uuid: "daemon-uuid",
  port: 41731,
  url: "http://127.0.0.1:41731",
  version: "0.6.0",
  startedAt: "2026-04-21T11:30:00.000Z",
  uptimeMs: 1_800_000,
  heartbeatCount: 3,
  tunnel: {
    status: "enabled",
    url: "https://phase-five.trycloudflare.com",
    pid: 5151,
    error: null,
  },
  bearerToken: "test-bearer-token-1234",
};

describe("DaemonStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    useDashboardStore.setState({
      daemonStatus,
      daemonAuditTail: [
        {
          timestamp: "2026-04-21T11:59:00.000Z",
          clientId: "vscode-dashboard",
          tool: "perplexity_search",
          durationMs: 128,
          source: "loopback",
          ok: true,
        },
      ],
      daemonTokenRotatedAt: null,
      notice: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders daemon health, masked tunnel URL, controls, and audit tail", () => {
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={daemonStatus}
        auditTail={useDashboardStore.getState().daemonAuditTail}
        tokenRotatedAt={null}
        send={vi.fn()}
      />,
    );

    expect({
      health: markup.includes("Healthy"),
      pid: markup.includes("4242"),
      port: markup.includes("41731"),
      uptime: markup.includes("30m"),
      tunnelMasked: markup.includes("https://******.trycloudflare.com"),
      auditTool: markup.includes("perplexity_search"),
      rotateControl: markup.includes("Rotate token"),
    }).toMatchInlineSnapshot(`
      {
        "auditTool": true,
        "health": true,
        "pid": true,
        "port": true,
        "rotateControl": true,
        "tunnelMasked": true,
        "uptime": true,
      }
    `);
  });

  it("hydrates tunnel and token-rotation messages from the extension host", () => {
    const hydrate = useDashboardStore.getState().hydrate;
    const crashedTunnel: ExtensionMessage = {
      type: "daemon:tunnel-url",
      payload: {
        status: "crashed",
        url: null,
        pid: null,
        error: "cloudflared exited",
      },
    };

    hydrate(crashedTunnel);
    expect(useDashboardStore.getState().daemonStatus?.tunnel.status).toBe("crashed");
    expect(useDashboardStore.getState().notice?.message).toContain("cloudflared exited");

    hydrate({
      type: "daemon:token-rotated",
      payload: { rotatedAt: "2026-04-21T12:00:00.000Z" },
    });
    expect(useDashboardStore.getState().daemonTokenRotatedAt).toBe("2026-04-21T12:00:00.000Z");
    expect(useDashboardStore.getState().notice?.level).toBe("info");
  });
});
