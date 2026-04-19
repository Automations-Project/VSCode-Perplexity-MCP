import type { AccountSnapshot, HistoryItem } from "./models.js";
import type { DebugState } from "./debug.js";

export type IdeTarget =
  | "cursor" | "windsurf" | "windsurfNext" | "claudeDesktop" | "claudeCode"
  | "cline" | "amp" | "rooCode" | "codexCli"
  | "continueDev" | "copilot" | "zed" | "geminiCli"
  | "aider" | "augment";

export interface IdeStatus {
  detected: boolean;
  configured: boolean;
  health: "configured" | "stale" | "missing";
  path: string;
  lastConfiguredAt?: string;
  displayName: string;
  autoConfigurable: boolean;
  configFormat: "json" | "toml" | "yaml" | "ui-only";
}

export interface ExtensionSettingsSnapshot {
  defaultSearchModel: string;
  reasonModel: string;
  researchModel: string;
  computeModel: string;
  chromePath: string;
  debugMode: boolean;
  autoConfigureCursor: boolean;
  autoConfigureWindsurf: boolean;
  autoConfigureWindsurfNext: boolean;
  autoConfigureClaudeDesktop: boolean;
  autoConfigureClaudeCode: boolean;
  autoConfigureCline: boolean;
  autoConfigureAmp: boolean;
  autoConfigureCodexCli: boolean;
  autoRefreshIntervalHours: number;
  debugBufferSize: number;
  debugVerboseHttp: boolean;
}

export interface RulesStatus {
  ide: IdeTarget;
  rulesPath: string;
  hasPerplexitySection: boolean;
  lastUpdated?: string;
}

export interface DashboardState {
  snapshot: AccountSnapshot;
  history: HistoryItem[];
  ideStatus: Record<string, IdeStatus>;
  rulesStatus: RulesStatus[];
  settings: ExtensionSettingsSnapshot;
  debug: DebugState;
}

export type ExtensionMessage =
  | {
      type: "dashboard:state";
      payload: DashboardState;
    }
  | {
      type: "notice";
      payload: {
        level: "info" | "warning" | "error";
        message: string;
      };
    }
  | { type: "action:result"; id: string; ok: boolean; error?: string }
  | {
      type: "models:refresh:status";
      payload: {
        phase: "start" | "success" | "error";
        source?: "live" | "cache" | "fallback";
        tier?: "got-scraping" | "impit" | "browser";
        count?: number;
        elapsedMs?: number;
        error?: string;
      };
    }
  | {
      type: "speed-boost:status";
      payload: {
        phase: "installing" | "uninstalling" | "idle";
        line?: string;
      };
    };

export type WebviewMessage =
  | {
      type: "ready";
    }
  | {
      type: "auth:login";
      id: string;
    }
  | {
      type: "dashboard:refresh";
    }
  | {
      type: "configs:generate";
      id: string;
      payload: {
        target: "all" | IdeTarget;
      };
    }
  | {
      type: "configs:remove";
      id: string;
      payload: {
        target: IdeTarget;
      };
    }
  | {
      type: "rules:sync";
      id: string;
      payload: {
        target: "all" | IdeTarget;
      };
    }
  | {
      type: "rules:remove";
      id: string;
      payload: {
        target: IdeTarget;
      };
    }
  | {
      type: "settings:update";
      payload: Partial<ExtensionSettingsSnapshot>;
    }
  | {
      type: "models:refresh";
      id: string;
    }
  | {
      type: "speed-boost:install";
      id: string;
    }
  | {
      type: "speed-boost:uninstall";
      id: string;
    };
