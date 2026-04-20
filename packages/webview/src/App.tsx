import { BookOpen, Bot, Clock3, Compass, Layers3, RefreshCcw, Settings2, ShieldCheck, Sparkles, Stethoscope } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { startTransition, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import type { ExtensionMessage, HistoryItem, WebviewMessage } from "@perplexity-user-mcp/shared";
import { postMessage } from "./lib/vscode";
import { type AppTab, useDashboardStore } from "./store";
import {
  DashboardView,
  HistoryView,
  ModelsView,
  RulesView,
  SettingsView,
  buildModelGroups,
  prettifyMode,
  tierClass,
} from "./views";
import { ProfileSwitcher } from "./components/ProfileSwitcher";
import { OtpModal } from "./components/OtpModal";
import { ExpiredBanner } from "./components/ExpiredBanner";
import { DoctorTab } from "./components/DoctorTab";

const tabs: Array<{ id: AppTab; label: string; icon: typeof Compass }> = [
  { id: "dashboard", label: "Home", icon: Compass },
  { id: "settings", label: "IDEs", icon: Settings2 },
  { id: "rules", label: "Rules", icon: BookOpen },
  { id: "models", label: "Models", icon: Layers3 },
  { id: "doctor", label: "Doctor", icon: Stethoscope },
  { id: "history", label: "History", icon: Clock3 },
];

const initialDashboardState = window.__PERPLEXITY_INITIAL_STATE__;

const ACTION_TYPES = new Set<string>([
  "auth:login",
  "configs:generate",
  "configs:remove",
  "rules:sync",
  "rules:remove",
  "models:refresh",
  "speed-boost:install",
  "speed-boost:uninstall",
  "doctor:run",
  "doctor:probe",
  "doctor:export",
  "doctor:report-issue",
  "doctor:action",
]);

let actionSeq = 0;
function nextActionId(prefix: string): string {
  return `${prefix}-${++actionSeq}-${Date.now().toString(36)}`;
}

/**
 * Send a webview message. For action-type messages the `id` field is
 * auto-generated and the action is registered as pending in the store.
 */
function send(message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">): void {
  if (ACTION_TYPES.has(message.type) && !("id" in message && message.id)) {
    const id = nextActionId(message.type);
    const full = { ...message, id } as WebviewMessage;
    useDashboardStore.getState().markActionPending(id);
    postMessage(full);
    return;
  }
  postMessage(message as WebviewMessage);
}

function filterHistory(items: HistoryItem[], filter: string): HistoryItem[] {
  if (!filter.trim()) {
    return items;
  }

  const needle = filter.toLowerCase();
  return items.filter(
    (item) =>
      item.query.toLowerCase().includes(needle) ||
      item.tool.toLowerCase().includes(needle) ||
      item.answerPreview.toLowerCase().includes(needle),
  );
}

function DoctorTabWrapper({ send }: { send: (m: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void }) {
  const report = useDashboardStore((s) => s.doctor.report);
  const phase = useDashboardStore((s) => s.doctor.phase);
  const reportingOptOut = useDashboardStore((s) => s.doctor.reportingOptOut);
  return <DoctorTab report={report} phase={phase} reportingOptOut={reportingOptOut} send={send} />;
}

function App() {
  const state = useDashboardStore((store) => store.state);
  const activeTab = useDashboardStore((store) => store.activeTab);
  const hydrate = useDashboardStore((store) => store.hydrate);
  const setActiveTab = useDashboardStore((store) => store.setActiveTab);
  const notice = useDashboardStore((store) => store.notice);
  const clearNotice = useDashboardStore((store) => store.clearNotice);
  const modelsRefresh = useDashboardStore((store) => store.modelsRefresh);
  const activeProfile = useDashboardStore((store) => store.activeProfile);

  const [modelFilter, setModelFilter] = useState("");
  const [historyFilter, setHistoryFilter] = useState("");
  const deferredModelFilter = useDeferredValue(modelFilter);
  const deferredHistoryFilter = useDeferredValue(historyFilter);

  const hydrateRef = useRef(hydrate);
  hydrateRef.current = hydrate;

  const onMessage = useCallback((event: MessageEvent<ExtensionMessage>) => {
    const msg = event.data;
    if (msg.type === "action:result") {
      useDashboardStore.getState().markActionDone(msg.id);
      return;
    }
    if (msg.type === "auth:state") {
      useDashboardStore.getState().setAuthState(msg.payload);
      return;
    }
    if (msg.type === "profile:list") {
      useDashboardStore.getState().setProfiles(msg.payload);
      return;
    }
    if (msg.type === "auth:otp-prompt") {
      useDashboardStore.getState().openOtpPrompt(msg.payload);
      return;
    }
    hydrateRef.current(msg);
  }, []);

  useEffect(() => {
    if (initialDashboardState) {
      hydrate({ type: "dashboard:state", payload: initialDashboardState });
    }

    window.addEventListener("message", onMessage);
    send({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, [hydrate, onMessage]);

  const snapshot = state?.snapshot;
  const filteredHistory = filterHistory(state?.history ?? [], deferredHistoryFilter);
  const modelGroups = buildModelGroups(state, deferredModelFilter);

  return (
    <div className="app-shell">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="orb orb-a" />
        <div className="orb orb-b" />
      </div>

      <ExpiredBanner send={send} />
      <OtpModal send={send} />

      <header className="glass-panel sidebar-panel">
        <div className="flex items-center gap-2 min-w-0">
          <div className="brand-mark">
            <Bot size={14} />
          </div>
          <div className="min-w-0 flex-1">
            <div style={{ fontSize: "0.65rem" }} className="uppercase tracking-[0.2em] text-[var(--text-muted)]">Perplexity</div>
            <div className="text-sm font-semibold text-[var(--text-primary)] truncate">
              {!activeProfile ? "No Account Yet" : snapshot?.loggedIn ? "Command Center" : "Login Required"}
            </div>
          </div>
          <div className="flex-shrink-0 flex items-center gap-2">
            {snapshot ? (
              <div className={`chip ${tierClass(snapshot.tier)}`} style={{ padding: "4px 8px", fontSize: "0.7rem" }}>
                <ShieldCheck size={12} />
                <span>{snapshot.tier}</span>
              </div>
            ) : null}
            <ProfileSwitcher send={send} />
          </div>
        </div>

        <div className="tab-bar">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                className={`nav-item ${activeTab === tab.id ? "nav-item-active" : ""}`}
                onClick={() => startTransition(() => setActiveTab(tab.id))}
              >
                <Icon size={14} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            className="ghost-button flex-1"
            style={{ padding: "6px 10px", fontSize: "0.78rem", minWidth: 0, justifyContent: "center" }}
            onClick={() => send({ type: "models:refresh" })}
            disabled={modelsRefresh.phase === "pending"}
            title="Re-fetch live models + account info from Perplexity"
          >
            <RefreshCcw size={13} className={modelsRefresh.phase === "pending" ? "refresh-spin" : undefined} />
            <span>{modelsRefresh.phase === "pending" ? "Refreshing..." : "Refresh"}</span>
          </button>
          {!activeProfile ? (
            <button className="primary-button flex-1" style={{ padding: "6px 10px", fontSize: "0.78rem", minWidth: 0, justifyContent: "center" }} onClick={() => send({ type: "profile:add-prompt" })}>
              <Sparkles size={13} />
              <span>Add account</span>
            </button>
          ) : snapshot?.loggedIn ? (
            <button className="ghost-button flex-1" style={{ padding: "6px 10px", fontSize: "0.78rem", minWidth: 0, justifyContent: "center", opacity: 0.7 }} onClick={() => send({ type: "auth:login" })}>
              <Sparkles size={13} />
              <span>Re-login</span>
            </button>
          ) : (
            <button className="primary-button flex-1" style={{ padding: "6px 10px", fontSize: "0.78rem", minWidth: 0, justifyContent: "center" }} onClick={() => send({ type: "auth:login" })}>
              <Sparkles size={13} />
              <span>Login</span>
            </button>
          )}
        </div>
      </header>

      <main className="content-shell" style={{ gap: "12px" }}>

        <AnimatePresence mode="wait">
          <motion.section
            key={activeTab}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="grid gap-3"
          >
            {notice ? (
              <div className={`glass-panel notice notice-${notice.level}`}>
                <div className="text-sm text-[var(--text-primary)]">{notice.message}</div>
                <button className="ghost-button" onClick={clearNotice}>
                  Dismiss
                </button>
              </div>
            ) : null}

            {!state ? <div className="glass-panel hero-panel">Waiting for extension state...</div> : null}
            {state && activeTab === "dashboard" ? <DashboardView state={state} send={send} /> : null}
            {state && activeTab === "models" ? (
              <ModelsView filter={modelFilter} setFilter={setModelFilter} groups={modelGroups} state={state} send={send} />
            ) : null}
            {state && activeTab === "history" ? (
              <HistoryView filter={historyFilter} setFilter={setHistoryFilter} items={filteredHistory} />
            ) : null}
            {state && activeTab === "settings" ? <SettingsView state={state} send={send} /> : null}
            {state && activeTab === "rules" ? <RulesView state={state} send={send} /> : null}
            {activeTab === "doctor" ? (
              <DoctorTabWrapper send={send} />
            ) : null}
          </motion.section>
        </AnimatePresence>
      </main>
    </div>
  );
}

export default App;
