export interface ModelInfo {
  description: string;
  mode: string;
  provider: string | null;
  label?: string;
}

export interface ModelConfigEntry {
  label: string;
  description: string;
  subheading: string | null;
  has_new_tag: boolean;
  subscription_tier: string;
  non_reasoning_model: string | null;
  reasoning_model: string | null;
  text_only_model: boolean;
  audience?: string | null;
  is_default?: boolean;
}

export interface ModelsConfigResponse {
  models: Record<string, ModelInfo>;
  config: ModelConfigEntry[];
  default_models: Record<string, string>;
  agentic_research_compare_models?: string[];
}

export interface RateLimitMode {
  available: boolean;
  remaining_detail: {
    kind: string;
    remaining?: number;
  };
}

export interface RateLimitResponse {
  modes: Record<string, RateLimitMode>;
  sources: Record<string, RateLimitMode>;
}

export type ModelsConfigSource = "live" | "cache" | "fallback" | "empty";

export type RefreshTier = "got-scraping" | "impit" | "browser";

export interface SpeedBoostStatus {
  installed: boolean;
  version: string | null;
  installedAt: string | null;
  runtimeDir: string;
}

/**
 * Runtime auth state written by the daemon after every init/reinit/shutdown.
 * Lives at profiles/<name>/daemon-status.json. Null when the file does not
 * exist (stdio-only installs, first run, daemon not yet started).
 */
export interface DaemonAuthStatus {
  authenticated: boolean;
  tier: "Anonymous" | "Authenticated" | "Pro" | "Max" | "Enterprise";
  userId: string | null;
  pid: number;
  lastInit: string;       // ISO timestamp when init/reinit completed
  initDurationMs: number;
  error: string | null;   // non-null only when init/reinit threw
}

export interface AccountSnapshot {
  loggedIn: boolean;
  userId: string | null;
  tier: "Anonymous" | "Authenticated" | "Pro" | "Max" | "Enterprise";
  canUseComputer: boolean;
  modelsConfig: ModelsConfigResponse | null;
  modelsConfigSource: ModelsConfigSource;
  rateLimits: RateLimitResponse | null;
  configDir: string;
  browserProfileDir: string;
  lastUpdated: string | null;
  /** Which tier last satisfied a live refresh — null when no refresh has completed yet. */
  lastRefreshTier: RefreshTier | null;
  speedBoost: SpeedBoostStatus;
  /**
   * Live auth state from the running daemon. Null when daemon-status.json does
   * not exist (stdio mode, first run, or daemon not yet started). When present
   * and authenticated=false while loggedIn=true, the daemon sees anonymous mode
   * despite stored credentials — the Refresh button can trigger a reinit.
   */
  daemonAuth: DaemonAuthStatus | null;
}

export interface SavedResearchSummary {
  id: string;
  query: string;
  tool: string;
  model: string | null;
  status: "completed" | "pending" | "failed";
  createdAt: string;
  completedAt?: string;
  threadUrl?: string;
  answerPreview: string;
  sourceCount: number;
  fileCount: number;
  error?: string;
}

export interface HistorySource {
  n: number;
  title: string;
  url: string;
  snippet?: string;
}

export interface HistoryAttachment {
  filename: string;
  relPath: string;
  mimeType?: string;
  sizeBytes?: number;
  kind?: "image" | "file";
}

export interface HistoryItem {
  id: string;
  tool: string;
  query: string;
  model: string | null;
  mode: string | null;
  language: string | null;
  createdAt: string;
  answerPreview: string;
  sourceCount: number;
  threadUrl?: string;
  status?: "completed" | "pending" | "failed";
  completedAt?: string;
  tier?: "Max" | "Pro" | "Enterprise" | "Authenticated" | "Anonymous";
  threadSlug?: string | null;
  backendUuid?: string | null;
  readWriteToken?: string | null;
  sources?: HistorySource[];
  attachments?: HistoryAttachment[];
  tags?: string[];
  pinned?: boolean;
  source?: "mcp" | "cloud";
  cloudHydratedAt?: string;
  error?: string;
}
