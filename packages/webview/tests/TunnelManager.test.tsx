// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { DaemonStatusState, DashboardState } from "@perplexity-user-mcp/shared";
import { TunnelManager } from "../src/components/TunnelManager.tsx";
import { useDashboardStore } from "../src/store";

afterEach(() => {
  cleanup();
});

function makeDashboardState(enableTunnels: boolean): DashboardState {
  return {
    snapshot: {
      tier: "Anonymous",
      loggedIn: false,
      canUseComputer: false,
      modelsConfig: null,
      modelsConfigSource: "empty",
      rateLimits: null,
      configDir: "",
      browserProfileDir: "",
      lastUpdated: null,
      lastRefreshTier: null,
      speedBoost: {
        installed: false,
        installedAt: null,
        runtimeDir: "",
        version: null,
      },
    } as unknown as DashboardState["snapshot"],
    history: [],
    historyTotalCount: 0,
    ideStatus: {},
    rulesStatus: [],
    settings: {
      defaultSearchModel: "pplx_pro",
      reasonModel: "claude46sonnetthinking",
      researchModel: "pplx_alpha",
      computeModel: "pplx_asi",
      chromePath: "",
      debugMode: false,
      autoConfigureCursor: false,
      autoConfigureWindsurf: false,
      autoConfigureWindsurfNext: false,
      autoConfigureClaudeDesktop: false,
      autoConfigureClaudeCode: false,
      autoConfigureCline: false,
      autoConfigureAmp: false,
      autoConfigureCodexCli: false,
      autoRefreshIntervalHours: 0,
      debugVerboseHttp: false,
      oauthConsentCacheTtlHours: 24,
      mcpTransportByIde: {},
      daemonPort: 0,
      syncFolderPatterns: [],
      autoRegenerateStaleConfigs: true,
      enableTunnels,
    },
  };
}

const daemonStatus: DaemonStatusState = {
  running: true,
  healthy: true,
  stale: false,
  configDir: "/tmp/config",
  lockPath: "/tmp/config/daemon.lock",
  tokenPath: "/tmp/config/daemon.token",
  pid: 1,
  uuid: "u",
  port: 41731,
  url: "http://127.0.0.1:41731",
  version: "0.8.5",
  startedAt: "2026-04-21T11:30:00.000Z",
  uptimeMs: 60_000,
  heartbeatCount: 1,
  tunnel: {
    status: "disabled",
    url: null,
    pid: null,
    error: null,
  },
  bearerAvailable: true,
};

describe("TunnelManager wrapper decision", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      tunnelProviders: null,
      tunnelProbe: null,
    });
  });

  it("renders RemoteAccessOptIn when settings.enableTunnels is false", () => {
    useDashboardStore.setState({ state: makeDashboardState(false) });
    render(
      <TunnelManager
        status={daemonStatus}
        enableTunnels={false}
        send={vi.fn()}
      />,
    );
    expect(screen.getByTestId("remote-access-optin")).toBeDefined();
    expect(screen.queryByTestId("remote-access-optin-disable")).toBeNull();
  });

  it("clicking the opt-in enable button dispatches settings:update { enableTunnels: true }", () => {
    useDashboardStore.setState({ state: makeDashboardState(false) });
    const send = vi.fn();
    render(
      <TunnelManager status={daemonStatus} enableTunnels={false} send={send} />,
    );
    fireEvent.click(screen.getByTestId("remote-access-optin-enable"));
    expect(send).toHaveBeenCalledWith({
      type: "settings:update",
      payload: { enableTunnels: true },
    });
  });

  it("renders the full manager (and the Disable-tunnel-options link) when enableTunnels is true", () => {
    useDashboardStore.setState({ state: makeDashboardState(true) });
    render(
      <TunnelManager
        status={daemonStatus}
        enableTunnels={true}
        tunnelProviders={{
          activeProvider: "cf-quick",
          providers: [
            {
              id: "cf-quick",
              displayName: "Cloudflare Quick Tunnel",
              description: "cf",
              isActive: true,
              setup: { ready: true },
            },
            {
              id: "ngrok",
              displayName: "ngrok",
              description: "ng",
              isActive: false,
              setup: { ready: false, reason: "authtoken missing" },
            },
            {
              id: "cf-named",
              displayName: "Cloudflare Named Tunnel",
              description: "cfn",
              isActive: false,
              setup: { ready: false, reason: "not logged in" },
            },
          ],
          ngrok: { configured: false },
        }}
        send={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("remote-access-optin")).toBeNull();
    expect(screen.getByTestId("remote-access-optin-disable")).toBeDefined();
  });

  it("clicking 'Disable tunnel options' dispatches settings:update { enableTunnels: false }", () => {
    useDashboardStore.setState({ state: makeDashboardState(true) });
    const send = vi.fn();
    render(
      <TunnelManager
        status={daemonStatus}
        enableTunnels={true}
        tunnelProviders={{
          activeProvider: "cf-quick",
          providers: [
            {
              id: "cf-quick",
              displayName: "Cloudflare Quick Tunnel",
              description: "cf",
              isActive: true,
              setup: { ready: true },
            },
            {
              id: "ngrok",
              displayName: "ngrok",
              description: "ng",
              isActive: false,
              setup: { ready: false, reason: "authtoken missing" },
            },
            {
              id: "cf-named",
              displayName: "Cloudflare Named Tunnel",
              description: "cfn",
              isActive: false,
              setup: { ready: false, reason: "not logged in" },
            },
          ],
          ngrok: { configured: false },
        }}
        send={send}
      />,
    );
    fireEvent.click(screen.getByTestId("remote-access-optin-disable"));
    expect(send).toHaveBeenCalledWith({
      type: "settings:update",
      payload: { enableTunnels: false },
    });
  });
});
