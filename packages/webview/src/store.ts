import { create } from "zustand";
import type { AuthState, DashboardState, ExtensionMessage, Profile } from "@perplexity/shared";

export type AppTab = "dashboard" | "models" | "history" | "settings" | "rules";

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
  hydrate: (message) => {
    if (message.type === "dashboard:state") {
      set({ state: message.payload });
      return;
    }

    if (message.type === "notice") {
      set({ notice: message.payload });
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
}));
