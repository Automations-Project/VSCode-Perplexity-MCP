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

export type AuthStatus =
  | "unknown" | "checking" | "valid" | "expired" | "error"
  | "logging-in" | "awaiting_otp" | "chrome_missing" | "sso_required";

export interface AuthState {
  profile: string;
  status: AuthStatus;
  tier?: "Max" | "Pro" | "Enterprise" | "Authenticated" | "Anonymous";
  userId?: string;
  email?: string;
  lastLogin?: string;
  lastChecked?: string;
  error?: string;
}

export interface Profile {
  name: string;
  displayName: string;
  createdAt: string;
  lastLogin?: string;
  lastChecked?: string;
  loginMode: "auto" | "manual";
  tier?: "Max" | "Pro" | "Enterprise" | "Authenticated" | "Anonymous";
}

export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

export type DoctorCategory =
  | "runtime" | "config" | "profiles" | "vault" | "browser"
  | "native-deps" | "network" | "ide" | "mcp" | "probe";

/**
 * Optional one-click remediation for a failing/warning check. The webview
 * renders a button labelled `action.label` next to the hint; clicking it
 * dispatches `doctor:action` → the extension host runs the VS Code command.
 */
export interface DoctorAction {
  label: string;
  commandId: string;
  args?: unknown[];
}

export interface DoctorCheck {
  category: DoctorCategory;
  name: string;
  status: DoctorStatus;
  message: string;
  detail?: Record<string, unknown>;
  hint?: string;
  action?: DoctorAction;
}

export interface DoctorReport {
  overall: DoctorStatus;
  generatedAt: string;
  durationMs: number;
  activeProfile: string | null;
  probeRan: boolean;
  byCategory: Record<DoctorCategory, {
    status: DoctorStatus;
    checks: DoctorCheck[];
  }>;
}

export type ExportFormat = "pdf" | "markdown" | "docx";

export interface ExternalViewer {
  id: string;
  label: string;
  urlTemplate: string;
  needsVaultBridge: boolean;
  vaultPath?: string;
  vaultName?: string;
  graphName?: string;
  detected: boolean;
  enabled: boolean;
}

export interface HistoryEntryDetail extends HistoryItem {
  body: string;
  mdPath: string;
  attachmentsDir: string;
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
    }
  | { type: "auth:state"; payload: AuthState }
  | { type: "auth:otp-prompt"; payload: { profile: string; attempt: number; email: string } }
  | { type: "profile:list"; payload: { active: string | null; profiles: Profile[] } }
  | { type: "doctor:running"; payload: { probeRan: boolean } }
  | { type: "doctor:report"; payload: DoctorReport }
  | { type: "history:list"; payload: { items: HistoryItem[] } }
  | { type: "history:entry"; payload: HistoryEntryDetail }
  | {
      type: "history:export:progress";
      payload: {
        id: string;
        phase: "starting" | "downloaded" | "saved" | "error";
        bytes?: number;
        error?: string;
        savedPath?: string;
      };
    }
  | { type: "viewers:list"; payload: { viewers: ExternalViewer[] } }
  | {
      type: "history:cloud-sync:progress";
      payload: {
        id: string;
        phase: "starting" | "syncing" | "done" | "cancelled" | "error";
        fetched?: number;
        total?: number;
        inserted?: number;
        updated?: number;
        skipped?: number;
        error?: string;
      };
    }
  | {
      type: "history:cloud-hydrate:progress";
      payload: {
        id: string;
        historyId: string;
        phase: "starting" | "done" | "skipped-local" | "skipped-hydrated" | "error";
        error?: string;
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
    }
  | { type: "auth:login-start"; id: string; payload: { profile: string; mode: "auto" | "manual"; email?: string } }
  | { type: "auth:otp-submit"; id: string; payload: { profile: string; otp: string } }
  | { type: "auth:logout"; id: string; payload: { profile: string; purge?: boolean } }
  | { type: "auth:dismiss-expired"; payload: { profile: string; bumpHours: number } }
  | { type: "profile:switch"; id: string; payload: { name: string } }
  | { type: "profile:add-prompt" }
  | { type: "profile:add"; id: string; payload: { name: string; displayName?: string; loginMode: "auto" | "manual" } }
  | { type: "profile:delete"; id: string; payload: { name: string } }
  | { type: "doctor:run"; id: string; payload: { profile?: string; allProfiles?: boolean } }
  | { type: "doctor:probe"; id: string; payload: { profile?: string } }
  | { type: "doctor:export"; id: string; payload: { targetPath?: string } }
  | { type: "doctor:report-issue"; id: string; payload: { category: DoctorCategory; check: string } }
  | { type: "doctor:action"; id: string; payload: { commandId: string; args?: unknown[] } }
  | { type: "history:request-list"; payload?: { filter?: string } }
  | { type: "history:request-entry"; id: string; payload: { historyId: string } }
  | { type: "history:open-preview"; id: string; payload: { historyId: string } }
  | { type: "history:open-rich"; id: string; payload: { historyId: string } }
  | { type: "history:open-with"; id: string; payload: { historyId: string; viewerId: string } }
  | { type: "history:export"; id: string; payload: { historyId: string; format: ExportFormat } }
  | { type: "history:pin"; id: string; payload: { historyId: string; pinned: boolean } }
  | { type: "history:tag"; id: string; payload: { historyId: string; tags: string[] } }
  | { type: "history:delete"; id: string; payload: { historyId: string } }
  | { type: "history:rebuild-index"; id: string }
  | { type: "viewers:request-list" }
  | { type: "viewers:configure"; id: string; payload: { viewer: ExternalViewer } }
  | { type: "history:cloud-sync"; id: string; payload?: { pageSize?: number } }
  | { type: "history:cloud-hydrate"; id: string; payload: { historyId: string } };
