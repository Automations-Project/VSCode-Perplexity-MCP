import { create } from "zustand";
import type {
  AuthState,
  DashboardState,
  DoctorReport,
  ExtensionMessage,
  ExternalViewer,
  HistoryEntryDetail,
  Profile,
} from "@perplexity-user-mcp/shared";

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
  historyExport: { id: null, phase: "idle" },
  cloudSync: { phase: "idle" },
  cloudHydrate: { historyId: null, phase: "idle" },
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
