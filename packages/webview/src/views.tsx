import { useState, useCallback, useEffect, useRef } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Clock,
  Cloud,
  Copy,
  Database,
  ExternalLink,
  FileCode2,
  FileText,
  Globe,
  HardDriveDownload,
  Hash,
  Link as LinkIcon,
  ListFilter,
  Minus,
  Pin,
  PinOff,
  Plus,
  RefreshCcw,
  RotateCcw,
  Rocket,
  Search,
  Sparkles,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { StatusDot } from "./components/StatusDot";
import { DaemonStatus } from "./components/DaemonStatus";
import { AuthorizedClients } from "./components/AuthorizedClients";
import { DownloadMenu } from "./components/DownloadMenu";
import { OpenWithMenu } from "./components/OpenWithMenu";
import { TransportPicker } from "./components/TransportPicker";
import { BrowserSettings } from "./components/BrowserSettings";
import { getIdeIcon } from "./ide-icons";
import { Markdown } from "./markdown";
import {
  IDE_METADATA,
  MCP_TRANSPORT_DEFAULT,
  type DashboardState,
  type ExtensionSettingsSnapshot,
  type HistoryItem,
  type IdeStatus,
  type IdeTarget,
  type ModelConfigEntry,
  type ModelsConfigResponse,
  type RateLimitResponse,
  type RulesStatus,
  type WebviewMessage,
} from "@perplexity-user-mcp/shared";
import { useDashboardStore } from "./store";

/** Loose send signature — action IDs are injected automatically by App.tsx. */
export type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

export function tierClass(tier: DashboardState["snapshot"]["tier"]): string {
  switch (tier) {
    case "Max":
      return "chip-max";
    case "Pro":
      return "chip-accent";
    case "Enterprise":
      return "chip-pro";
    case "Authenticated":
      return "chip-neutral";
    default:
      return "chip-warn";
  }
}

