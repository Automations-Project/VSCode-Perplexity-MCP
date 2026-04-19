import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getActiveName, getProfilePaths } from "./profiles.js";
import { Vault } from "./vault.js";

export const PERPLEXITY_URL = "https://www.perplexity.ai";
export const AUTH_SESSION_ENDPOINT = `${PERPLEXITY_URL}/api/auth/session`;
export const QUERY_ENDPOINT = `${PERPLEXITY_URL}/rest/sse/perplexity_ask`;
export const MODELS_CONFIG_ENDPOINT = `${PERPLEXITY_URL}/rest/models/config?config_schema=v1&version=2.18&source=default`;
export const ASI_ACCESS_ENDPOINT = `${PERPLEXITY_URL}/rest/billing/asi-access-decision?version=2.18&source=default`;
export const RATE_LIMIT_ENDPOINT = `${PERPLEXITY_URL}/rest/rate-limit/status?version=2.18&source=default`;
export const EXPERIMENTS_ENDPOINT = `${PERPLEXITY_URL}/rest/experiments/attributes?version=2.18&source=default`;
export const USER_INFO_ENDPOINT = `${PERPLEXITY_URL}/rest/user/info?version=2.18&source=default`;
export const THREAD_ENDPOINT = (slug: string) => `${PERPLEXITY_URL}/rest/thread/${slug}`;

export const CONFIG_DIR = process.env.PERPLEXITY_CONFIG_DIR || join(homedir(), ".perplexity-mcp");

/**
 * Resolve the active profile name at call time.
 *  env PERPLEXITY_PROFILE > active pointer > "default"
 */
function activeName(): string {
  return process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
}

/**
 * Cookies file path for the active profile (legacy fallback only — real
 * storage is the encrypted vault now). Profile-aware, evaluated at call time.
 */
export function getCookiesFile(): string {
  return getProfilePaths(activeName()).dir + "/cookies.json";
}

/**
 * Browser persistent-context directory for the active profile.
 * Profile-aware, evaluated at call time.
 */
export function getBrowserDataDir(): string {
  return getProfilePaths(activeName()).browserData;
}

// Preserve named exports for back-compat (extension + tests import these).
// Evaluated at module load — acceptable because both helpers above are pure
// path derivation. Tests that set PERPLEXITY_CONFIG_DIR at runtime still see
// fresh values via the getter functions.
export const COOKIES_FILE = getCookiesFile();
export const STORAGE_STATE_FILE = join(CONFIG_DIR, "storage-state.json");
export const BROWSER_DATA_DIR = getBrowserDataDir();

export interface BrowserInfo {
  path: string;
  channel: "chrome" | "msedge" | "chromium" | "bundled";
}

/**
 * Find a suitable Chromium-based browser on the system.
 * Searches Chrome > Edge > Chromium with platform-specific paths.
 * Returns browser path and channel, or null if not found.
 */
