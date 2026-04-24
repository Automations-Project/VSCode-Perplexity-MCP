import { create } from "zustand";
import type {
  AuthState,
  DaemonAuditEntry,
  DaemonStatusState,
  CfNamedManagedConfig,
  CfNamedTunnelSummary,
  DashboardState,
  DoctorReport,
  ExtensionMessage,
  ExternalViewer,
  HistoryEntryDetail,
  Profile,
  TunnelPerformanceSnapshot,
  TunnelProbeResult,
} from "@perplexity-user-mcp/shared";
import type { AuthorizedClientRow } from "./components/AuthorizedClients";

export type AppTab = "dashboard" | "models" | "history" | "settings" | "rules" | "doctor";

interface NoticeState {
  level: "info" | "warning" | "error";
  message: string;
}

export interface ModelsRefreshStatus {
  phase: "idle" | "pending" | "success" | "error";
  source?: "live" | "cache" | "fallback";
  count?: number;
  error?: string;
  at?: number;
}

export interface TunnelProbeState {
  results: TunnelProbeResult[];
  timeoutMs: 5000;
  error?: string;
  checkedAt?: string;
}

interface DashboardStore {
  state: DashboardState | null;
  activeTab: AppTab;
  notice: NoticeState | null;
  pendingActions: Set<string>;
  modelsRefresh: ModelsRefreshStatus;
  authState: AuthState | null;
  profiles: Profile[];
  activeProfile: string | null;
  otpPrompt: { open: boolean; profile: string; attempt: number; email: string } | null;
  expiredDismissedUntil: number | null;
  richViewEntry: HistoryEntryDetail | null;
  externalViewers: ExternalViewer[];
  daemonStatus: DaemonStatusState | null;
  daemonAuditTail: DaemonAuditEntry[];
  daemonTokenRotatedAt: string | null;
  /**
   * Live revealed bearer. Populated ONLY by the `daemon:bearer:reveal:response`
   * ExtensionMessage (which itself requires a modal-confirmed
   * `daemon:bearer:reveal` request on the extension-host side). Cleared
   * automatically at `expiresAt` by the `DaemonStatus` component's TTL effect,
   * or immediately replaced when a new reveal response arrives with a
   * different `nonce`. While non-null the raw bearer IS in webview state —
   * that is the designed behavior of an explicit reveal; the 30s TTL is the
   * safety rail.
   */
  revealedBearer: { bearer: string; expiresAt: number; nonce: string } | null;
  setRevealedBearer: (r: { bearer: string; expiresAt: number; nonce: string }) => void;
  clearRevealedBearer: () => void;
  /**
   * Phase 8.6.5: most recent `transport:staleness` snapshot from the extension
   * host. `null` = the store has never received a staleness message (pre-hydrate
   * state). `[]` = explicit "zero stale" signal — differs from `null` so the
   * IDEs tab can hide the banner without flashing during initial hydration.
   */
  staleConfigs: Array<{ ideTag: string; reason: "bearer" | "url" }> | null;
  oauthClients: AuthorizedClientRow[] | null;
  setOauthClients: (clients: AuthorizedClientRow[]) => void;
  tunnelProviders: {
    activeProvider: "cf-quick" | "ngrok" | "cf-named";
    providers: Array<{
      id: "cf-quick" | "ngrok" | "cf-named";
      displayName: string;
      description: string;
      isActive: boolean;
      setup: {
        ready: boolean;
        reason?: string;
        action?: {
          label: string;
          kind: "open-url" | "input-authtoken" | "install-binary" | "run-command";
          url?: string;
          /** Identifier (e.g. "cf-named-login") for kind: "run-command". */
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
      lastDeleted?: {
        uuid: string;
        hostname?: string;
        localConfigCleared: boolean;
        dnsCleanupUrl: string;
      };
    };
  } | null;
  tunnelProbe: TunnelProbeState | null;
  /**
   * v0.8.5: most recent tunnel performance snapshot posted from the extension
   * host via `tunnel:performance`. `null` until the first snapshot arrives
   * (pre-hydrate) — the TunnelPerformance component renders nothing in that
   * state to avoid flashing empty rows.
   */
  tunnelPerformance: TunnelPerformanceSnapshot | null;
  historyExport: {
    id: string | null;
    phase: "idle" | "starting" | "downloaded" | "saved" | "error";
    savedPath?: string;
    bytes?: number;
    error?: string;
  };
  cloudSync: {
    phase: "idle" | "starting" | "syncing" | "done" | "cancelled" | "error";
    fetched?: number;
    total?: number;
    inserted?: number;
    updated?: number;
    skipped?: number;
    error?: string;
  };
  cloudHydrate: {
    historyId: string | null;
    phase: "idle" | "starting" | "done" | "skipped-local" | "skipped-hydrated" | "error";
    error?: string;
  };
  historySortNewest: boolean;
  setHistorySortNewest: (v: boolean) => void;
  doctor: {
    phase: "idle" | "running" | "done" | "error";
    report: DoctorReport | null;
    reportingOptOut: boolean;
  };
  setDoctorRunning: () => void;
  setDoctorReport: (r: DoctorReport) => void;
  setDoctorReportingOptOut: (v: boolean) => void;
  hydrate: (message: ExtensionMessage) => void;
  setActiveTab: (tab: AppTab) => void;
  clearNotice: () => void;
  markActionPending: (id: string) => void;
  markActionDone: (id: string) => void;
  setModelsRefresh: (status: ModelsRefreshStatus) => void;
  setAuthState: (s: AuthState) => void;
  setProfiles: (p: { active: string | null; profiles: Profile[] }) => void;
  openOtpPrompt: (p: { profile: string; attempt: number; email: string }) => void;
  closeOtpPrompt: () => void;
  dismissExpiredForMs: (ms: number) => void;
  setRichViewEntry: (entry: HistoryEntryDetail | null) => void;
}

export const useDashboardStore = create<DashboardStore>((set) => ({
  state: null,
  activeTab: "dashboard",
  notice: null,
  pendingActions: new Set<string>(),
  modelsRefresh: { phase: "idle" },
  authState: null,
  profiles: [],
  activeProfile: null,
  otpPrompt: null,
  expiredDismissedUntil: null,
  richViewEntry: null,
  externalViewers: [],
  daemonStatus: null,
  daemonAuditTail: [],
  daemonTokenRotatedAt: null,
  revealedBearer: null,
  setRevealedBearer: (r) => set({ revealedBearer: r }),
  clearRevealedBearer: () => set({ revealedBearer: null }),
  staleConfigs: null,
  oauthClients: null,
  setOauthClients: (clients) => set({ oauthClients: clients }),
  tunnelProviders: null,
  tunnelProbe: null,
  tunnelPerformance: null,
  historyExport: { id: null, phase: "idle" },
  cloudSync: { phase: "idle" },
  cloudHydrate: { historyId: null, phase: "idle" },
  historySortNewest: true,
  setHistorySortNewest: (v) => set({ historySortNewest: v }),
  doctor: { phase: "idle", report: null, reportingOptOut: false },
  setDoctorRunning: () => set((s) => ({ doctor: { ...s.doctor, phase: "running" } })),
  setDoctorReport: (report) => set((s) => ({ doctor: { ...s.doctor, phase: "done", report } })),
  setDoctorReportingOptOut: (v) => set((s) => ({ doctor: { ...s.doctor, reportingOptOut: v } })),
  hydrate: (message) => {
    if (message.type === "dashboard:state") {
      set({ state: message.payload });
      return;
    }

    if (message.type === "notice") {
      set({ notice: message.payload });
      return;
    }

    if (message.type === "history:list") {
      set((store) => {
        if (!store.state) return {};
        const matchingItem = store.richViewEntry
          ? message.payload.items.find((item) => item.id === store.richViewEntry?.id)
          : null;
        const richViewEntry = matchingItem && store.richViewEntry
          ? {
              ...store.richViewEntry,
              ...matchingItem,
              attachments: matchingItem.attachments ?? store.richViewEntry.attachments,
              sources: matchingItem.sources ?? store.richViewEntry.sources,
              tags: matchingItem.tags ?? store.richViewEntry.tags,
            }
          : null;
        return {
          state: {
            ...store.state,
            history: message.payload.items,
          },
          richViewEntry,
        };
      });
      return;
    }

    if (message.type === "history:entry") {
      set({ richViewEntry: message.payload });
      return;
    }

    if (message.type === "viewers:list") {
      set({ externalViewers: message.payload.viewers });
      return;
    }

    if (message.type === "daemon:status-updated") {
      set({ daemonStatus: message.payload });
      return;
    }

    if (message.type === "daemon:audit-tail") {
      set({ daemonAuditTail: message.payload.items });
      return;
    }

    if (message.type === "daemon:tunnel-providers") {
      set({ tunnelProviders: message.payload });
      return;
    }

    if (message.type === "daemon:cf-named-list:result") {
      if (message.payload.ok) {
        const tunnels = message.payload.tunnels;
        set((store) => ({
          tunnelProviders: store.tunnelProviders
            ? {
                ...store.tunnelProviders,
                cfNamed: {
                  config: store.tunnelProviders.cfNamed?.config ?? null,
                  tunnels,
                  lastListedAt: new Date().toISOString(),
                },
              }
            : store.tunnelProviders,
        }));
      } else {
        const error = message.payload.error;
        set((store) => ({
          tunnelProviders: store.tunnelProviders
            ? {
                ...store.tunnelProviders,
                cfNamed: {
                  config: store.tunnelProviders.cfNamed?.config ?? null,
                  tunnels: store.tunnelProviders.cfNamed?.tunnels,
                  lastListedAt: store.tunnelProviders.cfNamed?.lastListedAt,
                  lastListError: error,
                },
              }
            : store.tunnelProviders,
          notice: { level: "error", message: `Cloudflare tunnel list failed: ${error}` },
        }));
      }
      return;
    }

    if (message.type === "daemon:cf-named-delete-remote:result") {
      if (message.payload.ok) {
        const payload = message.payload;
        set((store) => ({
          tunnelProviders: store.tunnelProviders
            ? {
                ...store.tunnelProviders,
                cfNamed: {
                  config:
                    store.tunnelProviders.cfNamed?.config?.uuid === payload.uuid
                      ? null
                      : store.tunnelProviders.cfNamed?.config ?? null,
                  tunnels: store.tunnelProviders.cfNamed?.tunnels?.filter((t) => t.uuid !== payload.uuid),
                  lastListedAt: store.tunnelProviders.cfNamed?.lastListedAt,
                  lastDeleted: {
                    uuid: payload.uuid,
                    hostname: payload.hostname,
                    localConfigCleared: payload.localConfigCleared,
                    dnsCleanupUrl: payload.dnsCleanupUrl,
                  },
                },
              }
            : store.tunnelProviders,
        }));
      }
      return;
    }

    if (message.type === "daemon:tunnel-probe:result") {
      set({
        tunnelProbe: message.payload.ok
          ? {
              results: message.payload.results,
              timeoutMs: message.payload.timeoutMs,
              checkedAt: new Date().toISOString(),
            }
          : {
              results: message.payload.results ?? [],
              timeoutMs: message.payload.timeoutMs,
              error: message.payload.error,
              checkedAt: new Date().toISOString(),
            },
      });
      return;
    }

    if (message.type === "daemon:tunnel-url") {
      set((store) => ({
        daemonStatus: store.daemonStatus
          ? { ...store.daemonStatus, tunnel: message.payload }
          : store.daemonStatus,
        notice: message.payload.status === "crashed"
          ? { level: "error", message: `Cloudflare tunnel crashed${message.payload.error ? `: ${message.payload.error}` : "."}` }
          : store.notice,
      }));
      return;
    }

    if (message.type === "daemon:oauth-clients") {
      set({ oauthClients: message.payload.clients });
      return;
    }

    if (message.type === "daemon:bearer:reveal:response") {
      // Translate the host's relative TTL into an absolute deadline so the
      // UI's tick loop can compute remaining seconds without trusting
      // setTimeout drift. A new nonce overwrites any prior slice — e.g. the
      // user clicks Reveal twice in a row; the second response supersedes
      // the first and the TTL restarts from 30s.
      const expiresAt = Date.now() + message.payload.expiresInMs;
      set({
        revealedBearer: {
          bearer: message.payload.bearer,
          expiresAt,
          nonce: message.payload.nonce,
        },
      });
      return;
    }

    if (message.type === "daemon:token-rotated") {
      set({
        daemonTokenRotatedAt: message.payload.rotatedAt,
        notice: { level: "info", message: "Daemon token rotated. MCP clients will reconnect with the new token." },
      });
      return;
    }

    if (message.type === "tunnel:performance") {
      // Overwrite unconditionally — the extension host recomputes from the
      // audit tail + its own ring buffer on every postDaemonState and is
      // authoritative. Null is the pre-hydrate state (store default); we
      // never regress to null on receipt.
      set({ tunnelPerformance: message.payload });
      return;
    }

    if (message.type === "transport:staleness") {
      // Overwrites unconditionally — the extension host is authoritative and
      // always sends the full current set. An empty array is a meaningful
      // "nothing is stale" signal, distinct from the pre-hydrate `null`.
      set({ staleConfigs: message.payload.stale });
      return;
    }

    if (message.type === "history:export:progress") {
      set({
        historyExport: {
          id: message.payload.id,
          phase: message.payload.phase,
          savedPath: message.payload.savedPath,
          bytes: message.payload.bytes,
          error: message.payload.error,
        },
        notice: message.payload.phase === "saved"
          ? { level: "info", message: `History export saved to ${message.payload.savedPath}` }
          : message.payload.phase === "error"
            ? { level: "error", message: `History export failed: ${message.payload.error}` }
            : null,
      });
      return;
    }

    if (message.type === "history:cloud-sync:progress") {
      set({
        cloudSync: {
          phase: message.payload.phase,
          fetched: message.payload.fetched,
          total: message.payload.total,
          inserted: message.payload.inserted,
          updated: message.payload.updated,
          skipped: message.payload.skipped,
          error: message.payload.error,
        },
        notice: message.payload.phase === "error"
          ? { level: "error", message: `Cloud sync failed: ${message.payload.error}` }
          : null,
      });
      return;
    }

    if (message.type === "history:cloud-hydrate:progress") {
      set({
        cloudHydrate: {
          historyId: message.payload.historyId,
          phase: message.payload.phase,
          error: message.payload.error,
        },
      });
      return;
    }

    if (message.type === "diagnostics:capture:result") {
      if (message.ok) {
        const suffix =
          message.sourcesMissing.length > 0
            ? ` (missing: ${message.sourcesMissing.join(", ")})`
            : "";
        set({
          notice: {
            level: "info",
            message: `Diagnostics saved to ${message.outputPath}${suffix}.`,
          },
        });
      } else if (message.error !== "cancelled") {
        set({ notice: { level: "error", message: `Diagnostics capture failed: ${message.error}` } });
      }
      return;
    }

    if (message.type === "models:refresh:status") {
      const { phase, source, count, error } = message.payload;
      set({
        modelsRefresh: {
          phase: phase === "start" ? "pending" : phase,
          source,
          count,
          error,
          at: Date.now(),
        },
      });
    }

    if (message.type === "doctor:running") {
      set((s) => ({ doctor: { ...s.doctor, phase: "running" } }));
    }

    if (message.type === "doctor:report") {
      set((s) => ({ doctor: { ...s.doctor, phase: "done", report: message.payload } }));
    }
  },
  setActiveTab: (tab) => set({ activeTab: tab }),
  clearNotice: () => set({ notice: null }),
  markActionPending: (id: string) => set((state) => {
    const next = new Set(state.pendingActions);
    next.add(id);
    return { pendingActions: next };
  }),
  markActionDone: (id: string) => set((state) => {
    const next = new Set(state.pendingActions);
    next.delete(id);
    return { pendingActions: next };
  }),
  setModelsRefresh: (status) => set({ modelsRefresh: status }),
  setAuthState: (s) => set({ authState: s }),
  setProfiles: ({ active, profiles }) => set({ activeProfile: active, profiles }),
  openOtpPrompt: (p) => set({ otpPrompt: { open: true, ...p } }),
  closeOtpPrompt: () => set({ otpPrompt: null }),
  dismissExpiredForMs: (ms) => set({ expiredDismissedUntil: Date.now() + ms }),
  setRichViewEntry: (entry) => set({ richViewEntry: entry }),
}));

/**
 * Returns `true` while any in-flight `pendingActions` id starts with the given
 * message type prefix. IDs are generated in `App.tsx` via
 * `${type}-${seq}-${base36}`, so matching on `${prefix}-` is unambiguous.
 * Used by `DaemonStatus` to render spinner / disabled state on the exact
 * button that was clicked — eliminating the "dead click" window between
 * `postMessage` and the extension host's `action:result` response.
 */
export function useIsActionPending(prefix: string): boolean {
  return useDashboardStore((s) => {
    for (const id of s.pendingActions) {
      if (id.startsWith(`${prefix}-`)) return true;
    }
    return false;
  });
}