export function prettifyMode(mode: string): string {
  return mode.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "unknown";
  const delta = Date.now() - t;
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function ModelsSourceBadge({
  source,
  lastUpdated,
  lastTier,
  send,
}: {
  source: DashboardState["snapshot"]["modelsConfigSource"];
  lastUpdated: string | null;
  lastTier: DashboardState["snapshot"]["lastRefreshTier"];
  send: SendFn;
}) {
  const relative = formatRelativeTime(lastUpdated);
  const tierBadge =
    lastTier === "got-scraping"
      ? "via HTTP (got-scraping)"
      : lastTier === "impit"
        ? "via HTTP (impit)"
        : lastTier === "browser"
          ? "via headless browser"
          : null;

  const meta = {
    live: { label: "Live", tone: "chip-pro", detail: `Fetched ${relative}${tierBadge ? ` ${tierBadge}` : ""}` },
    cache: { label: "Cached", tone: "chip-neutral", detail: `From disk ${relative}` },
    fallback: { label: "Offline snapshot", tone: "chip-warn", detail: `Bundled snapshot (${relative}). Login & Refresh to pull live models.` },
    empty: { label: "No data", tone: "chip-danger", detail: "No models cached yet." },
  }[source];

  return (
    <div className="mdl-source-row">
      <div className="mdl-source-meta">
        <span className={`chip mdl-source-chip ${meta.tone}`}>{meta.label}</span>
        <span className="mdl-source-detail">{meta.detail}</span>
      </div>
      <button
        className="ghost-button mdl-source-refresh"
        onClick={() => send({ type: "models:refresh" })}
        title="Fetch /rest/models/config live from Perplexity"
      >
        <RefreshCcw size={12} />
        <span>Fetch live</span>
      </button>
    </div>
  );
}

export function buildModelGroups(
  state: DashboardState | null,
  filter: string,
): Array<{ mode: string; entries: ModelConfigEntry[] }> {
  const config = state?.snapshot.modelsConfig;
  if (!config) {
    return [];
  }

  const normalizedFilter = filter.trim().toLowerCase();
  const groups = new Map<string, ModelConfigEntry[]>();

  for (const entry of config.config) {
    const mode = config.models[entry.non_reasoning_model || entry.reasoning_model || ""]?.mode || "other";
    const searchable = [
      entry.label,
      entry.description,
      entry.subscription_tier,
      entry.non_reasoning_model ?? "",
      entry.reasoning_model ?? "",
    ]
      .join(" ")
      .toLowerCase();

    if (normalizedFilter && !searchable.includes(normalizedFilter)) {
      continue;
    }

    const bucket = groups.get(mode) ?? [];
    bucket.push(entry);
    groups.set(mode, bucket);
  }

  return [...groups.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([mode, entries]) => ({ mode, entries }));
}

/* ═══════════════════════════════════════════════ */
/*  Dashboard View                                 */
/* ═══════════════════════════════════════════════ */

function AuthorizedClientsCard({ send }: { send: SendFn }) {
  const oauthClients = useDashboardStore((store) => store.oauthClients);
  return (
    <AuthorizedClients
      clients={oauthClients ?? []}
      onRevoke={(clientId) =>
        send({
          type: "oauth-clients:revoke",
          id: (typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `oauth-revoke-${Date.now()}`),
          payload: { clientId },
        })
      }
      onRevokeAll={() =>
        send({
          type: "oauth-clients:revoke-all",
          id: (typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `oauth-revoke-all-${Date.now()}`),
        })
      }
    />
  );
}

export function DashboardView({
  state,
  send,
}: {
  state: DashboardState;
  send: SendFn;
}) {
  const snapshot = state.snapshot;
  const activeProfile = useDashboardStore((store) => store.activeProfile);
  const authAction = activeProfile ? { type: "auth:login" as const, label: "Login", title: "Use the active profile's saved login mode." } : { type: "profile:add-prompt" as const, label: "Add account", title: "Create a profile and start sign-in." };
  const recentQueries = state.history.slice(0, 3);
  const rateLimitEntries = Object.entries(snapshot.rateLimits?.modes ?? {}) as Array<
    [string, RateLimitResponse["modes"][string]]
  >;

  return (
    <>
      <div className="glass-panel hero-panel">
        <SectionHeader
          eyebrow="Shared Profile"
          title={snapshot.loggedIn ? "Ready for MCP sessions" : "Login required"}
          detail="Shared browser profile reused by the extension, bundled MCP server, and external IDE configs."
        />
        <div className="flex items-center gap-2">
          <StatusDot variant={snapshot.loggedIn ? "ok" : "off"} decorative />
          <div className="dashboard-status-text">
            {snapshot.loggedIn
              ? "Session active and ready."
              : "Run login once to unlock the server."}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          {!snapshot.loggedIn && (
            <button className="primary-button" onClick={() => send(authAction)} title={authAction.title}>
              <Sparkles size={13} />
              {authAction.label}
            </button>
          )}
          <button
            className="ghost-button"
            onClick={() => send({ type: "configs:generate", payload: { target: "all" } })}
          >
            <HardDriveDownload size={13} />
            Sync All IDEs
          </button>
        </div>
      </div>

      <div className="metric-column">
        <MetricCard label="Computer Mode" value={snapshot.canUseComputer ? "On" : "Off"} />
        <MetricCard
          label="Models"
          value={String(snapshot.modelsConfig ? snapshot.modelsConfig.config.length : 0)}
        />
      </div>

      <DaemonStatus send={send} />

      <AuthorizedClientsCard send={send} />

      <div className="glass-panel section-panel">
        <SectionHeader
          eyebrow="Quick actions"
          title="Controls"
          detail=""
        />
        <div className="flex flex-col gap-2">
          <ActionCard
            icon={RefreshCcw}
            title="Refresh state"
            description="Re-read account data, history, and IDE status."
            onClick={() => send({ type: "dashboard:refresh" })}
          />
          <ActionCard
            icon={Database}
            title="Generate all configs"
            description="Write MCP config to all detected IDEs."
            onClick={() => send({ type: "configs:generate", payload: { target: "all" } })}
          />
          <ActionCard
            icon={Sparkles}
            title={activeProfile ? "Login flow" : "Add account"}
            description={activeProfile ? "Run the active profile's saved login mode." : "Create a profile, choose a mode once, and start sign-in."}
            onClick={() => send(activeProfile ? { type: "auth:login" } : { type: "profile:add-prompt" })}
          />
        </div>
      </div>

      <div className="glass-panel section-panel">
        <SectionHeader
          eyebrow="Rate limits"
          title="Mode availability"
          detail=""
        />
        <div className="flex flex-col gap-2">
          {rateLimitEntries.length === 0 ? (
            <div className="empty-state">No rate limit data cached yet.</div>
          ) : (
            rateLimitEntries.map(([mode, details]) => (
              <div key={mode} className="list-row">
                <div className="rate-limit-main">
                  <div className="rate-limit-title">{prettifyMode(mode)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`chip ${details.available ? "chip-pro" : "chip-danger"}`}>
                    {details.available ? "Available" : "Unavailable"}
                  </span>
                  {details.remaining_detail.kind === "exact" && (
                    <span className="rate-limit-remaining">
                      {details.remaining_detail.remaining ?? 0} left
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="glass-panel section-panel">
        <SectionHeader
          eyebrow="Recent activity"
          title="Latest queries"
          detail=""
        />
        <div className="flex flex-col gap-2">
          {recentQueries.length === 0 ? (
            <div className="empty-state">No queries yet.</div>
          ) : (
            recentQueries.map((item: HistoryItem) => <HistoryCard key={item.id} item={item} />)
          )}
        </div>
      </div>

      <div className="glass-panel section-panel">
        <SectionHeader eyebrow="Storage" title="Profile paths" detail="" />
        <div className="flex flex-col gap-2">
          <PathRow label="Config dir" value={snapshot.configDir} />
          <PathRow label="Browser profile" value={snapshot.browserProfileDir} />
          <PathRow label="Last refresh" value={snapshot.lastUpdated ?? "Not cached"} />
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════ */
/*  Models View                                    */
/* ═══════════════════════════════════════════════ */

interface ModelOption {
  id: string;
  label: string;
  tier: string;
  mode: string;
  /** True when this option came from the reasoning_model slot of a config entry. */
  isReasoning: boolean;
}

interface ToolModelConfig {
  key: string;
  label: string;
  description: string;
  settingKey: keyof DashboardState["settings"];
  /** Returns true when the model is compatible with this tool's purpose. */
  matches: (opt: ModelOption) => boolean;
  defaultValue: string;
}

/**
 * Tool↔model matching is by *semantic role*, not by the raw `mode` field from
 * the API. In the current Perplexity API, reasoning variants (e.g.
 * `claude46sonnetthinking`) have `mode: "search"` just like their non-reasoning
 * siblings — they only differ in whether they come from the `reasoning_model`
 * or `non_reasoning_model` slot of a config entry.
 */
const TOOL_MODEL_CONFIGS: ToolModelConfig[] = [
  {
    key: "search",
    label: "Search",
    description: "Web search with citations (perplexity_search, perplexity_ask)",
    settingKey: "defaultSearchModel",
    matches: (opt) => opt.mode === "search" && !opt.isReasoning,
    defaultValue: "pplx_pro",
  },
  {
    key: "reason",
    label: "Reasoning",
    description: "Multi-step analysis and explanation (perplexity_reason)",
    settingKey: "reasonModel",
    // Reasoning tool accepts both explicit reasoning variants AND the base
    // `search` models (because the backend will still reason with them, just
    // with less thinking). Priority goes to explicit reasoning variants in the UI.
    matches: (opt) => opt.mode === "search",
    defaultValue: "claude46sonnetthinking",
  },
  {
    key: "research",
    label: "Deep Research",
    description: "Long-form research reports (perplexity_research)",
    settingKey: "researchModel",
    matches: (opt) => opt.mode === "research" || opt.mode === "agentic_research",
    defaultValue: "pplx_alpha",
  },
  {
    key: "compute",
    label: "Computer / ASI",
    description: "Advanced reasoning with code execution (perplexity_compute)",
    settingKey: "computeModel",
    matches: (opt) => opt.mode === "asi",
    defaultValue: "pplx_asi",
  },
];

function getModelOptions(config: ModelsConfigResponse | null | undefined): ModelOption[] {
  if (!config) return [];
  const options: ModelOption[] = [];
  for (const entry of config.config) {
    const baseId = entry.non_reasoning_model;
    if (baseId) {
      const info = config.models[baseId];
      options.push({
        id: baseId,
        label: entry.label,
        tier: entry.subscription_tier,
        mode: info?.mode ?? "other",
        isReasoning: false,
      });
    }
    // Reasoning variant when it's distinct from the non-reasoning model.
    if (entry.reasoning_model && entry.reasoning_model !== entry.non_reasoning_model) {
      const rInfo = config.models[entry.reasoning_model];
      options.push({
        id: entry.reasoning_model,
        label: `${entry.label} (reasoning)`,
        tier: entry.subscription_tier,
        mode: rInfo?.mode ?? "other",
        isReasoning: true,
      });
    }
  }
  return options;
}

export function ModelsView({
  filter,
  setFilter,
  groups,
  state,
  send,
}: {
  filter: string;
  setFilter: (value: string) => void;
  groups: Array<{ mode: string; entries: ModelConfigEntry[] }>;
  state: DashboardState;
  send: SendFn;
}) {
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<string | null>(null);

  const modelsConfig = state.snapshot.modelsConfig;
  const allOptions = getModelOptions(modelsConfig);
  const totalModels = modelsConfig?.config.length ?? 0;
  const modeSet = new Set(allOptions.map(o => o.mode));
  const modes = [...modeSet].sort();

  // Filter groups by active mode tab
  const filteredGroups = activeMode
    ? groups.filter(g => g.mode === activeMode)
    : groups;

  return (
    <div className="grid gap-3">
      {/* ── Tool Model Configuration ── */}
      <div className="glass-panel section-panel">
        <SectionHeader
          eyebrow="Model configuration"
          title="Default models per tool"
          detail="Select which model each Perplexity tool uses by default. Agents can still override per-request."
        />
        <div className="flex flex-col gap-2">
          {TOOL_MODEL_CONFIGS.map((toolCfg) => {
            const currentValue = state.settings[toolCfg.settingKey] as string;
            const matching = allOptions.filter(toolCfg.matches);
            // Split recommended into "non-reasoning first" and "reasoning last"
            // so the default for Search shows non-thinking variants first, and
            // Reasoning shows thinking variants first.
            const sortedMatching =
              toolCfg.key === "reason"
                ? [...matching].sort((a, b) => Number(b.isReasoning) - Number(a.isReasoning))
                : matching;
            const currentInList = matching.some((o) => o.id === currentValue);

            return (
              <div key={toolCfg.key} className="mdl-tool-row">
                <div className="mdl-tool-info">
                  <div className="mdl-tool-label">{toolCfg.label}</div>
                  <div className="mdl-tool-desc">{toolCfg.description}</div>
                </div>
                <select
                  className="mdl-tool-select"
                  value={currentValue || toolCfg.defaultValue}
                  onChange={(e) => {
                    send({ type: "settings:update", payload: { [toolCfg.settingKey]: e.target.value } });
                  }}
                >
                  {sortedMatching.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label} [{opt.tier}]
                    </option>
                  ))}
                  {/* Preserve legacy / custom value so we don't silently overwrite user selection. */}
                  {currentValue && !currentInList && (
                    <option value={currentValue}>{currentValue} (custom)</option>
                  )}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Stats + data-source indicator ── */}
      <div className="glass-panel section-panel">
        <div className="hist-stats-row">
          <div className="hist-stat">
            <span className="hist-stat-value">{totalModels}</span>
            <span className="hist-stat-label">models</span>
          </div>
          <div className="hist-stat">
            <span className="hist-stat-value">{modes.length}</span>
            <span className="hist-stat-label">modes</span>
          </div>
          <div className="hist-stat">
            <span className="hist-stat-value">{state.snapshot.tier}</span>
            <span className="hist-stat-label">tier</span>
          </div>
        </div>
        <ModelsSourceBadge
          source={state.snapshot.modelsConfigSource}
          lastUpdated={state.snapshot.lastUpdated}
          lastTier={state.snapshot.lastRefreshTier}
          send={send}
        />
      </div>

      {/* ── Mode filter tabs + search ── */}
      <div className="glass-panel section-panel">
        <SectionHeader
          eyebrow="Model browser"
          title="Available models"
          detail=""
        />
        <div className="flex items-center gap-2 mb-2">
          <div className="search-field">
            <Search size={14} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter models..." />
          </div>
        </div>
        {modes.length > 1 && (
          <div className="mdl-mode-tabs">
            <button
              className={`mdl-mode-tab ${activeMode === null ? "mdl-mode-tab-active" : ""}`}
              onClick={() => setActiveMode(null)}
            >
              All
            </button>
            {modes.map(mode => (
              <button
                key={mode}
                className={`mdl-mode-tab ${activeMode === mode ? "mdl-mode-tab-active" : ""}`}
                onClick={() => setActiveMode(prev => prev === mode ? null : mode)}
              >
                {prettifyMode(mode)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Model cards ── */}
      <div className="flex flex-col gap-2">
        {filteredGroups.length === 0 ? (
          <div className="glass-panel section-panel">
            <div className="empty-state">No models match filter.</div>
          </div>
        ) : (
          filteredGroups.map((group) => (
            <div key={group.mode} className="glass-panel section-panel">
              <div className="mdl-group-header">
                <span className="mdl-group-mode">{prettifyMode(group.mode)}</span>
                <span className="mdl-group-count">{group.entries.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {group.entries.map((entry) => {
                  const modelId = entry.non_reasoning_model || entry.reasoning_model || "";
                  const isExpanded = expandedModel === `${group.mode}-${modelId}`;
                  const info = modelsConfig?.models[modelId];
                  const entryVariantIds = [entry.non_reasoning_model, entry.reasoning_model].filter(
                    (id): id is string => !!id,
                  );
                  const isDefault = TOOL_MODEL_CONFIGS.some((tc) =>
                    entryVariantIds.includes(state.settings[tc.settingKey] as string),
                  );
                  return (
                    <button
                      key={`${group.mode}-${entry.label}`}
                      className={`mdl-card${isExpanded ? " mdl-card-expanded" : ""}${isDefault ? " mdl-card-active" : ""}`}
                      onClick={() => setExpandedModel(
                        isExpanded ? null : `${group.mode}-${modelId}`
                      )}
                    >
                      <div className="mdl-card-top">
                        <div className="mdl-card-name">
                          {entry.label}
                          {entry.has_new_tag && <span className="chip chip-accent mdl-chip-new">NEW</span>}
                        </div>
                        <div className="mdl-card-badges">
                          {isDefault && <span className="chip chip-pro mdl-chip-tiny">DEFAULT</span>}
                          <span className={`chip ${entry.subscription_tier === "max" ? "chip-max" : entry.subscription_tier === "pro" ? "chip-pro" : "chip-neutral"}`}>
                            {entry.subscription_tier}
                          </span>
                        </div>
                      </div>
                      {!isExpanded && (
                        <div className="mdl-card-desc-short">{entry.description}</div>
                      )}
                      {isExpanded && (
                        <div className="mdl-card-detail">
                          <div className="mdl-card-desc">{entry.description}</div>
                          {entry.subheading && (
                            <div className="mdl-card-sub">{entry.subheading}</div>
                          )}
                          <div className="flex flex-wrap gap-1 mt-2">
                            {entry.non_reasoning_model && (
                              <code className="code-pill">{entry.non_reasoning_model}</code>
                            )}
                            {entry.reasoning_model && entry.reasoning_model !== entry.non_reasoning_model && (
                              <code className="code-pill">{entry.reasoning_model} (reasoning)</code>
                            )}
                          </div>
                          <div className="mdl-card-meta">
                            {info?.provider && <span>Provider: {info.provider}</span>}
                            <span>Mode: {prettifyMode(info?.mode ?? group.mode)}</span>
                            {entry.text_only_model && <span>Text only</span>}
                          </div>
                          {/* Quick-assign buttons (per-model, one per matching tool) */}
                          {(() => {
                            const rInfo = entry.reasoning_model ? modelsConfig?.models[entry.reasoning_model] : undefined;
                            const nrInfo = entry.non_reasoning_model ? modelsConfig?.models[entry.non_reasoning_model] : undefined;
                            // The card represents the config entry. A single entry may
                            // contain both a reasoning and non-reasoning variant; quick-
                            // assign should apply to whichever variant fits the tool.
                            const variants: ModelOption[] = [];
                            if (entry.non_reasoning_model) {
                              variants.push({
                                id: entry.non_reasoning_model,
                                label: entry.label,
                                tier: entry.subscription_tier,
                                mode: nrInfo?.mode ?? group.mode,
                                isReasoning: false,
                              });
                            }
                            if (entry.reasoning_model && entry.reasoning_model !== entry.non_reasoning_model) {
                              variants.push({
                                id: entry.reasoning_model,
                                label: `${entry.label} (reasoning)`,
                                tier: entry.subscription_tier,
                                mode: rInfo?.mode ?? group.mode,
                                isReasoning: true,
                              });
                            }

                            const toolMatches = TOOL_MODEL_CONFIGS.flatMap((tc) =>
                              variants
                                .filter((v) => tc.matches(v))
                                .map((v) => ({ tc, variantId: v.id, variantLabel: v.isReasoning ? "reasoning" : "base" }))
                            );

                            if (toolMatches.length === 0) {
                              return (
                                <div className="mdl-card-assign">
                                  <div className="mdl-card-note">
                                    Not used by any Perplexity MCP tool — this mode (
                                    {prettifyMode(group.mode)}) is shown for reference only.
                                  </div>
                                </div>
                              );
                            }

                            return (
                              <div className="mdl-card-assign">
                                {toolMatches.map(({ tc, variantId, variantLabel }) => {
                                  const isCurrent = (state.settings[tc.settingKey] as string) === variantId;
                                  const showVariantBadge = variants.length > 1;
                                  return (
                                    <button
                                      key={`${tc.key}-${variantId}`}
                                      className={`mdl-assign-btn${isCurrent ? " mdl-assign-active" : ""}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (!isCurrent) {
                                          send({ type: "settings:update", payload: { [tc.settingKey]: variantId } });
                                        }
                                      }}
                                      disabled={isCurrent}
                                    >
                                      {isCurrent ? <Check size={10} /> : null}
                                      {isCurrent
                                        ? `Default for ${tc.label}${showVariantBadge ? ` (${variantLabel})` : ""}`
                                        : `Set as ${tc.label} default${showVariantBadge ? ` (${variantLabel})` : ""}`}
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════ */
/*  History View                                   */
/* ═══════════════════════════════════════════════ */

const TOOL_COLORS: Record<string, string> = {
  perplexity_search: "chip-accent",
  perplexity_reason: "chip-pro",
  perplexity_research: "chip-max",
  perplexity_ask: "chip-neutral",
  perplexity_compute: "chip-warn",
};

function getToolChipClass(tool: string): string {
  return TOOL_COLORS[tool] ?? "chip-muted";
}

function shortToolName(tool: string): string {
  return tool.replace("perplexity_", "");
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function CloudSyncBar({ send }: { send: SendFn }) {
  const cloudSync = useDashboardStore((s) => s.cloudSync);
  const inFlight = cloudSync.phase === "starting" || cloudSync.phase === "syncing";
  return (
    <div className="hist-cloud-sync-row">
      <button
        className="ghost-button btn-sm hist-cloud-sync-button"
        onClick={() => { if (!inFlight) send({ type: "history:cloud-sync" }); }}
        disabled={inFlight}
        title="Fetch all Perplexity.ai threads and merge into local history. Never deletes local-only entries."
      >
        <RefreshCcw size={13} />
        <span className="hist-cloud-sync-button-label">{inFlight ? "Syncing from cloud…" : "Sync from Cloud"}</span>
      </button>
      {inFlight ? (
        <span className="hist-cloud-sync-note">
          Fetched {cloudSync.fetched ?? 0}
          {cloudSync.inserted ? ` · ${cloudSync.inserted} new` : ""}
          {cloudSync.updated ? ` · ${cloudSync.updated} updated` : ""}
        </span>
      ) : cloudSync.phase === "done" ? (
        <span className="hist-cloud-sync-note">
          Last sync: {cloudSync.inserted ?? 0} new · {cloudSync.updated ?? 0} updated · {cloudSync.skipped ?? 0} unchanged
        </span>
      ) : cloudSync.phase === "error" ? (
        <span className="hist-cloud-sync-error">Error: {cloudSync.error}</span>
      ) : null}
    </div>
  );
}

export function HistoryView({
  filter,
  setFilter,
  items,
  totalCount,
  send,
}: {
  filter: string;
  setFilter: (value: string) => void;
  items: HistoryItem[];
  totalCount: number;
  send: SendFn;
}) {
  const sortNewest = useDashboardStore((s) => s.historySortNewest);
  const setSortNewest = useDashboardStore((s) => s.setHistorySortNewest);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sorted = sortNewest ? items : [...items].reverse();

  // Stats
  const toolCounts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.tool] = (acc[item.tool] ?? 0) + 1;
    return acc;
  }, {});

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const requestedRef = useRef(false);
  useEffect(() => {
    if (!requestedRef.current) {
      requestedRef.current = true;
      send({ type: "history:request-list" });
      send({ type: "viewers:request-list" });
    }
  }, [send]);

  return (
    <div className="grid gap-3">
      {/* Stats bar */}
      <div className="glass-panel section-panel">
        <SectionHeader eyebrow="Activity log" title="Query History" detail="" />
        <div className="hist-stats-row">
          <div className="hist-stat">
            <span className="hist-stat-icon"><Database size={12} /></span>
            <span className="hist-stat-value">{totalCount}</span>
            <span className="hist-stat-label">total</span>
          </div>
          {filter.trim() && (
            <div className="hist-stat hist-stat-matching">
              <span className="hist-stat-icon"><ListFilter size={12} /></span>
              <span className="hist-stat-value">{items.length}</span>
              <span className="hist-stat-label">matching</span>
            </div>
          )}
          <div className="hist-stat hist-stat-cloud">
            <span className="hist-stat-icon"><Cloud size={12} /></span>
            <span className="hist-stat-value">{items.filter(i => i.source === "cloud").length}</span>
            <span className="hist-stat-label">cloud</span>
          </div>
          <div className="hist-stat hist-stat-sources">
            <span className="hist-stat-icon"><LinkIcon size={12} /></span>
            <span className="hist-stat-value">{items.reduce((s, i) => s + i.sourceCount, 0)}</span>
            <span className="hist-stat-label">sources</span>
          </div>
        </div>
        {Object.keys(toolCounts).length > 1 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).map(([tool, count]) => (
              <span key={tool} className={`chip hist-chip-tool-count ${getToolChipClass(tool)}`}>
                {shortToolName(tool)} ({count})
              </span>
            ))}
          </div>
        )}
        <CloudSyncBar send={send} />
      </div>

      {/* Search + sort controls */}
      <div className="glass-panel section-panel">
        <div className="history-control-row">
          <div className="search-field">
            <Search size={14} />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search queries, tools, answers..."
              dir="auto"
            />
          </div>
          <button
            className="ghost-button btn-sm hist-control-button"
            onClick={() => send({ type: "history:rebuild-index" })}
            title="Re-scan markdown entries and rebuild the history index"
          >
            <RefreshCcw size={13} />
            <span className="hist-control-label">Rebuild</span>
          </button>
          <button
            className="ghost-button btn-sm hist-control-button"
            onClick={() => setSortNewest(!sortNewest)}
            title={sortNewest ? "Showing newest first" : "Showing oldest first"}
          >
            {sortNewest ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
            <span className="hist-control-label">{sortNewest ? "Newest" : "Oldest"}</span>
          </button>
        </div>
      </div>

      {/* History cards */}
      <div className="flex flex-col gap-2">
        {sorted.length === 0 ? (
          <div className="glass-panel section-panel">
            <div className="empty-state">
              {filter ? "No entries match your search." : "No queries recorded yet. Use any Perplexity tool to get started."}
            </div>
          </div>
        ) : (
          sorted.map((item) => (
            <HistoryCardRich
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggle={toggleExpand}
              send={send}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════ */
/*  Settings View (full IDE management)            */
/* ═══════════════════════════════════════════════ */

const KNOWN_MODELS = [
  { value: "pplx_pro", label: "Pro (pplx_pro)" },
  { value: "pplx_alpha", label: "Alpha / Research (pplx_alpha)" },
  { value: "default", label: "Default" },
];

function SpeedBoostCard({ state, send }: { state: DashboardState; send: SendFn }) {
  const boost = state.snapshot.speedBoost;
  const installedAtRel = boost.installedAt ? formatRelativeTime(boost.installedAt) : null;

  return (
    <div className="glass-panel section-panel">
      <SectionHeader
        eyebrow="Optional"
        title="Speed Boost (impit)"
        detail="Optional Rust-backed TLS impersonation library. Adds a fast HTTP tier ahead of the headless-browser fallback — refresh drops from ~3-5s to ~300-500ms. Installed on demand, not bundled with the extension."
      />

      <div className="speed-boost-status-row">
        <Rocket size={14} className="text-[var(--text-muted)]" />
        {boost.installed ? (
          <>
            <span className="chip chip-pro speed-boost-chip">
              Installed
            </span>
            {boost.version ? (
              <span className="speed-boost-meta">
                impit {boost.version}
              </span>
            ) : null}
            {installedAtRel ? (
              <span className="speed-boost-meta">
                · installed {installedAtRel}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="chip chip-neutral speed-boost-chip">
              Not installed
            </span>
            <span className="speed-boost-meta">
              Refresh will use headless browser (works fine, just slower).
            </span>
          </>
        )}
      </div>

      {boost.installed ? (
        <button
          className="ghost-button btn-full"
          onClick={() => send({ type: "speed-boost:uninstall" })}
          title={`Remove ${boost.runtimeDir}`}
        >
          <Trash2 size={13} />
          Uninstall
        </button>
      ) : (
        <button
          className="primary-button btn-full"
          onClick={() => send({ type: "speed-boost:install" })}
          title="Runs npm install in ~/.perplexity-mcp/native-deps. Requires npm on PATH."
        >
          <Rocket size={13} />
          Install Speed Boost
        </button>
      )}
    </div>
  );
}

export function SettingsView({
  state,
  send,
}: {
  state: DashboardState;
  send: SendFn;
}) {
  const settings = state.settings;
  const authState = useDashboardStore((store) => store.authState);
  const staleConfigs = useDashboardStore((store) => store.staleConfigs);
  const staleIdeTags = new Set((staleConfigs ?? []).map((s) => s.ideTag));
  const ideEntries = Object.entries(state.ideStatus) as Array<[string, IdeStatus]>;
  const autoConfigurable = ideEntries.filter(([, s]) => s.autoConfigurable);
  const manualOnly = ideEntries.filter(([, s]) => !s.autoConfigurable);

  return (
    <div className="grid gap-3">
      <BrowserSettings auth={authState} send={send} />
      <SpeedBoostCard state={state} send={send} />

      <div className="glass-panel section-panel">
        <SectionHeader
          eyebrow="Auto-configurable IDEs"
          title="MCP config management"
          detail="Additive writes — existing MCP servers and settings are never removed."
        />
        {staleConfigs && staleConfigs.length > 0 ? (
          <div className="stale-config-banner" data-testid="stale-configs-banner">
            <span>
              {staleConfigs.length} config{staleConfigs.length === 1 ? "" : "s"} contain{staleConfigs.length === 1 ? "s" : ""} stale auth
            </span>
            <button
              className="ghost-button btn-sm"
              onClick={() => send({ type: "transport:regenerate-stale" })}
            >
              Regenerate all
            </button>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          {autoConfigurable.map(([key, status]) => (
            <IdeCard
              key={key}
              ideKey={key}
              status={status}
              settings={settings}
              isStale={staleIdeTags.has(key)}
              send={send}
            />
          ))}
        </div>
        <button
          className="primary-button btn-full mt-2"
          onClick={() => send({ type: "configs:generate", payload: { target: "all" } })}
        >
          <HardDriveDownload size={13} />
          Configure All Detected
        </button>
      </div>

      {manualOnly.length > 0 && (
        <div className="glass-panel section-panel">
          <SectionHeader
            eyebrow="Detect-only IDEs"
            title="Manual configuration"
            detail="These IDEs use TOML, YAML, or UI-only config. Detection shown below."
          />
          <div className="flex flex-col gap-2">
            {manualOnly.map(([key, status]) => {
              const ManualIcon = getIdeIcon(key);
              return (
                <div key={key} className={`ide-card${POPULAR_IDES.has(key) ? " ide-card-popular" : ""}`}>
                  <div className="ide-card-header">
                    <span className="ide-card-name ide-card-name-icon">
                      <ManualIcon />
                      {status.displayName}
                    </span>
                    <span className={`chip ${status.detected ? "chip-neutral" : "chip-muted"}`}>
                      {status.detected ? "Detected" : "Not found"}
                    </span>
                  </div>
                  <div className="ide-card-path-wrap">{status.path}</div>
                  <div className="ide-card-config-note">
                    Config format: {status.configFormat} — configure manually
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="glass-panel section-panel">
        <SectionHeader
          eyebrow="Auto-sync toggles"
          title="Startup behavior"
          detail="When enabled, MCP config is written automatically on extension activation."
        />
        <div className="flex flex-col gap-1">
          <SettingToggle
            label="Cursor"
            checked={settings.autoConfigureCursor}
            onChange={(v) => send({ type: "settings:update", payload: { autoConfigureCursor: v } })}
          />
          <SettingToggle
            label="Windsurf"
            checked={settings.autoConfigureWindsurf}
            onChange={(v) => send({ type: "settings:update", payload: { autoConfigureWindsurf: v } })}
          />
          <SettingToggle
            label="Windsurf Next"
            checked={settings.autoConfigureWindsurfNext}
            onChange={(v) => send({ type: "settings:update", payload: { autoConfigureWindsurfNext: v } })}
          />
          <SettingToggle
            label="Claude Desktop"
            checked={settings.autoConfigureClaudeDesktop}
            onChange={(v) => send({ type: "settings:update", payload: { autoConfigureClaudeDesktop: v } })}
          />
          <SettingToggle
            label="Claude Code"
            checked={settings.autoConfigureClaudeCode}
            onChange={(v) => send({ type: "settings:update", payload: { autoConfigureClaudeCode: v } })}
          />
          <SettingToggle
            label="Cline"
            checked={settings.autoConfigureCline}
            onChange={(v) => send({ type: "settings:update", payload: { autoConfigureCline: v } })}
          />
          <SettingToggle
            label="Amp"
            checked={settings.autoConfigureAmp}
            onChange={(v) => send({ type: "settings:update", payload: { autoConfigureAmp: v } })}
          />
          <SettingToggle
            label="Codex CLI"
            checked={settings.autoConfigureCodexCli}
            onChange={(v) => send({ type: "settings:update", payload: { autoConfigureCodexCli: v } })}
          />
        </div>
      </div>

      <div className="glass-panel section-panel">
        <SectionHeader
          eyebrow="Server settings"
          title="Configuration"
          detail="Changes sync to VS Code settings automatically."
        />
        <div className="flex flex-col gap-2">
          <div className="setting-row">
            <div className="setting-row-label">Default Search Model</div>
            <select
              className="setting-select"
              value={settings.defaultSearchModel}
              onChange={(e) => send({ type: "settings:update", payload: { defaultSearchModel: e.target.value } })}
            >
              {KNOWN_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
              {!KNOWN_MODELS.some((m) => m.value === settings.defaultSearchModel) && (
                <option value={settings.defaultSearchModel}>{settings.defaultSearchModel}</option>
              )}
            </select>
            <div className="setting-row-hint">Model used by perplexity_search and perplexity_ask tools.</div>
          </div>

          {/* Chrome Path input moved to the BrowserSettings picker at the top
              of this tab (0.8.x browser-runtime expansion). That component
              owns channel selection, bundled-Chromium install/remove, and
              custom-executable selection via the native VS Code file picker. */}

          <SettingToggle
            label="Debug Mode"
            checked={settings.debugMode}
            onChange={(v) => send({ type: "settings:update", payload: { debugMode: v } })}
          />
          <div className="settings-debug-note">
            Enable verbose logging in Output → Perplexity MCP.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════ */
/*  Rules View (Perplexity rules/guides)           */
/* ═══════════════════════════════════════════════ */

export function RulesView({
  state,
  send,
}: {
  state: DashboardState;
  send: SendFn;
}) {
  const rules = state.rulesStatus ?? [];

  return (
    <div className="grid gap-3">
      <div className="glass-panel section-panel">
        <SectionHeader
          eyebrow="Perplexity Rules"
          title="AI IDE rules & guides"
          detail="Sync Perplexity MCP usage guidelines to each IDE's rules format. Additive only — never removes your existing rules."
        />
        <button
          className="primary-button btn-full"
          onClick={() => send({ type: "rules:sync", payload: { target: "all" } })}
        >
          <BookOpen size={13} />
          Sync Rules to All IDEs
        </button>
      </div>

      {rules.length === 0 ? (
        <div className="glass-panel section-panel">
          <div className="empty-state">Open a workspace folder to manage rules.</div>
        </div>
      ) : (
        <div className="glass-panel section-panel">
          <SectionHeader
            eyebrow="Per-IDE status"
            title="Rules files"
            detail=""
          />
          <div className="flex flex-col gap-2">
            {rules.map((rule) => (
              <RulesCard key={rule.ide} rule={rule} send={send} />
            ))}
          </div>
        </div>
      )}

      <div className="glass-panel section-panel">
        <SectionHeader
          eyebrow="What gets written"
          title="Rules content"
          detail=""
        />
        <div className="rules-content-copy">
          <p>Each IDE gets Perplexity MCP tool descriptions and usage guidelines in its native format:</p>
          <ul className="list-disc rules-content-list">
            <li><strong>Cursor</strong> — <code className="code-pill">.cursor/rules/perplexity-mcp.mdc</code></li>
            <li><strong>Windsurf</strong> — <code className="code-pill">.windsurf/rules/perplexity-mcp.md</code></li>
            <li><strong>Claude Code</strong> — section in <code className="code-pill">CLAUDE.md</code></li>
            <li><strong>Codex / Amp</strong> — section in <code className="code-pill">AGENTS.md</code></li>
            <li><strong>Copilot</strong> — <code className="code-pill">.github/instructions/</code></li>
            <li><strong>Gemini</strong> — section in <code className="code-pill">GEMINI.md</code></li>
            <li><strong>Cline / Roo / Augment</strong> — dedicated rule files</li>
          </ul>
          <p>Files using section markers (<code className="code-pill">&lt;!-- PERPLEXITY-MCP-START --&gt;</code>) only update the Perplexity section.</p>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════ */
/*  Shared Components                              */
/* ═══════════════════════════════════════════════ */

function SectionHeader({
  eyebrow,
  title,
  detail,
}: {
  eyebrow: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="section-header">
      <div className="eyebrow">{eyebrow}</div>
      <div className="title">{title}</div>
      {detail && <div className="detail">{detail}</div>}
    </div>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="toolbar-row">
      <div className="search-field">
        <Search size={14} />
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-panel metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function ActionCard({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button className="action-card" onClick={onClick}>
      <div className="icon-badge">
        <Icon size={13} />
      </div>
      <div className="action-card-body">
        <div className="action-card-title">{title}</div>
        <div className="action-card-desc">{description}</div>
      </div>
    </button>
  );
}

const POPULAR_IDES = new Set(["cursor", "claudeDesktop", "claudeCode", "codexCli", "copilot"]);

function IdeCard({
  ideKey,
  status,
  settings,
  isStale,
  send,
}: {
  ideKey: string;
  status: IdeStatus;
  settings: ExtensionSettingsSnapshot;
  isStale?: boolean;
  send: SendFn;
}) {
  const IconComponent = getIdeIcon(ideKey);
  const isPopular = POPULAR_IDES.has(ideKey);
  // Phase 8.6.5: per-IDE transport. IDE_METADATA is the authoritative source
  // for capabilities; fallback to an empty caps object if the key isn't known
  // (defensive — unknown IDE tags shouldn't crash the card).
  const ideMeta = IDE_METADATA[ideKey];
  const capabilities = ideMeta?.capabilities ?? {
    stdio: false,
    httpBearerLoopback: false,
    httpOAuthLoopback: false,
    httpOAuthTunnel: false,
  };
  const selectedTransport = settings.mcpTransportByIde[ideKey] ?? MCP_TRANSPORT_DEFAULT;
  return (
    <div className={`ide-card${isPopular ? " ide-card-popular" : ""}`}>
      <div className="ide-card-header">
        <span className="ide-card-name ide-card-name-icon">
          <IconComponent />
          {status.displayName}
          {isStale ? (
            <span className="chip chip-warn" data-testid={`ide-stale-chip-${ideKey}`}>
              Stale
            </span>
          ) : null}
        </span>
        <span className={`chip ${status.configured ? "chip-pro" : status.detected ? "chip-warn" : "chip-muted"}`}>
          {status.configured ? (
            <><Check size={10} /> Active</>
          ) : status.detected ? (
            "Detected"
          ) : (
            "Not found"
          )}
        </span>
      </div>
      <div className="ide-card-path-wrap" title={status.path}>{status.path}</div>
      <TransportPicker
        ideTag={ideKey}
        ideDisplayName={status.displayName}
        capabilities={capabilities}
        selected={selectedTransport}
        tunnelsEnabled={settings.enableTunnels}
        send={send}
      />
      <div className="ide-card-actions">
        {!status.configured ? (
          <button
            className="ghost-button btn-sm"
            onClick={() => send({ type: "configs:generate", payload: { target: ideKey as IdeTarget } })}
          >
            <Plus size={11} /> Configure
          </button>
        ) : (
          <>
            <button
              className="ghost-button btn-sm"
              onClick={() => send({ type: "configs:generate", payload: { target: ideKey as IdeTarget } })}
            >
              <RefreshCcw size={11} /> Update
            </button>
            <button
              className="danger-button btn-sm"
              onClick={() => send({ type: "configs:remove", payload: { target: ideKey as IdeTarget } })}
            >
              <Minus size={11} /> Remove
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function RulesCard({
  rule,
  send,
}: {
  rule: RulesStatus;
  send: SendFn;
}) {
  return (
    <div className="ide-card">
      <div className="ide-card-header">
        <span className="ide-card-name">
          <FileCode2 size={12} className="inline mr-1 opacity-60" />
          {prettifyMode(rule.ide)}
        </span>
        <span className={`chip ${rule.hasPerplexitySection ? "chip-pro" : "chip-muted"}`}>
          {rule.hasPerplexitySection ? (
            <><Check size={10} /> Synced</>
          ) : (
            "Not synced"
          )}
        </span>
      </div>
      <div className="ide-card-path" title={rule.rulesPath}>{rule.rulesPath}</div>
      <div className="ide-card-actions">
        <button
          className="ghost-button btn-sm"
          onClick={() => send({ type: "rules:sync", payload: { target: rule.ide } })}
        >
          <Plus size={11} /> {rule.hasPerplexitySection ? "Update" : "Sync"}
        </button>
        {rule.hasPerplexitySection && (
          <button
            className="danger-button btn-sm"
            onClick={() => send({ type: "rules:remove", payload: { target: rule.ide } })}
          >
            <Trash2 size={11} /> Remove
          </button>
        )}
      </div>
    </div>
  );
}

function HistoryCardRich({
  item,
  expanded,
  onToggle,
  send,
}: {
  item: HistoryItem;
  expanded: boolean;
  onToggle: (id: string) => void;
  send: SendFn;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const viewers = useDashboardStore((store) => store.externalViewers);

  const copyToClipboard = useCallback((text: string, label: string) => {
    const doCopy = () => {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    };
    navigator.clipboard.writeText(text).then(doCopy).catch(() => {
      // Fallback for VS Code webviews where navigator.clipboard may be unavailable
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand("copy")) doCopy();
      } catch {
        /* silently fail */
      }
      document.body.removeChild(ta);
    });
  }, []);

  const threadSlug = item.threadUrl?.split("/search/")[1] ?? null;

  const recoverPrompt = threadSlug
    ? `Use the perplexity_retrieve tool with thread_slug: "${threadSlug}" to recover the full results from this Perplexity thread.`
    : null;

  const rerunPrompt = `Use the ${item.tool} tool with query: "${item.query}"${item.model ? ` and model: "${item.model}"` : ""} to run this search again.`;

  const hasError = !!item.error;

  return (
    <div className={`glass-panel hist-card${expanded ? " hist-card-expanded" : ""}${hasError ? " hist-card-error" : ""}`}>
      {/* Header row: click to expand */}
      <button className="hist-card-header" onClick={() => onToggle(item.id)} aria-expanded={expanded}>
        <div className="hist-card-top">
          <span className={`chip hist-chip-tool ${getToolChipClass(item.tool)}`}>
            {shortToolName(item.tool)}
          </span>
          {item.model && (
            <span className="chip chip-muted hist-chip-model">{item.model}</span>
          )}
          {item.tier ? (
            <span className="chip chip-accent hist-chip-model">{item.tier}</span>
          ) : null}
          {item.pinned ? (
            <span className="chip chip-pro hist-chip-model">
              <Pin size={10} />
              Pinned
            </span>
          ) : null}
          {item.source === "cloud" ? (
            <span className="chip chip-accent hist-chip-model">
              <Cloud size={10} />
              Cloud
            </span>
          ) : null}
          {item.status && item.status !== "completed" ? (
            <span
              className={`hist-status-dot hist-status-dot-${item.status}`}
              aria-label={`status: ${item.status}`}
              title={`status: ${prettifyMode(item.status)}`}
            />
          ) : null}
          <span className="hist-time" title={new Date(item.createdAt).toLocaleString()}>
            <Clock size={10} />
            {relativeTime(item.createdAt)}
          </span>
          <span className="hist-expand-icon" aria-hidden="true">
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </span>
        </div>
        <div className="hist-card-query" dir="auto">{item.query}</div>
      </button>

      {/* Collapsed preview */}
      {!expanded && (
        <div className="hist-card-preview" dir="auto">
          <Markdown content={item.answerPreview} maxLines={4} />
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <div className="hist-card-body">
          {/* Answer section */}
          <div className="hist-card-section-label">
            <FileText size={10} />
            Answer preview
          </div>
          <div className="hist-card-answer" dir="auto">
            <Markdown content={item.answerPreview} />
          </div>

          {/* Metadata row */}
          <div className="hist-meta-row">
            {item.sourceCount > 0 && (
              <span className="hist-meta-item">
                <LinkIcon size={11} />
                <strong>{item.sourceCount}</strong> sources
              </span>
            )}
            {item.mode && (
              <span className="hist-meta-item">
                <Hash size={11} />
                mode: <strong>{item.mode}</strong>
              </span>
            )}
            {item.status && (
              <span className="hist-meta-item">
                <span
                  className={`hist-status-dot hist-status-dot-${item.status}`}
                  aria-hidden="true"
                />
                <strong>{prettifyMode(item.status)}</strong>
              </span>
            )}
            {item.language && item.language !== "en-US" && (
              <span className="hist-meta-item">
                <Globe size={11} />
                {item.language}
              </span>
            )}
            <span className="hist-meta-item hist-meta-time">
              <Clock size={11} />
              {new Date(item.createdAt).toLocaleString()}
            </span>
          </div>

          {/* Action buttons */}
          <div className="hist-card-section-label">
            <Sparkles size={10} />
            Actions
          </div>
          <div className="hist-actions">
            {/* Group 1: Clipboard (primary) */}
            {recoverPrompt && (
              <button
                className="hist-action-btn hist-action-primary"
                onClick={() => copyToClipboard(recoverPrompt, "recover")}
                title="Copy a prompt that tells AI to retrieve this thread's results"
              >
                {copied === "recover" ? <ClipboardCheck size={12} /> : <RotateCcw size={12} />}
                {copied === "recover" ? "Copied!" : "Recover"}
              </button>
            )}
            <button
              className="hist-action-btn"
              onClick={() => copyToClipboard(rerunPrompt, "rerun")}
              title="Copy a prompt that tells AI to re-run this exact query"
            >
              {copied === "rerun" ? <ClipboardCheck size={12} /> : <Copy size={12} />}
              {copied === "rerun" ? "Copied!" : "Re-run"}
            </button>

            <span className="hist-actions-divider" aria-hidden="true" />

            {/* Group 2: Open / Download */}
            <OpenWithMenu item={item} viewers={viewers} send={send} />
            <DownloadMenu item={item} send={send} />
            {item.threadUrl && (
              <a
                href={item.threadUrl}
                className="hist-action-btn hist-action-link"
                target="_blank"
                rel="noopener noreferrer"
                title="Open this thread on perplexity.ai"
              >
                <ExternalLink size={12} />
                Thread
              </a>
            )}

            {/* Right-aligned: pin + delete */}
            <span className="hist-actions-spacer" aria-hidden="true" />
            <button
              className="hist-action-btn"
              onClick={() => send({ type: "history:pin", payload: { historyId: item.id, pinned: !item.pinned } })}
              title={item.pinned ? "Unpin this entry" : "Pin to keep across retention prunes"}
            >
              {item.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              {item.pinned ? "Unpin" : "Pin"}
            </button>
            <button
              className="hist-action-btn hist-action-icon-btn"
              onClick={() => send({ type: "history:delete", payload: { historyId: item.id } })}
              title="Delete this entry from local history"
              aria-label="Delete this entry"
            >
              <Trash2 size={13} />
            </button>
          </div>

          {item.tags?.length ? (
            <div className="hist-tag-row">
              {item.tags.map((tag) => (
                <span key={tag} className="chip chip-muted" dir="auto">{tag}</span>
              ))}
            </div>
          ) : null}

          {/* Error display */}
          {item.error && (
            <div className="hist-error" dir="auto">
              {item.error}
            </div>
          )}
        </div>
      )}

      {/* Bottom bar (collapsed): sources + thread link */}
      {!expanded && (
        <div className="hist-card-footer">
          {item.sourceCount > 0 && (
            <span className="hist-meta-item">
              {item.sourceCount} sources
            </span>
          )}
          <div className="flex items-center gap-2">
            {recoverPrompt && (
              <button
                className="hist-footer-btn"
                onClick={(e) => { e.stopPropagation(); copyToClipboard(recoverPrompt, "recover"); }}
                title="Copy recover prompt"
                aria-label="Copy recover prompt"
              >
                {copied === "recover" ? <ClipboardCheck size={11} /> : <RotateCcw size={11} />}
              </button>
            )}
            {item.threadUrl && (
              <a
                href={item.threadUrl}
                className="hist-footer-link"
                onClick={(e) => e.stopPropagation()}
                aria-label="Open thread on perplexity.ai (new tab)"
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Keep legacy card for dashboard recent queries (compact)
function HistoryCard({ item }: { item: HistoryItem; compact?: boolean }) {
  return (
    <div className="history-card">
      <div className="flex flex-wrap items-center gap-1">
        <div className={`chip hist-chip-tool ${getToolChipClass(item.tool)}`}>{shortToolName(item.tool)}</div>
        {item.model ? <div className="chip chip-muted hist-chip-model">{item.model}</div> : null}
        <div className="hist-compact-time">{relativeTime(item.createdAt)}</div>
      </div>
      <div className="hist-compact-query">{item.query}</div>
      <div className="hist-card-preview hist-compact-preview">
        <Markdown content={item.answerPreview} maxLines={3} />
      </div>
      <div className="hist-compact-meta">
        <span className="text-[var(--text-muted)]">{item.sourceCount} sources</span>
        {item.threadUrl ? (
          <a href={item.threadUrl} className="inline-flex items-center gap-1 text-[#7dd3fc]">
            Open thread
            <ExternalLink size={11} />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function PathRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="path-row">
      <div className="path-row-label">{label}</div>
      <div className="path-row-value">{value}</div>
    </div>
  );
}

function SettingToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span className="setting-toggle-label">{label}</span>
      <span className="toggle-switch">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="toggle-track" />
      </span>
    </label>
  );
}
