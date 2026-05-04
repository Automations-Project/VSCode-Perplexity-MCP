// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  DashboardState,
  ExtensionSettingsSnapshot,
  IdeStatus,
  WebviewMessage,
} from "@perplexity-user-mcp/shared";
import { DashboardView } from "../src/views";
import { useDashboardStore, type AppTab } from "../src/store";

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
  autoRegenerateStaleConfigs: true,
  enableTunnels: false,
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
    canUseComputer: true,
    modelsConfig: {
      models: {},
      config: [
        {
          label: "Perplexity Search",
          description: "Search model",
          subheading: null,
          has_new_tag: false,
          subscription_tier: "Pro",
          non_reasoning_model: "pplx_pro",
          reasoning_model: null,
          text_only_model: false,
        },
      ],
      default_models: {},
    },
    modelsConfigSource: "cache",
    rateLimits: {
      modes: {
        search: {
          available: true,
          remaining_detail: { kind: "exact", remaining: 10 },
        },
      },
      sources: {},
    },
    configDir: "C:/Users/admin/.perplexity-mcp",
    browserProfileDir: "C:/Users/admin/.perplexity-mcp/browser",
    lastUpdated: null,
    lastRefreshTier: null,
    speedBoost: {
      installed: false,
      version: null,
      installedAt: null,
      runtimeDir: "",
    },
  },
  history: [
    {
      id: "h-1",
      query: "latest MCP clients",
      tool: "perplexity_search",
      model: "pplx_pro",
      status: "completed",
      createdAt: "2026-05-04T00:00:00.000Z",
      answerPreview: "Answer preview",
      sourceCount: 2,
      fileCount: 0,
      source: "local",
      pinned: false,
      tags: [],
    },
  ],
  historyTotalCount: 1,
  ideStatus: { cursor: cursorStatus },
  rulesStatus: [],
  settings,
};

afterEach(() => {
  cleanup();
  useDashboardStore.setState({ activeProfile: null });
});

describe("DashboardView cross-link CTAs", () => {
  it("opens the expected tabs from Home CTAs", () => {
    const opened: AppTab[] = [];
    render(<DashboardView state={baseState} send={vi.fn()} onOpenTab={(tab) => opened.push(tab)} />);

    fireEvent.click(screen.getByRole("button", { name: "Open IDEs" }));
    for (const button of screen.getAllByRole("button", { name: "Open Models" })) {
      fireEvent.click(button);
    }
    fireEvent.click(screen.getByRole("button", { name: /rules/i }));
    fireEvent.click(screen.getByRole("button", { name: /doctor/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open History" }));

    expect(opened).toEqual([
      "settings",
      "models",
      "models",
      "models",
      "rules",
      "doctor",
      "history",
    ]);
  });

  it("preserves existing Home action button dispatches", () => {
    const sent: Array<WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">> = [];
    render(
      <DashboardView
        state={baseState}
        send={(message) => sent.push(message)}
        onOpenTab={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /refresh state/i }));
    fireEvent.click(screen.getByRole("button", { name: /generate all configs/i }));
    fireEvent.click(screen.getByRole("button", { name: /add account/i }));

    expect(sent).toContainEqual({ type: "dashboard:refresh" });
    expect(sent).toContainEqual({ type: "configs:generate", payload: { target: "all" } });
    expect(sent).toContainEqual({ type: "profile:add-prompt" });
  });

  it("keeps login flow dispatch when an active profile exists", () => {
    useDashboardStore.setState({ activeProfile: "default" });
    const sent: Array<WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">> = [];
    render(
      <DashboardView
        state={baseState}
        send={(message) => sent.push(message)}
        onOpenTab={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /login flow/i }));

    expect(sent).toContainEqual({ type: "auth:login" });
  });
});
