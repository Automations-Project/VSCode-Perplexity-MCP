// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  DashboardState,
  ExtensionSettingsSnapshot,
  IdeStatus,
} from "@perplexity-user-mcp/shared";
import { SettingsView } from "../src/views";
import { useDashboardStore } from "../src/store";

// Phase 8.6.5: the IDEs tab renders a stale-config banner above the
// auto-configurable list when `staleConfigs` is non-empty. It also surfaces
// a per-IDE "Stale" chip inside each affected card. These tests pin that
// behaviour without coupling to the TransportPicker (which has its own
// dedicated test file).

const settings: ExtensionSettingsSnapshot = {
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
};

const cursorStatus: IdeStatus = {
  detected: true,
  configured: true,
  health: "configured",
  path: "C:/Users/admin/.cursor/mcp.json",
  displayName: "Cursor",
  autoConfigurable: true,
  configFormat: "json",
};

const baseState: DashboardState = {
  snapshot: {
    loggedIn: true,
    userId: "u-1",
    tier: "Pro",
    canUseComputer: false,
    modelsConfig: null,
    modelsConfigSource: { phase: "idle" },
    rateLimits: null,
    configDir: "C:/Users/admin/.perplexity-mcp",
    browserProfileDir: "C:/Users/admin/.perplexity-mcp/browser",
    lastUpdated: null,
    lastRefreshTier: null,
    speedBoost: { installed: false, path: null, version: null, inWorkspace: false },
  },
  history: [],
  ideStatus: { cursor: cursorStatus },
  rulesStatus: [],
  settings,
};

afterEach(() => {
  cleanup();
  useDashboardStore.setState({ staleConfigs: null });
});

describe("SettingsView — stale-config banner", () => {
  beforeEach(() => {
    useDashboardStore.setState({ staleConfigs: null });
  });

  it("renders the banner with singular 'config' wording when exactly 1 entry is stale", () => {
    useDashboardStore.setState({
      staleConfigs: [{ ideTag: "cursor", reason: "bearer" }],
    });
    render(<SettingsView state={baseState} send={vi.fn()} />);
    const banner = screen.getByTestId("stale-configs-banner");
    expect(banner).toBeDefined();
    expect(banner.textContent ?? "").toMatch(/1 config contain/i);
    // Per-IDE chip is visible inside the cursor card.
    expect(screen.getByTestId("ide-stale-chip-cursor")).toBeDefined();
  });

  it("renders pluralised wording when 2+ entries are stale", () => {
    useDashboardStore.setState({
      staleConfigs: [
        { ideTag: "cursor", reason: "bearer" },
        { ideTag: "claudeCode", reason: "url" },
      ],
    });
    render(<SettingsView state={baseState} send={vi.fn()} />);
    const banner = screen.getByTestId("stale-configs-banner");
    expect(banner.textContent ?? "").toMatch(/2 configs contain/i);
  });

  it("is absent when staleConfigs is null (pre-hydrate)", () => {
    useDashboardStore.setState({ staleConfigs: null });
    render(<SettingsView state={baseState} send={vi.fn()} />);
    expect(screen.queryByTestId("stale-configs-banner")).toBeNull();
    expect(screen.queryByTestId("ide-stale-chip-cursor")).toBeNull();
  });

  it("is absent when staleConfigs is an empty array (explicit zero-signal)", () => {
    useDashboardStore.setState({ staleConfigs: [] });
    render(<SettingsView state={baseState} send={vi.fn()} />);
    expect(screen.queryByTestId("stale-configs-banner")).toBeNull();
  });

  it("clicking 'Regenerate all' dispatches transport:regenerate-stale", () => {
    useDashboardStore.setState({
      staleConfigs: [{ ideTag: "cursor", reason: "bearer" }],
    });
    const send = vi.fn();
    render(<SettingsView state={baseState} send={send} />);
    fireEvent.click(screen.getByRole("button", { name: /regenerate all/i }));
    expect(send).toHaveBeenCalledWith({ type: "transport:regenerate-stale" });
  });
});
