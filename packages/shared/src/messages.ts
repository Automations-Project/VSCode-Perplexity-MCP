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
  /** Hours a granted OAuth consent is remembered before the user is prompted again. 0 disables the cache (modal every time). */
  oauthConsentCacheTtlHours: number;
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

export type DaemonTunnelStatus = "disabled" | "starting" | "enabled" | "crashed";

export interface DaemonTunnelState {
  status: DaemonTunnelStatus;
  url: string | null;
  pid?: number | null;
  error?: string | null;
}

export interface DaemonStatusState {
  running: boolean;
  healthy: boolean;
  stale: boolean;
  configDir: string;
  lockPath: string;
  tokenPath: string;
  pid: number | null;
  uuid: string | null;
  port: number | null;
  url: string | null;
  version: string | null;
  startedAt: string | null;
  uptimeMs: number | null;
  heartbeatCount: number | null;
  tunnel: DaemonTunnelState;
  /** True iff a daemon token exists on disk. The raw bearer is NEVER sent over this channel. */
  bearerAvailable: boolean;
}

export interface DaemonAuditEntry {
  timestamp: string;
  clientId: string;
  tool: string;
  durationMs: number;
  source: "loopback" | "tunnel";
  ok: boolean;
  error?: string;
}

export type TunnelProbeTarget = "/" | "/mcp";
export type TunnelProbeVerdict = "ok" | "security-flag" | "challenge" | "retryable" | "unknown";

export interface TunnelProbeResult {
  target: TunnelProbeTarget;
  status?: number;
  cfMitigated: boolean;
  verdict: TunnelProbeVerdict;
  checkedAt: string;
  error?: "timeout" | "network" | "no-tunnel-url" | "unsupported";
}

export interface CfNamedManagedConfig {
  uuid: string;
  hostname: string;
  configPath: string;
  credentialsPresent: boolean;
}

