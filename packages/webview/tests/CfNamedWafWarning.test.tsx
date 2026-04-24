// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DaemonStatusState } from "@perplexity-user-mcp/shared";
import { DaemonStatusView } from "../src/components/DaemonStatus";
import type { TunnelProvidersState } from "../src/components/TunnelManager";

afterEach(() => {
  cleanup();
});

const TUNNEL_URL = "https://mcp.example.com";
const WAF_DOCS_HREF = "https://developers.cloudflare.com/waf/custom-rules/skip/";

function baseStatus(overrides: Partial<DaemonStatusState> = {}): DaemonStatusState {
  return {
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
    version: "0.8.4",
    startedAt: "2026-04-24T11:30:00.000Z",
    uptimeMs: 1_800_000,
    heartbeatCount: 3,
    tunnel: { status: "disabled", url: null, pid: null, error: null },
    bearerAvailable: true,
    ...overrides,
  };
}

function cfNamedProviders(): TunnelProvidersState {
  return {
    activeProvider: "cf-named",
    providers: [
      {
        id: "cf-named",
        displayName: "Cloudflare Named Tunnel",
        description: "Persistent URL on your own zone.",
        isActive: true,
        setup: { ready: true },
      },
    ],
    ngrok: { configured: false },
  };
}

function ngrokProviders(): TunnelProvidersState {
  return {
    activeProvider: "ngrok",
    providers: [
      {
        id: "ngrok",
        displayName: "ngrok",
        description: "ngrok tunnel.",
        isActive: true,
        setup: { ready: true },
      },
    ],
    ngrok: { configured: true },
  };
}

function cfQuickProviders(): TunnelProvidersState {
  return {
    activeProvider: "cf-quick",
    providers: [
      {
        id: "cf-quick",
        displayName: "Cloudflare Quick Tunnel",
        description: "Ephemeral URL.",
        isActive: true,
        setup: { ready: true },
      },
    ],
    ngrok: { configured: false },
  };
}

describe("cf-named WAF warning banner", () => {
  it("renders the banner when provider is cf-named AND tunnel is enabled with a URL", () => {
    render(
      <DaemonStatusView
        status={baseStatus({
          tunnel: { status: "enabled", url: TUNNEL_URL, pid: 5151, error: null },
        })}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders()}
        send={vi.fn()}
      />,
    );
    const banner = screen.getByTestId("cf-named-waf-warning");
    expect(banner).not.toBeNull();
  });

  it("does NOT render the banner when provider is cf-named but tunnel is disabled", () => {
    render(
      <DaemonStatusView
        status={baseStatus({
          tunnel: { status: "disabled", url: null, pid: null, error: null },
        })}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders()}
        send={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("cf-named-waf-warning")).toBeNull();
  });

  it("does NOT render the banner when provider is ngrok (even with enabled status)", () => {
    render(
      <DaemonStatusView
        status={baseStatus({
          tunnel: { status: "enabled", url: "https://abc.ngrok.app", pid: 5151, error: null },
        })}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={ngrokProviders()}
        send={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("cf-named-waf-warning")).toBeNull();
  });

  it("does NOT render the banner when provider is cf-quick (even with enabled status)", () => {
    render(
      <DaemonStatusView
        status={baseStatus({
          tunnel: { status: "enabled", url: "https://abc.trycloudflare.com", pid: 5151, error: null },
        })}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfQuickProviders()}
        send={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("cf-named-waf-warning")).toBeNull();
  });

  it("banner includes the WAF docs link with the correct href, target, and rel", () => {
    render(
      <DaemonStatusView
        status={baseStatus({
          tunnel: { status: "enabled", url: TUNNEL_URL, pid: 5151, error: null },
        })}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders()}
        send={vi.fn()}
      />,
    );
    const banner = screen.getByTestId("cf-named-waf-warning");
    const link = banner.querySelector("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(WAF_DOCS_HREF);
    expect(link!.getAttribute("target")).toBe("_blank");
    // External links must be rel=noopener noreferrer to prevent tab-napping
    expect(link!.getAttribute("rel")).toContain("noopener");
    expect(link!.getAttribute("rel")).toContain("noreferrer");
  });

  it("banner interpolates the tunnel URL into its text", () => {
    render(
      <DaemonStatusView
        status={baseStatus({
          tunnel: { status: "enabled", url: TUNNEL_URL, pid: 5151, error: null },
        })}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders()}
        send={vi.fn()}
      />,
    );
    const banner = screen.getByTestId("cf-named-waf-warning");
    expect(banner.textContent).toContain(TUNNEL_URL);
    // Per-spec copy markers
    expect(banner.textContent).toContain("Cloudflare challenge");
    expect(banner.textContent).toContain("/mcp");
  });

  it("does NOT render the banner when provider is cf-named and tunnel is 'starting' (URL not yet live)", () => {
    render(
      <DaemonStatusView
        status={baseStatus({
          tunnel: { status: "starting", url: null, pid: null, error: null },
        })}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders()}
        send={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("cf-named-waf-warning")).toBeNull();
  });
});
