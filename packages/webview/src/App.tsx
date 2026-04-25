import { BookOpen, Bot, Clock3, Compass, Layers3, RefreshCcw, Settings2, ShieldCheck, Sparkles, Stethoscope } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { startTransition, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import type { ExtensionMessage, HistoryItem, WebviewMessage } from "@perplexity-user-mcp/shared";
import { postMessage } from "./lib/vscode";
import { ACTION_TYPES } from "./action-types";
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
import { RichView } from "./components/RichView";

const tabs: Array<{ id: AppTab; label: string; icon: typeof Compass }> = [
  { id: "dashboard", label: "Home", icon: Compass },
  { id: "settings", label: "IDEs", icon: Settings2 },
  { id: "rules", label: "Rules", icon: BookOpen },
  { id: "models", label: "Models", icon: Layers3 },
  { id: "doctor", label: "Doctor", icon: Stethoscope },
  { id: "history", label: "History", icon: Clock3 },
];

const initialDashboardState = window.__PERPLEXITY_INITIAL_STATE__;

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
      item.answerPreview.toLowerCase().includes(needle) ||
      (item.model ?? "").toLowerCase().includes(needle) ||
      (item.status ?? "").toLowerCase().includes(needle) ||
      (item.tags ?? []).some((tag) => tag.toLowerCase().includes(needle)),
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
  const richViewEntry = useDashboardStore((store) => store.richViewEntry);
  const externalViewers = useDashboardStore((store) => store.externalViewers);
  const setRichViewEntry = useDashboardStore((store) => store.setRichViewEntry);

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
      {richViewEntry ? (
        <RichView
          entry={richViewEntry}
          viewers={externalViewers}
          send={send}
          onClose={() => setRichViewEntry(null)}
        />
      ) : null}

      <header className="glass-panel sidebar-panel">
        <div className="app-header-row">
          <div className="brand-mark">
            <Bot size={14} />
          </div>
          <div className="app-header-title">
            <div className="app-header-eyebrow">Perplexity</div>
            <div className="text-sm font-semibold text-[var(--text-primary)] truncate">
              {!activeProfile ? "No Account Yet" : snapshot?.loggedIn ? "Command Center" : "Login Required"}
            </div>
          </div>
          <div className="app-header-actions">
            {snapshot ? (
              <div className={`chip app-tier-chip ${tierClass(snapshot.tier)}`}>
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

        <div className="app-quick-actions">
          <button
            className="ghost-button app-quick-action"
            onClick={() => send({ type: "models:refresh" })}
            disabled={modelsRefresh.phase === "pending"}
            title="Re-fetch live models + account info from Perplexity"
          >
            <RefreshCcw size={13} className={modelsRefresh.phase === "pending" ? "refresh-spin" : undefined} />
            <span>{modelsRefresh.phase === "pending" ? "Refreshing..." : "Refresh"}</span>
          </button>
          {!activeProfile ? (
            <button className="primary-button app-quick-action" onClick={() => send({ type: "profile:add-prompt" })}>
              <Sparkles size={13} />
              <span>Add account</span>
            </button>
          ) : snapshot?.loggedIn ? (
            <button className="ghost-button app-quick-action app-quick-action-muted" onClick={() => send({ type: "auth:login" })}>
              <Sparkles size={13} />
              <span>Re-login</span>
            </button>
          ) : (
            <button className="primary-button app-quick-action" onClick={() => send({ type: "auth:login" })}>
              <Sparkles size={13} />
              <span>Login</span>
            </button>
          )}
        </div>
      </header>

      <main className="content-shell">

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
              <HistoryView filter={historyFilter} setFilter={setHistoryFilter} items={filteredHistory} totalCount={state.history.length} send={send} />
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