export interface CfNamedTunnelSummary {
  uuid: string;
  name: string;
  connections?: number;
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
  | { type: "daemon:status-updated"; payload: DaemonStatusState }
  | { type: "daemon:tunnel-url"; payload: DaemonTunnelState }
  | { type: "daemon:token-rotated"; payload: { rotatedAt: string } }
  | { type: "daemon:audit-tail"; payload: { items: DaemonAuditEntry[] } }
  | {
      type: "daemon:bearer:reveal:response";
      id: string;
      payload: { bearer: string; expiresInMs: number; nonce: string };
    }
  | {
      type: "daemon:oauth-clients";
      payload: {
        clients: Array<{
          clientId: string;
          clientName?: string;
          registeredAt: number;
          lastUsedAt?: string;
          consentLastApprovedAt?: string;
          activeTokens: number;
        }>;
      };
    }
  | {
      type: "daemon:oauth-consents";
      payload: {
        consents: Array<{
          clientId: string;
          redirectUri: string;
          approvedAt: string;
          expiresAt: number;
        }>;
      };
    }
  | {
      type: "daemon:tunnel-providers";
      payload: {
        activeProvider: "cf-quick" | "ngrok" | "cf-named";
        providers: Array<{
          id: "cf-quick" | "ngrok" | "cf-named";
          displayName: string;
          description: string;
          isActive: boolean;
          setup: {
            ready: boolean;
            reason?: string;
            /** See SetupCheck in mcp-server types.ts for kind semantics. */
            action?: {
              label: string;
              kind: "open-url" | "input-authtoken" | "install-binary" | "run-command";
              url?: string;
              /** Opaque identifier (e.g. "cf-named-login") for kind: "run-command". */
              command?: string;
            };
          };
        }>;
        ngrok: { configured: boolean; domain?: string; updatedAt?: string };
        cfNamed?: {
          config: CfNamedManagedConfig | null;
          tunnels?: CfNamedTunnelSummary[];
          lastListedAt?: string;
          lastListError?: string;
        };
      };
    }
  | {
      type: "daemon:cf-named-login:result";
      id: string;
      payload: { ok: true; certPath: string } | { ok: false; error: string };
    }
  | {
      type: "daemon:cf-named-create:result";
      id: string;
      payload:
        | { ok: true; hostname: string; uuid: string; configPath: string }
        | { ok: false; error: string };
    }
  | {
      type: "daemon:cf-named-list:result";
      id: string;
      payload:
        | { ok: true; tunnels: CfNamedTunnelSummary[] }
        | { ok: false; error: string };
    }
  | {
      type: "daemon:cf-named-unbind-local:result";
      id: string;
      payload:
        | { ok: true; uuid: string; configCleared: boolean }
        | { ok: false; error: string };
    }
  | {
      type: "daemon:cf-named-delete-remote:result";
      id: string;
      payload:
        | {
            ok: true;
            uuid: string;
            hostname?: string;
            localConfigCleared: boolean;
            dnsCleanupUrl: string;
          }
        | { ok: false; error: string; reason?: "active-connections" | "unknown" };
    }
  | {
      type: "daemon:tunnel-probe:result";
      id: string;
      payload:
        | { ok: true; results: TunnelProbeResult[]; timeoutMs: 5000 }
        | { ok: false; results?: TunnelProbeResult[]; timeoutMs: 5000; error: string };
    }
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
      type: "log:webview";
      payload: { level: "log" | "warn" | "error" | "info" | "debug"; args: unknown[]; ts: string };
    }
  | {
      type: "daemon:restart";
      id: string;
    }
  | {
      type: "daemon:kill";
      id: string;
    }
  | {
      type: "daemon:list-tunnel-providers";
      id: string;
    }
  | {
      type: "daemon:set-tunnel-provider";
      id: string;
      payload: { providerId: "cf-quick" | "ngrok" | "cf-named" };
    }
  | {
      type: "daemon:install-cloudflared";
      id: string;
    }
  | {
      type: "daemon:cf-named-login";
      id: string;
    }
  | {
      type: "daemon:cf-named-create";
      id: string;
      payload:
        | {
            mode: "create";
            /** Human-readable tunnel name, e.g. "perplexity-mcp". */
            name: string;
            /** Fully qualified hostname, e.g. "mcp.example.com". */
            hostname: string;
          }
        | {
            mode: "bind-existing";
            /** UUID of an existing tunnel the user created manually. */
            uuid: string;
            hostname: string;
          };
    }
  | {
      type: "daemon:cf-named-list";
      id: string;
    }
  | {
      type: "daemon:cf-named-unbind-local";
      id: string;
      payload: { uuid: string };
    }
  | {
      type: "daemon:cf-named-delete-remote";
      id: string;
      payload: { uuid: string; name: string; hostname?: string };
    }
  | {
      type: "daemon:tunnel-probe";
      id: string;
      payload?: { targets?: TunnelProbeTarget[]; timeoutMs?: 5000 };
    }
  | {
      type: "daemon:set-ngrok-authtoken";
      id: string;
      payload: { authtoken: string };
    }
  | {
      type: "daemon:set-ngrok-domain";
      id: string;
      payload: { domain: string | null };
    }
  | {
      type: "daemon:clear-ngrok-settings";
      id: string;
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
  | { type: "daemon:status"; id: string }
  | { type: "daemon:rotate-token"; id: string }
  | { type: "daemon:enable-tunnel"; id: string }
  | { type: "daemon:disable-tunnel"; id: string }
  | { type: "daemon:oauth-consents-list"; id: string }
  | { type: "daemon:oauth-consents-revoke"; id: string; payload: { clientId: string; redirectUri?: string } }
  | { type: "daemon:oauth-consents-revoke-all"; id: string }
  | { type: "daemon:bearer:copy"; id: string }
  | { type: "daemon:bearer:reveal"; id: string }
  | { type: "oauth-clients:list"; id: string }
  | { type: "oauth-clients:revoke"; id: string; payload: { clientId: string } }
  | { type: "oauth-clients:revoke-all"; id: string }
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