export function findBrowser(): BrowserInfo | null {
  if (process.env.PERPLEXITY_CHROME_PATH && existsSync(process.env.PERPLEXITY_CHROME_PATH)) {
    return { path: process.env.PERPLEXITY_CHROME_PATH, channel: "chrome" };
  }

  // Chrome
  const chromeCandidates = process.platform === "win32"
    ? [
        join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  for (const p of chromeCandidates) if (p && existsSync(p)) return { path: p, channel: "chrome" };

  // Edge (Windows/Linux fallback)
  const edgeCandidates = process.platform === "win32"
    ? [join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
       join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe")]
    : ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"];
  for (const p of edgeCandidates) if (p && existsSync(p)) return { path: p, channel: "msedge" };

  // Chromium (Linux)
  if (process.platform === "linux") {
    const chromiumCandidates = ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"];
    for (const p of chromiumCandidates) if (existsSync(p)) return { path: p, channel: "chromium" };
  }

  return null;
}

/**
 * Find the real Chrome executable on the system.
 * Returns the path or null if not found.
 */
export function findChromeExecutable(): string | null {
  return findBrowser()?.path ?? null;
}

/**
 * Resolve a browser executable the client can launch.
 *
 * Prefers system Chrome for Cloudflare-friendly fingerprints. Falls back to
 * patchright's bundled Chromium when the user ran `npx patchright install chromium`.
 * Throws a descriptive error when neither is available so the CLI doesn't crash
 * with Playwright's opaque "Executable doesn't exist at ..." message.
 */
export async function resolveBrowserExecutable(): Promise<{ path: string; source: "system-chrome" | "bundled-chromium" }> {
  const systemChrome = findChromeExecutable();
  if (systemChrome) {
    return { path: systemChrome, source: "system-chrome" };
  }

  let bundledPath: string | null = null;
  try {
    const { chromium } = await import("patchright");
    bundledPath = chromium.executablePath();
  } catch {
    // patchright not installed — fall through to error below
  }

  if (bundledPath && existsSync(bundledPath)) {
    return { path: bundledPath, source: "bundled-chromium" };
  }

  const lines = [
    "No usable browser found for Perplexity MCP.",
    "",
    "Pick one of the following:",
    "  1. Install Google Chrome (recommended for best Cloudflare compatibility):",
    "     https://www.google.com/chrome/",
    "  2. Download patchright's bundled Chromium:",
    "     npx patchright install chromium",
    "",
    "You can also set PERPLEXITY_CHROME_PATH to an explicit executable.",
  ];
  throw new Error(lines.join("\n"));
}

export const DEFAULT_HEADERS: Record<string, string> = {
  accept: "text/event-stream",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  "content-type": "application/json",
  origin: PERPLEXITY_URL,
  referer: `${PERPLEXITY_URL}/`,
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "sec-ch-ua":
    '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

export const SUPPORTED_BLOCK_USE_CASES = [
  "answer_modes",
  "media_items",
  "knowledge_cards",
  "inline_entity_cards",
  "place_widgets",
  "finance_widgets",
  "prediction_market_widgets",
  "sports_widgets",
  "flight_status_widgets",
  "news_widgets",
  "shopping_widgets",
  "jobs_widgets",
  "search_result_widgets",
  "inline_images",
  "inline_assets",
  "placeholder_cards",
  "diff_blocks",
  "inline_knowledge_cards",
  "entity_group_v2",
  "refinement_filters",
  "canvas_mode",
  "maps_preview",
  "answer_tabs",
  "price_comparison_widgets",
  "preserve_latex",
  "generic_onboarding_widgets",
  "in_context_suggestions",
  "inline_claims",
];

// --- Dynamic model config types ---

export interface ModelInfo {
  description: string;
  mode: string; // "search" | "research" | "asi" | "browser_agent" | "studio" | "study" | "agentic_research" | "document_review"
  provider: string | null;
  label?: string;
}

export interface ModelConfigEntry {
  label: string;
  description: string;
  subheading: string | null;
  has_new_tag: boolean;
  subscription_tier: string; // "pro" | "max" | "free"
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

export interface ASIAccessResponse {
  can_use_computer: boolean;
  can_access_org_credits_page: boolean;
  can_enable_topup: boolean;
}

export interface RateLimitResponse {
  modes: Record<string, { available: boolean; remaining_detail: { kind: string; remaining?: number } }>;
  sources: Record<string, { available: boolean; remaining_detail: { kind: string; remaining?: number } }>;
}

export interface UserInfoResponse {
  has_non_public_email?: boolean;
  is_enterprise?: boolean;
  is_gov?: boolean;
  is_student?: boolean;
}

export interface AccountInfo {
  isPro: boolean;
  isMax: boolean;
  isEnterprise: boolean;
  canUseComputer: boolean;
  modelsConfig: ModelsConfigResponse | null;
  rateLimits: RateLimitResponse | null;
}

export interface ASIFile {
  filename: string;
  assetType: string;       // "XLSX_FILE", "CODE_FILE", "CSV_FILE", etc.
  url: string;             // remote download URL
  localPath?: string;      // local path after download
  size?: number;           // file size in bytes
  mediaType?: string;      // MIME type
}

export interface SearchResult {
  answer: string;
  reasoning?: string;
  sources: Array<{ title: string; url: string; snippet: string }>;
  media: Array<{ type: string; url: string; name: string }>;
  files?: ASIFile[];
  suggestedFollowups: string[];
  followUp?: {
    backendUuid: string;
    readWriteToken: string | null;
    threadUrlSlug: string | null;
    threadTitle: string | null;
  };
  threadUrl?: string;
}

/**
 * Check if we have saved browser state from a previous login.
 */
export function hasStorageState(): boolean {
  return existsSync(STORAGE_STATE_FILE);
}

/**
 * Check if we have saved cookies (legacy or env vars).
 */
export function hasCookies(): boolean {
  if (process.env.PERPLEXITY_SESSION_TOKEN && process.env.PERPLEXITY_CSRF_TOKEN) {
    return true;
  }
  return existsSync(COOKIES_FILE);
}

/**
 * Build cookie string from env vars or saved cookies file for Playwright context.
 */
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

const _vault = new Vault();

export async function getSavedCookies(): Promise<PlaywrightCookie[]> {
  // 1. Env var override (unchanged behavior)
  if (process.env.PERPLEXITY_SESSION_TOKEN) {
    const cookies: PlaywrightCookie[] = [{
      name: "__Secure-next-auth.session-token",
      value: process.env.PERPLEXITY_SESSION_TOKEN,
      domain: ".perplexity.ai",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    }];
    if (process.env.PERPLEXITY_CSRF_TOKEN) {
      cookies.push({
        name: "next-auth.csrf-token",
        value: process.env.PERPLEXITY_CSRF_TOKEN,
        domain: ".perplexity.ai",
        path: "/",
        secure: false,
        httpOnly: false,
        sameSite: "Lax",
      });
    }
    return cookies;
  }

  // 2. Vault-backed cookies for the active profile (Phase 2)
  const raw = await _vault.get(activeName(), "cookies").catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Check whether the active profile has stored login cookies in its vault.
 * Extension has its own filesystem-based `hasStoredLogin` in session.ts that
 * inspects COOKIES_FILE / BROWSER_DATA_DIR — this one is vault-aware.
 */
export async function hasStoredLogin(): Promise<boolean> {
  const raw = await _vault.get(activeName(), "cookies").catch(() => null);
  return !!raw;
}
