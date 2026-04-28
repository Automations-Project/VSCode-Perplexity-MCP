/**
 * Perplexity Web API client — uses Playwright persistent browser context.
 * Login (headed) and MCP server (headless) share the same browser profile directory,
 * so Cloudflare cf_clearance and all state persist between runs.
 */

import { randomUUID } from "crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "patchright";
import {
  PERPLEXITY_URL,
  AUTH_SESSION_ENDPOINT,
  QUERY_ENDPOINT,
  THREAD_ENDPOINT,
  MODELS_CONFIG_ENDPOINT,
  ASI_ACCESS_ENDPOINT,
  RATE_LIMIT_ENDPOINT,
  EXPERIMENTS_ENDPOINT,
  SUPPORTED_BLOCK_USE_CASES,
  findBrowser,
  findChromeExecutable,
  resolveBrowserExecutable,
  getOrCreateContext,
  getSavedCookies,
  type BrowserChannel,
  type ASIFile,
  type SearchResult,
  type ModelsConfigResponse,
  type ASIAccessResponse,
  type RateLimitResponse,
  type AccountInfo,
} from "./config.js";
import { exportThread as exportEntry } from "./export.js";
import { isImpitAvailable, impitFetchJson } from "./refresh.js";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { getActiveName, getConfigDir, getProfilePaths } from "./profiles.js";
import { clearStaleSingletonLocks } from "./fs-utils.js";

function getActiveProfileName(): string {
  return process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
}

function getActivePaths() {
  return getProfilePaths(getActiveProfileName());
}

function getModelsCacheFile(): string {
  return getActivePaths().modelsCache;
}

const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  // NOTE: `--disable-web-security` was removed (2026-04-27 public-hardening
  // audit). All in-page `fetch()` calls in this file are same-origin
  // (perplexity.ai) — the only off-origin downloader (`downloadASIFiles`)
  // now uses Playwright's `APIRequestContext` (`context.request.get`) which
  // runs outside the page context and is not subject to CORS. Re-adding this
  // flag would re-introduce a meaningful XSS amplification risk for no gain.
  //
  // NOTE: `--disable-features=IsolateOrigins,site-per-process` and
  // `--disable-site-isolation-trials` were removed (2026-04-27 public-
  // hardening audit). They disable Chromium's Site Isolation process model,
  // which is a renderer-architecture feature invisible to JavaScript on the
  // page (no documented fingerprint surface — Patchright's
  // `chromiumSwitches.js` does not include them; see
  // node_modules/patchright-core/lib/server/chromium/chromiumSwitches.js).
  // Their historical use in puppeteer-stealth recipes was to keep cross-
  // origin iframes in the same renderer process so `page.frames()` /
  // CDP-based interaction worked uniformly. This codebase does not touch
  // iframes (no `page.frames`, `frameLocator`, `mainFrame`, or `postMessage`
  // usage in packages/mcp-server/src), so the only effect of keeping them
  // was a silent reduction in the browser's Spectre/UXSS defense-in-depth.
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  "--disable-extensions",
  "--disable-popup-blocking",
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Build launch options for Playwright persistent context.
 *
 * Uses the first available system browser (Chrome > Edge > Chromium > Brave)
 * for best Cloudflare fingerprinting, falling back to patchright's bundled
 * Chromium. The resolved `channel` is passed through so Patchright can apply
 * channel-specific stealth tweaks (important for msedge on Windows).
 */
function buildLaunchOptions(headless: boolean): Record<string, any> {
  const browser = findBrowser();
  const opts: Record<string, any> = {
    headless,
    args: STEALTH_ARGS,
    viewport: headless ? { width: 1920, height: 1080 } : { width: 800, height: 600 },
    userAgent: USER_AGENT,
    // Strip --enable-automation (Playwright default) which is a CF red flag
    ignoreDefaultArgs: ["--enable-automation"],
  };
  if (browser) {
    opts.executablePath = browser.path;
    // Only pass channel when it's a first-party Playwright channel. Brave
    // uses channel "chromium" with an explicit executablePath — Patchright
    // treats it as generic Chromium which is the correct behavior.
    if (browser.channel === "chrome" || browser.channel === "msedge" || browser.channel === "chromium") {
      opts.channel = browser.channel;
    }
    console.error(`[perplexity-mcp] Using ${browser.channel}: ${browser.path}`);
  }
  return opts;
}

// Block-shape contracts used by parseASIReconnectSSE / extractFromWorkflowBlock.
// Fields are limited to those the two parsers actually read off the wire.
//
// `OtherWorkflowBlock` is the catch-all so unknown `intended_usage` kinds flow
// through iteration without TS errors — Perplexity adds new kinds over time.
// Because TS does not subtract string literals from `string`, the catch-all
// must carry the same optional sidecar fields as the known kinds; otherwise
// narrowing on `intended_usage === "X"` produces a union that still contains
// `OtherWorkflowBlock`, blocking access to the kind-specific sidecar.
type WorkflowRootBlockSidecar = {
  steps?: Array<{
    items?: Array<{
      payload?: {
        text_payload?: { text?: string };
        sources_payload?: {
          sources?: Array<{ name?: string; url?: string; snippet?: string }>;
        };
      };
    }>;
  }>;
};

type WebResultsBlockSidecar = {
  web_results?: Array<{ name?: string; url?: string; snippet?: string }>;
};

type AssetsAnswerModeBlockSidecar = {
  assets?: Array<{
    asset_type?: string;
    download_info?: Array<{
      url?: string;
      filename?: string;
      size?: number;
      media_type?: string;
    }>;
  }>;
};

type PendingFollowupsBlockSidecar = {
  followups?: Array<string | { text?: string }>;
};

interface WorkflowBlockBase {
  intended_usage: string;
  workflow_block?: WorkflowRootBlockSidecar;
  web_result_block?: WebResultsBlockSidecar;
  assets_mode_block?: AssetsAnswerModeBlockSidecar;
  pending_followups_block?: PendingFollowupsBlockSidecar;
}

interface WorkflowRootBlock extends WorkflowBlockBase {
  intended_usage: "workflow_root";
}

interface WebResultsBlock extends WorkflowBlockBase {
  intended_usage: "web_results";
}

interface AssetsAnswerModeBlock extends WorkflowBlockBase {
  intended_usage: "assets_answer_mode";
}

interface PendingFollowupsBlock extends WorkflowBlockBase {
  intended_usage: "pending_followups";
}

interface OtherWorkflowBlock extends WorkflowBlockBase {
  intended_usage: string;
}

type WorkflowBlock =
  | WorkflowRootBlock
  | WebResultsBlock
  | AssetsAnswerModeBlock
  | PendingFollowupsBlock
  | OtherWorkflowBlock;

interface ExperimentsResponse {
  server_is_pro?: boolean;
  server_is_max?: boolean;
  server_is_enterprise?: boolean;
}

/**
 * Derive tier flags from a /rest/experiments/attributes payload.
 *
 * Mirrors refresh.ts:616 and session-metadata.js:73-75: Computer mode is
 * gated to paid tiers, so when the ASI access endpoint reports it as
 * available but the experiments payload omits server_is_pro (which has
 * been observed in production), infer Pro. Without this fallback, an
 * authenticated Pro account silently demotes to Free whenever the
 * experiments response drops the subscription bit.
 */
function deriveTierFlagsFromExperiments(
  experiments: ExperimentsResponse | undefined | null,
  canUseComputer: boolean,
): { isPro: boolean; isMax: boolean; isEnterprise: boolean } {
  const isProFromExp = experiments?.server_is_pro === true;
  const isMax = experiments?.server_is_max === true;
  const isEnterprise = experiments?.server_is_enterprise === true;
  const isPro = isProFromExp || (canUseComputer && !isMax && !isEnterprise);
  return { isPro, isMax, isEnterprise };
}

export interface ListAskThreadsItem {
  backendUuid: string;
  contextUuid: string;
  slug: string;
  title: string;
  queryStr: string;
  answerPreview: string;
  firstAnswer: string | null;
  createdAt: string;
  mode: string | null;
  displayModel: string | null;
  searchFocus: string | null;
  sources: string[];
  queryCount: number;
  threadStatus: string;
  readWriteToken: string | null;
}

export interface ListAskThreadsResult {
  items: ListAskThreadsItem[];
  total: number;
}

export interface ListAskThreadsOpts {
  limit?: number;
  offset?: number;
  searchTerm?: string;
  excludeAsi?: boolean;
  ascending?: boolean;
}

function buildListAskThreadsUrl(): string {
  return `${PERPLEXITY_URL}/rest/thread/list_ask_threads?version=2.18&source=default`;
}

function buildListAskThreadsBody(opts: ListAskThreadsOpts): Record<string, unknown> {
  return {
    limit: opts.limit ?? 100,
    offset: opts.offset ?? 0,
    ascending: opts.ascending ?? false,
    search_term: opts.searchTerm ?? "",
    with_temporary_threads: true,
    exclude_asi: opts.excludeAsi ?? false,
  };
}

function parseListThreadsRows(rows: Array<Record<string, unknown>>): ListAskThreadsResult {
  const total = typeof rows[0]?.total_threads === "number" ? rows[0].total_threads as number : rows.length;
  return {
    total,
    items: rows.map((row) => ({
      backendUuid: String(row.uuid ?? ""),
      contextUuid: String(row.context_uuid ?? ""),
      slug: String(row.slug ?? ""),
      title: String(row.title ?? row.query_str ?? "(untitled)"),
      queryStr: String(row.query_str ?? ""),
      answerPreview: String(row.answer_preview ?? "").slice(0, 220),
      firstAnswer: typeof row.first_answer === "string" ? row.first_answer : null,
      createdAt: typeof row.last_query_datetime === "string"
        ? /[Zz]$/.test(row.last_query_datetime) ? row.last_query_datetime : `${row.last_query_datetime}Z`
        : new Date().toISOString(),
      mode: typeof row.mode === "string" ? row.mode : null,
      displayModel: typeof row.display_model === "string" ? row.display_model : null,
      searchFocus: typeof row.search_focus === "string" ? row.search_focus : null,
      sources: Array.isArray(row.sources) ? row.sources.map(String) : [],
      queryCount: typeof row.query_count === "number" ? row.query_count : 1,
      threadStatus: String(row.thread_status ?? row.status ?? "completed").toLowerCase(),
      readWriteToken: typeof row.read_write_token === "string" ? row.read_write_token : null,
    })),
  };
}

/**
 * Browser-free fetch of /rest/thread/list_ask_threads via impit. Returns null
 * when impit isn't installed, no session cookie is on disk, or the request
 * doesn't yield a parseable 200. Lets callers (cloud-sync, the class method)
 * fall back to the browser path on any miss.
 */
export async function listCloudThreadsViaImpit(
  opts: ListAskThreadsOpts = {},
): Promise<ListAskThreadsResult | null> {
  if (!isImpitAvailable()) return null;
  const cookies = await getSavedCookies().catch(() => [] as Awaited<ReturnType<typeof getSavedCookies>>);
  const hasSession = cookies.some((c) => c.name === "__Secure-next-auth.session-token");
  if (!hasSession) return null;
  const url = buildListAskThreadsUrl();
  const body = buildListAskThreadsBody(opts);
  // Perplexity's frontend JS auto-injects these on every same-origin fetch.
  // Without them, /rest/thread/list_ask_threads returns HTTP 200 with [] —
  // a silent "no app context" rejection that we'd otherwise misread as
  // "user has no threads" (root cause of the 0-rows bug seen in 0.8.17).
  const headers: Record<string, string> = {
    "x-app-apiclient": "default",
    "x-app-apiversion": "2.18",
    "x-perplexity-request-endpoint": url,
    "x-perplexity-request-reason": "threads-body",
    "x-perplexity-request-try-number": "1",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    referer: `${PERPLEXITY_URL}/`,
    origin: PERPLEXITY_URL,
  };
  const result = await impitFetchJson(url, { method: "POST", body, headers }, cookies);
  if (!result || result.challenged || result.status !== 200 || !Array.isArray(result.data)) {
    console.error(
      `[perplexity-mcp] list_ask_threads impit miss ` +
        `(status=${result?.status ?? "n/a"} challenged=${!!result?.challenged}); ` +
        `caller will fall back to browser.`,
    );
    return null;
  }
  const parsed = parseListThreadsRows(result.data as Array<Record<string, unknown>>);
  console.error(
    `[perplexity-mcp] list_ask_threads via impit: ${parsed.items.length} rows ` +
      `(offset=${opts.offset ?? 0} limit=${opts.limit ?? 100} total=${parsed.total})`,
  );
  return parsed;
}

export class PerplexityClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  public authenticated = false;
  public userId: string | null = null;
  public accountInfo: AccountInfo = {
    isPro: false,
    isMax: false,
    isEnterprise: false,
    canUseComputer: false,
    modelsConfig: null,
    rateLimits: null,
  };

  /**
   * Initialize the client. Two-phase startup:
   *
   * Phase 1 (headed): Cloudflare Turnstile cannot be solved by headless browsers.
   *   A brief VISIBLE browser session navigates to Perplexity, auto-solves the CF
   *   challenge, and fetches all account info endpoints (models, ASI access, etc.)
   *   while Cloudflare isn't blocking. Then closes.
   *
   * Phase 2 (headless): Launches headless with the same persistent profile
   *   (now carrying fresh cf_clearance) for search operations.
   *
   * Set env PERPLEXITY_HEADLESS_ONLY=1 to skip the headed phase (uses disk cache).
   */
  async init(): Promise<void> {
    const activePaths = getActivePaths();
    if (!existsSync(activePaths.browserData)) {
      mkdirSync(activePaths.browserData, { recursive: true });
    }

    // Fail fast with a readable message if no browser is installed at all.
    const browser = await resolveBrowserExecutable();
    console.error(`[perplexity-mcp] Using ${browser.source}: ${browser.path}`);

    // Phase 1: Headed session — solve CF challenge + fetch account info
    const skipHeaded = process.env.PERPLEXITY_HEADLESS_ONLY === "1";
    if (!skipHeaded) {
      await this.headedBootstrap();
    } else {
      console.error("[perplexity-mcp] Skipping headed session (PERPLEXITY_HEADLESS_ONLY=1).");
      this.loadCachedAccountInfo();
    }

    // Phase 2: Headless browser for search operations.
    console.error("[perplexity-mcp] Launching headless browser...");
    const launchOpts = buildLaunchOptions(true);
    this.browser = await chromium.launch({
      headless: launchOpts.headless,
      args: launchOpts.args,
      ...(launchOpts.executablePath ? { executablePath: launchOpts.executablePath } : {}),
      ...(launchOpts.channel ? { channel: launchOpts.channel } : {}),
      ignoreDefaultArgs: launchOpts.ignoreDefaultArgs,
    });
    this.context = await getOrCreateContext(this.browser, {
      viewport: launchOpts.viewport,
      userAgent: launchOpts.userAgent,
    });

    // Inject saved cookies (session + cf_clearance from login)
    const saved = await getSavedCookies();
    if (saved.length > 0) {
      await this.context.addCookies(saved);
      console.error(`[perplexity-mcp] Injected ${saved.length} saved cookies into browser context.`);
    }

    this.page = await this.context.newPage();

    // Navigate to Perplexity (headless — relies on fresh cf_clearance from headed phase)
    try {
      await this.page.goto(PERPLEXITY_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.page.waitForTimeout(2000);
    } catch (err) {
      console.error("[perplexity-mcp] Navigation warning:", (err as Error).message);
    }

    await this.checkAuth();

    // If headed phase was skipped or failed, try loading account info from headless
    if (!this.accountInfo.modelsConfig) {
      await this.loadAccountInfo();
    }
  }

  /**
   * Brief VISIBLE browser session that:
   * 1. Navigates to Perplexity to solve Cloudflare Turnstile (auto, no user interaction)
   * 2. Fetches all account info endpoints while CF isn't blocking
   * 3. Caches results to disk, then closes
   */
  private async headedBootstrap(): Promise<void> {
    console.error("[perplexity-mcp] Starting headed bootstrap (solving CF + loading account info)...");

    let ctx: BrowserContext | null = null;
    try {
      const browserData = getActivePaths().browserData;
      clearStaleSingletonLocks(browserData);
      ctx = await chromium.launchPersistentContext(browserData, buildLaunchOptions(false));

      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto(PERPLEXITY_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Wait for Cloudflare challenge to resolve (up to 20s)
      // CF redirect destroys execution context — that's a sign it resolved.
      let cfResolved = false;
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(1000);
        try {
          const title = await page.title();
          if (!title.includes("Just a moment")) {
            cfResolved = true;
            console.error(`[perplexity-mcp] Cloudflare resolved in ${i + 1}s.`);
            break;
          }
        } catch {
          // Context destroyed = CF redirect in progress. Wait for new page to load.
          console.error("[perplexity-mcp] CF redirect detected, waiting for page to settle...");
          try {
            await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
          } catch { /* ignore */ }
          cfResolved = true;
          console.error(`[perplexity-mcp] Cloudflare resolved (via redirect) in ${i + 1}s.`);
          break;
        }
      }

      if (!cfResolved) {
        console.error("[perplexity-mcp] CF challenge did not resolve in 20s — will use cached data.");
        await ctx.close();
        this.loadCachedAccountInfo();
        return;
      }

      // Check auth while headed
      const authData: any = await page.evaluate(async (url: string) => {
        try {
          const r = await fetch(url, { credentials: "include" });
          return await r.json();
        } catch {
          return null;
        }
      }, AUTH_SESSION_ENDPOINT);
      this.userId = authData?.user?.id ?? null;
      this.authenticated = !!this.userId;
      if (this.authenticated) {
        console.error(`[perplexity-mcp] Authenticated as user: ${this.userId}`);
      } else {
        console.error("[perplexity-mcp] Not authenticated (anonymous mode).");
      }

      // Fetch all account info while CF isn't blocking
      if (this.authenticated) {
        const fetchOk = async (url: string) => {
          try {
            const r = await fetch(url, { credentials: "include" });
            return r.ok ? await r.json() : null;
          } catch {
            return null;
          }
        };
        const modelsData = await page.evaluate(fetchOk, MODELS_CONFIG_ENDPOINT);
        const asiData = await page.evaluate(fetchOk, ASI_ACCESS_ENDPOINT);
        const rateLimitData = await page.evaluate(fetchOk, RATE_LIMIT_ENDPOINT);
        const experimentsData: any = await page.evaluate(fetchOk, EXPERIMENTS_ENDPOINT);

        if (modelsData) {
          this.accountInfo.modelsConfig = modelsData as ModelsConfigResponse;
          const count = Object.keys(this.accountInfo.modelsConfig.models || {}).length;
          console.error(`[perplexity-mcp] Loaded ${count} models from account.`);
        }
        if (asiData) {
          const asi = asiData as ASIAccessResponse;
          this.accountInfo.canUseComputer = asi.can_use_computer;
          console.error(`[perplexity-mcp] Computer mode: ${asi.can_use_computer ? "available" : "not available"}`);
        }
        if (rateLimitData) {
          this.accountInfo.rateLimits = rateLimitData as RateLimitResponse;
        }
        if (experimentsData) {
          const flags = deriveTierFlagsFromExperiments(
            experimentsData as ExperimentsResponse,
            this.accountInfo.canUseComputer,
          );
          this.accountInfo.isPro = flags.isPro;
          this.accountInfo.isMax = flags.isMax;
          this.accountInfo.isEnterprise = flags.isEnterprise;
          const tier = this.accountInfo.isMax ? "Max" : this.accountInfo.isPro ? "Pro" : this.accountInfo.isEnterprise ? "Enterprise" : "Free";
          console.error(`[perplexity-mcp] Account tier: ${tier}`);
        }

        // Cache to disk
        if (this.accountInfo.modelsConfig) {
          try {
            writeFileSync(getModelsCacheFile(), JSON.stringify(this.accountInfo, null, 2));
            console.error("[perplexity-mcp] Account info cached to disk.");
          } catch { /* ignore */ }
        }
      }

      await ctx.close();
      ctx = null;
      console.error("[perplexity-mcp] Headed bootstrap complete.");
    } catch (err) {
      console.error("[perplexity-mcp] Headed bootstrap error:", (err as Error).message);
      if (ctx) await ctx.close().catch(() => {});
      // Fall back to cache
      this.loadCachedAccountInfo();
    }
  }

  private async checkAuth(): Promise<void> {
    if (!this.page) return;
    try {
      const data = await this.page.evaluate(async (url: string) => {
        const r = await fetch(url, { credentials: "include" });
        return r.json();
      }, AUTH_SESSION_ENDPOINT);

      this.userId = (data as any)?.user?.id ?? null;
      this.authenticated = !!this.userId;
      if (this.authenticated) {
        console.error(`[perplexity-mcp] Authenticated as user: ${this.userId}`);
      } else {
        console.error("[perplexity-mcp] No authenticated session (anonymous mode)");
      }
    } catch (err) {
      console.error("[perplexity-mcp] Auth check failed:", (err as Error).message);
      this.authenticated = false;
    }
  }

  /**
   * Load dynamic account info: models config, ASI access, rate limits, experiment flags.
   * Falls back to disk cache if Cloudflare blocks the /rest/* endpoints.
   */
  private async loadAccountInfo(): Promise<void> {
    if (!this.page || !this.authenticated) return;

    // Helper: fetch a single JSON endpoint inside the browser context
    const fetchEndpoint = async (url: string): Promise<any> => {
      try {
        return await this.page!.evaluate(
          async (u: string) => {
            const r = await fetch(u, { credentials: "include" });
            if (!r.ok) return null;
            return r.json();
          },
          url
        );
      } catch { return null; }
    };

    let gotLiveData = false;

    try {
      const [modelsData, asiData, rateLimitData, experimentsData] = await Promise.all([
        fetchEndpoint(MODELS_CONFIG_ENDPOINT),
        fetchEndpoint(ASI_ACCESS_ENDPOINT),
        fetchEndpoint(RATE_LIMIT_ENDPOINT),
        fetchEndpoint(EXPERIMENTS_ENDPOINT),
      ]);

      if (modelsData) {
        this.accountInfo.modelsConfig = modelsData as ModelsConfigResponse;
        const modelCount = Object.keys(this.accountInfo.modelsConfig.models || {}).length;
        console.error(`[perplexity-mcp] Loaded ${modelCount} models from account`);
        gotLiveData = true;
      }

      if (asiData) {
        const asi = asiData as ASIAccessResponse;
        this.accountInfo.canUseComputer = asi.can_use_computer;
        console.error(`[perplexity-mcp] Computer mode: ${asi.can_use_computer ? "available" : "not available"}`);
        gotLiveData = true;
      }

      if (rateLimitData) {
        this.accountInfo.rateLimits = rateLimitData as RateLimitResponse;
      }

      if (experimentsData) {
        const flags = deriveTierFlagsFromExperiments(
          experimentsData as ExperimentsResponse,
          this.accountInfo.canUseComputer,
        );
        this.accountInfo.isPro = flags.isPro;
        this.accountInfo.isMax = flags.isMax;
        this.accountInfo.isEnterprise = flags.isEnterprise;
        const tier = this.accountInfo.isMax ? "Max" : this.accountInfo.isPro ? "Pro" : this.accountInfo.isEnterprise ? "Enterprise" : "Free";
        console.error(`[perplexity-mcp] Account tier: ${tier}`);
        gotLiveData = true;
      }
    } catch (err) {
      console.error("[perplexity-mcp] Failed to load account info:", (err as Error).message);
    }

    // Cache live data to disk for next time
    if (gotLiveData) {
      try {
        writeFileSync(getModelsCacheFile(), JSON.stringify(this.accountInfo, null, 2));
        console.error("[perplexity-mcp] Account info cached to disk.");
      } catch { /* ignore */ }
    } else {
      // Fall back to cached data
      this.loadCachedAccountInfo();
    }
  }

  /**
   * Load cached account info from disk (fallback when Cloudflare blocks).
   */
  private loadCachedAccountInfo(): void {
    const modelsCacheFile = getModelsCacheFile();
    if (!existsSync(modelsCacheFile)) {
      console.error("[perplexity-mcp] No cached account info found.");
      return;
    }
    try {
      const cached = JSON.parse(readFileSync(modelsCacheFile, "utf-8")) as AccountInfo;
      this.accountInfo = cached;
      const modelCount = cached.modelsConfig ? Object.keys(cached.modelsConfig.models || {}).length : 0;
      console.error(`[perplexity-mcp] Loaded ${modelCount} models from disk cache.`);
    } catch {
      console.error("[perplexity-mcp] Failed to read cached account info.");
    }
  }

  /**
   * Removed in 0.3.0. Login now runs in a separate child process (login-runner)
   * driven by AuthManager / the CLI so the long-lived MCP server doesn't hold
   * the browser profile lock. After a successful login, the runner writes to
   * the vault and drops a `.reinit` sentinel which the MCP server's watcher
   * picks up to reload cookies via `reinit()`.
   */
  async loginViaBrowser(_opts: { log?: (line: string) => void } = {}): Promise<{ success: boolean; message: string }> {
    throw new Error(
      "loginViaBrowser is removed in 0.3.0. Call AuthManager.login() from the extension or `npx perplexity-user-mcp login` from the CLI."
    );
  }

  /**
   * Close the current browser context and re-run init() so freshly-written
   * vault cookies are picked up. Called by the `.reinit` sentinel watcher
   * after a child login-runner completes.
   */
  async reinit(): Promise<void> {
    console.error("[perplexity-mcp] Reinit requested — closing current context and reloading cookies.");
    await this.shutdown().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
    this.authenticated = false;
    this.userId = null;
    await this.init();
  }

  async search(opts: {
    query: string;
    modelPreference?: string;
    mode?: string;
    sources?: string[];
    language?: string;
    followUp?: { backendUuid: string; readWriteToken?: string | null };
  }): Promise<SearchResult> {
    if (!this.page) {
      throw new Error("Client not initialized. Call init() first.");
    }

    const {
      query,
      modelPreference = "turbo",
      mode = "concise",
      sources = ["web"],
      language = "en-US",
      followUp,
    } = opts;

    // Validate model if we have a models config
    if (modelPreference && this.accountInfo.modelsConfig) {
      const mc = this.accountInfo.modelsConfig;
      const knownIds = new Set(Object.keys(mc.models || {}));
      // Also collect reasoning/non-reasoning model IDs from config entries
      for (const entry of (mc.config || [])) {
        if (entry.reasoning_model) knownIds.add(entry.reasoning_model);
        if (entry.non_reasoning_model) knownIds.add(entry.non_reasoning_model);
      }
      // Also allow known Perplexity aliases (resolved server-side)
      for (const def of Object.values(mc.default_models || {})) {
        if (def) knownIds.add(def);
      }
      if (!knownIds.has(modelPreference)) {
        throw new Error(
          `Invalid model: "${modelPreference}". Use perplexity_models to see all available models.`
        );
      }
    }

    const frontendUuid = randomUUID();
    const frontendContextUuid = randomUUID();
    const requestId = randomUUID();
    const isFollowup = !!followUp?.backendUuid;

    const params: Record<string, any> = {
      attachments: [],
      language,
      timezone: "America/Los_Angeles",
      search_focus: "internet",
      sources,
      search_recency_filter: null,
      frontend_uuid: frontendUuid,
      mode,
      model_preference: modelPreference,
      is_related_query: false,
      is_sponsored: false,
      frontend_context_uuid: frontendContextUuid,
      prompt_source: "user",
      query_source: isFollowup ? "followup" : "home",
      is_incognito: false,
      time_from_first_type: 5000 + Math.floor(Math.random() * 15000),
      local_search_enabled: false,
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      supported_block_use_cases: SUPPORTED_BLOCK_USE_CASES,
      client_coordinates: null,
      mentions: [],
      dsl_query: query,
      skip_search_enabled: true,
      is_nav_suggestions_disabled: false,
      source: "default",
      always_search_override: false,
      override_no_search: false,
      should_ask_for_mcp_tool_confirmation: true,
      browser_agent_allow_once_from_toggle: false,
      force_enable_browser_agent: false,
      supported_features: ["browser_agent_permission_banner_v1.1"],
      version: "2.18",
    };

    if (isFollowup) {
      params.last_backend_uuid = followUp!.backendUuid;
      params.read_write_token = followUp!.readWriteToken ?? null;
      params.followup_source = "link";
    }

    const body = { params, query_str: query };

    // Execute the fetch from inside the browser context (bypasses Cloudflare)
    const rawResponse = await this.page.evaluate(
      async ({ url, requestBody, reqId }: { url: string; requestBody: string; reqId: string }) => {
        const resp = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "accept": "text/event-stream",
            "content-type": "application/json",
            "x-perplexity-request-reason": "perplexity-query-state-provider",
            "x-request-id": reqId,
          },
          body: requestBody,
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`Perplexity request failed: ${resp.status} ${text.slice(0, 300)}`);
        }

        // Read the full response text (SSE stream)
        return await resp.text();
      },
      { url: QUERY_ENDPOINT, requestBody: JSON.stringify(body), reqId: requestId }
    );

    return this.parseSSEText(rawResponse);
  }

  /**
   * Submit an ASI/Computer mode task and wait for it to complete.
   *
   * Flow (discovered from browser HAR capture):
   * 1. POST /rest/sse/perplexity_ask → initial SSE with status: PENDING + backend_uuid
   * 2. POST /rest/sse/perplexity_ask/reconnect/{backend_uuid} → SSE stream with
   *    progressive updates until status: COMPLETED + step_type: FINAL
   * 3. Parse FINAL event blocks: workflow_block (answer text + workflow sources),
   *    web_result_block (citation sources), pending_followups_block
   */
  async computeASI(opts: {
    query: string;
    modelPreference?: string;
    language?: string;
    timeoutMs?: number;
  }): Promise<SearchResult> {
    if (!this.page) {
      throw new Error("Client not initialized. Call init() first.");
    }

    const {
      query,
      modelPreference = "pplx_asi",
      language = "en-US",
      timeoutMs = 180_000,
    } = opts;

    if (!query || !query.trim()) {
      throw new Error("Query cannot be empty. Please provide a question or task for Computer mode.");
    }

    const frontendUuid = randomUUID();
    const frontendContextUuid = randomUUID();
    const requestId = randomUUID();

    const params: Record<string, any> = {
      attachments: [],
      language,
      timezone: "America/Los_Angeles",
      search_focus: "internet",
      sources: ["web"],
      search_recency_filter: null,
      frontend_uuid: frontendUuid,
      mode: "copilot",
      model_preference: modelPreference,
      is_related_query: false,
      is_sponsored: false,
      frontend_context_uuid: frontendContextUuid,
      prompt_source: "user",
      query_source: "home",
      is_incognito: false,
      time_from_first_type: 5000 + Math.floor(Math.random() * 15000),
      local_search_enabled: false,
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      supported_block_use_cases: SUPPORTED_BLOCK_USE_CASES,
      client_coordinates: null,
      mentions: [],
      dsl_query: query,
      skip_search_enabled: true,
      is_nav_suggestions_disabled: false,
      source: "default",
      always_search_override: false,
      override_no_search: false,
      should_ask_for_mcp_tool_confirmation: true,
      browser_agent_allow_once_from_toggle: false,
      force_enable_browser_agent: false,
      supported_features: ["browser_agent_permission_banner_v1.1"],
      version: "2.18",
    };

    const body = { params, query_str: query };

    // Step 1: Submit the ASI task
    const rawSSE: string = await this.page.evaluate(
      async ({ url, requestBody, reqId }: { url: string; requestBody: string; reqId: string }) => {
        const resp = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "accept": "text/event-stream",
            "content-type": "application/json",
            "x-perplexity-request-reason": "perplexity-query-state-provider",
            "x-request-id": reqId,
          },
          body: requestBody,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`ASI submit failed: ${resp.status} ${text.slice(0, 300)}`);
        }
        return await resp.text();
      },
      { url: QUERY_ENDPOINT, requestBody: JSON.stringify(body), reqId: requestId }
    );

    // Parse initial SSE to get backend_uuid + thread slug
    const dataLine = rawSSE.split("\n").find(l => l.startsWith("data: "));
    if (!dataLine) throw new Error("No data in ASI response");
    const initialData = JSON.parse(dataLine.slice(6));

    const threadSlug = initialData.thread_url_slug;
    const backendUuid = initialData.backend_uuid;
    const readWriteToken = initialData.read_write_token;

    if (!backendUuid) throw new Error("No backend_uuid in ASI response");
    console.error(`[perplexity-mcp] ASI task submitted: ${threadSlug || backendUuid} (reconnecting for result...)`);

    // Step 2: Streaming reconnect loop.
    //
    // The reconnect SSE endpoint streams events in real-time. For short tasks,
    // the COMPLETED event arrives on the first connection. For long tasks, the
    // connection may drop (CDN/proxy timeout ~30s) before COMPLETED arrives.
    // We reconnect in a loop until we catch the COMPLETED event live.
    //
    // Fallback: If the loop times out, poll GET /rest/thread/{slug} and
    // extract answer from the workflow_block in the last available SSE snapshot.
    //
    const reconnectUrl = `${QUERY_ENDPOINT}/reconnect/${backendUuid}`;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    this.page.setDefaultTimeout(timeoutMs + 30_000);

    // --- Phase A: Streaming reconnect loop ---
    let reconnectAttempt = 0;
    let lastSSEData: string | null = null;

    while (Date.now() < deadline - 5000) {
      reconnectAttempt++;
      const remaining = deadline - Date.now();
      console.error(`[perplexity-mcp] ASI reconnect #${reconnectAttempt} (${Math.round(remaining / 1000)}s remaining)...`);

      try {
        const sseText: string = await this.page.evaluate(
          async ({ url, timeoutMs }: { url: string; timeoutMs: number }) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
              const resp = await fetch(url, {
                method: "POST",
                credentials: "include",
                signal: controller.signal,
                headers: {
                  "accept": "text/event-stream",
                  "content-type": "application/json",
                  "x-perplexity-request-reason": "reconnect-stream",
                  "x-request-id": crypto.randomUUID(),
                },
                body: JSON.stringify({ reconnectInitialSnapshot: true }),
              });
              if (!resp.ok) {
                const errText = await resp.text().catch(() => "");
                return `ERROR:${resp.status}:${errText.slice(0, 500)}`;
              }
              const reader = resp.body!.getReader();
              const decoder = new TextDecoder();
              let accumulated = "";
              let completedSeen = false;
              while (true) {
                // After seeing top-level COMPLETED, drain for 5s to get full event
                let readResult: ReadableStreamReadResult<Uint8Array>;
                if (completedSeen) {
                  const read = reader.read();
                  const timeout = new Promise<ReadableStreamReadResult<Uint8Array>>(
                    r => setTimeout(() => r({ done: true, value: undefined as any }), 5000));
                  readResult = await Promise.race([read, timeout]);
                } else {
                  readResult = await reader.read();
                }
                if (readResult.done) break;
                accumulated += decoder.decode(readResult.value, { stream: true });
                if (!completedSeen && accumulated.includes('"status":"COMPLETED"')) {
                  completedSeen = true;
                }
                if (accumulated.includes("event:end_of_stream") ||
                    accumulated.includes("event: end_of_stream")) {
                  break;
                }
              }
              reader.cancel().catch(() => {});
              return accumulated;
            } catch (e: any) {
              if (e.name === "AbortError") return "ERROR:TIMEOUT:stream timeout";
              return `ERROR:FETCH:${e.message || e}`;
            } finally {
              clearTimeout(timer);
            }
          },
          { url: reconnectUrl, timeoutMs: Math.min(remaining, 90_000) }
        );

        if (sseText.startsWith("ERROR:")) {
          console.error(`[perplexity-mcp] ASI reconnect #${reconnectAttempt}: ${sseText.slice(0, 100)}`);
          await this.page!.waitForTimeout(8000);
          continue;
        }

        // Keep the latest SSE data for fallback extraction
        if (sseText.length > (lastSSEData?.length || 0)) {
          lastSSEData = sseText;
        }

        const result = this.parseASIReconnectSSE(sseText, threadSlug, backendUuid, readWriteToken);
        if (!result.answer.startsWith("ASI task may still be running")) {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          console.error(`[perplexity-mcp] ASI completed via reconnect #${reconnectAttempt} (${elapsed}s).`);
          this.page.setDefaultTimeout(30_000);
          // Download any generated files
          if (result.files?.length) {
            await this.downloadASIFiles(result.files, threadSlug);
          }
          return result;
        }

        console.error(`[perplexity-mcp] ASI reconnect #${reconnectAttempt}: stream ended without COMPLETED (${sseText.length} chars), retrying in 5s...`);
        await this.page!.waitForTimeout(5000);
      } catch (err: any) {
        console.error(`[perplexity-mcp] ASI reconnect #${reconnectAttempt} error: ${err.message?.slice(0, 150)}`);
        await this.page!.waitForTimeout(8000);
      }
    }

    // --- Phase B: Fallback extraction ---
    // The reconnect loop timed out without catching COMPLETED live.
    // Try to extract answer from the last SSE snapshot's workflow_block,
    // or poll the thread endpoint for final status.
    console.error(`[perplexity-mcp] ASI reconnect loop exhausted. Attempting fallback extraction...`);

    // First, try to extract from the last SSE snapshot's workflow_block
    if (lastSSEData) {
      const result = this.extractFromWorkflowBlock(lastSSEData, threadSlug, backendUuid, readWriteToken);
      if (result) {
        this.page.setDefaultTimeout(30_000);
        return result;
      }
    }

    // Poll thread endpoint once to check if it's done
    if (threadSlug) {
      try {
        const rawJson: string = await this.page.evaluate(
          async (url: string) => {
            const resp = await fetch(url, { credentials: "include" });
            return await resp.text();
          },
          THREAD_ENDPOINT(threadSlug)
        );
        const threadData = JSON.parse(rawJson);
        if (threadData.status === "success") {
          const entries = threadData.entries || [];
          const lastEntry = entries[entries.length - 1];
          if (lastEntry) {
            return this.parseASIThreadEntry(lastEntry, threadSlug, backendUuid, readWriteToken);
          }
        }
      } catch (err: any) {
        console.error(`[perplexity-mcp] ASI thread fallback error: ${err.message?.slice(0, 100)}`);
      }
    }

    this.page.setDefaultTimeout(30_000);
    console.error(`[perplexity-mcp] ASI task timed out after ${timeoutMs / 1000}s.`);
    return {
      answer: `ASI task timed out after ${timeoutMs / 1000}s. The task may still be running.\nView results at: ${PERPLEXITY_URL}/search/${threadSlug}`,
      sources: [],
      media: [],
      suggestedFollowups: [],
      threadUrl: `${PERPLEXITY_URL}/search/${threadSlug}`,
    };
  }

  /**
   * Re-fetch results from a Perplexity thread that may have completed after we timed out.
   * Tries reconnect SSE first (using backendUuid), then falls back to thread endpoint.
   */
  async retrieveThread(opts: {
    threadSlug: string;
    backendUuid?: string | null;
    readWriteToken?: string | null;
  }): Promise<SearchResult> {
    if (!this.page) {
      throw new Error("Client not initialized. Call init() first.");
    }

    const { threadSlug, backendUuid, readWriteToken } = opts;

    // Try reconnect SSE if we have a backendUuid
    if (backendUuid) {
      try {
        const reconnectUrl = `${QUERY_ENDPOINT}/reconnect/${backendUuid}`;
        console.error(`[perplexity-mcp] Retrieving via reconnect: ${backendUuid}`);

        const sseText: string = await this.page.evaluate(
          async ({ url }: { url: string }) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            try {
              const resp = await fetch(url, {
                method: "POST",
                credentials: "include",
                signal: controller.signal,
                headers: {
                  "accept": "text/event-stream",
                  "content-type": "application/json",
                  "x-perplexity-request-reason": "reconnect-stream",
                  "x-request-id": crypto.randomUUID(),
                },
                body: JSON.stringify({ reconnectInitialSnapshot: true }),
              });
              if (!resp.ok) return `ERROR:${resp.status}`;
              const reader = resp.body!.getReader();
              const decoder = new TextDecoder();
              let accumulated = "";
              let completedSeen = false;
              while (true) {
                let readResult: ReadableStreamReadResult<Uint8Array>;
                if (completedSeen) {
                  const read = reader.read();
                  const timeout = new Promise<ReadableStreamReadResult<Uint8Array>>(
                    r => setTimeout(() => r({ done: true, value: undefined as any }), 5000));
                  readResult = await Promise.race([read, timeout]);
                } else {
                  readResult = await reader.read();
                }
                if (readResult.done) break;
                accumulated += decoder.decode(readResult.value, { stream: true });
                if (!completedSeen && accumulated.includes('"status":"COMPLETED"')) {
                  completedSeen = true;
                }
                if (accumulated.includes("event:end_of_stream") ||
                    accumulated.includes("event: end_of_stream")) {
                  break;
                }
              }
              reader.cancel().catch(() => {});
              return accumulated;
            } catch (e: any) {
              if (e.name === "AbortError") return "ERROR:TIMEOUT";
              return `ERROR:FETCH:${e.message || e}`;
            } finally {
              clearTimeout(timer);
            }
          },
          { url: reconnectUrl }
        );

        if (!sseText.startsWith("ERROR:")) {
          const result = this.parseASIReconnectSSE(sseText, threadSlug, backendUuid, readWriteToken ?? "");
          if (!result.answer.startsWith("ASI task may still be running")) {
            console.error(`[perplexity-mcp] Retrieved completed result via reconnect.`);
            if (result.files?.length) {
              await this.downloadASIFiles(result.files, threadSlug);
            }
            return result;
          }

          // Try workflow block extraction
          const wbResult = this.extractFromWorkflowBlock(sseText, threadSlug, backendUuid, readWriteToken ?? "");
          if (wbResult) {
            console.error(`[perplexity-mcp] Retrieved result via workflow block extraction.`);
            return wbResult;
          }
        }
      } catch (err: any) {
        console.error(`[perplexity-mcp] Reconnect retrieval failed: ${err.message?.slice(0, 100)}`);
      }
    }

    // Fallback: GET /rest/thread/{slug}
    if (threadSlug) {
      console.error(`[perplexity-mcp] Retrieving via thread endpoint: ${threadSlug}`);
      try {
        const rawJson: string = await this.page.evaluate(
          async (url: string) => {
            const resp = await fetch(url, { credentials: "include" });
            return await resp.text();
          },
          THREAD_ENDPOINT(threadSlug)
        );
        const threadData = JSON.parse(rawJson);
        if (threadData.status === "success") {
          const entries = threadData.entries || [];
          const lastEntry = entries[entries.length - 1];
          if (lastEntry) {
            const result = this.parseASIThreadEntry(lastEntry, threadSlug, backendUuid ?? "", readWriteToken ?? "");
            console.error(`[perplexity-mcp] Retrieved result via thread endpoint.`);
            return result;
          }
        }
        // Thread exists but no completed entries yet
        return {
          answer: `Thread exists but task is still running. Try again later.\nView at: ${PERPLEXITY_URL}/search/${threadSlug}`,
          sources: [],
          media: [],
          suggestedFollowups: [],
          threadUrl: `${PERPLEXITY_URL}/search/${threadSlug}`,
        };
      } catch (err: any) {
        throw new Error(`Failed to retrieve thread ${threadSlug}: ${err.message}`);
      }
    }

    throw new Error("No threadSlug or backendUuid provided for retrieval.");
  }

  /**
   * Parse the reconnect SSE stream from an ASI task.
   *
   * The SSE stream contains progressive events. The FINAL event has:
   * - status: COMPLETED, step_type: FINAL, text_completed: true
   * - blocks[]: workflow_root (workflow_block with steps/items/text),
   *   web_results (web_result_block), pending_followups, sources_answer_mode
   */
  private parseASIReconnectSSE(
    sseText: string,
    threadSlug: string,
    backendUuid: string,
    readWriteToken: string,
  ): SearchResult {
    const events = sseText.split(/\r?\n\r?\n/);
    let finalData: any = null;

    // Find the last event with status: COMPLETED or step_type: FINAL
    for (const event of events) {
      // SSE data lines may use "data: " (with space) or "data:" (no space)
      let dataIdx = event.indexOf("data: ");
      let dataOffset = 6;
      if (dataIdx === -1) {
        dataIdx = event.indexOf("data:");
        dataOffset = 5;
      }
      if (dataIdx === -1) continue;
      const jsonStr = event.slice(dataIdx + dataOffset);
      try {
        const data = JSON.parse(jsonStr);
        if (data.status === "COMPLETED" || data.step_type === "FINAL") {
          finalData = data;
        }
        // Also capture thread slug if we didn't have it
        if (!threadSlug && data.thread_url_slug) {
          threadSlug = data.thread_url_slug;
        }
      } catch { /* skip unparseable */ }
    }

    // Catalog all block usages, item types, and payload types across all events
    const allBlockUsages = new Set<string>();
    const allItemTypes = new Set<string>();
    const allPayloadTypes = new Set<string>();
    for (const event of events) {
      let di = event.indexOf("data: ");
      let doff = 6;
      if (di === -1) { di = event.indexOf("data:"); doff = 5; }
      if (di === -1) continue;
      try {
        const d = JSON.parse(event.slice(di + doff));
        for (const b of (d.blocks || [])) {
          allBlockUsages.add(b.intended_usage || "?");
          if (b.workflow_block?.steps) {
            for (const s of b.workflow_block.steps) {
              for (const item of (s.items || [])) {
                allItemTypes.add(item.type || "?");
                if (item.payload) for (const [k, v] of Object.entries(item.payload)) { if (v != null) allPayloadTypes.add(k); }
              }
            }
          }
          if (b.diff_block?.patches) {
            for (const p of b.diff_block.patches) {
              if (p.value?.type) allItemTypes.add(p.value.type);
              if (p.value?.payload) for (const [k, v] of Object.entries(p.value.payload as Record<string, any>)) { if (v != null) allPayloadTypes.add(k); }
            }
          }
        }
      } catch { /* skip */ }
    }
    console.error(`[perplexity-mcp] ASI blocks: ${[...allBlockUsages].join(", ")}`);
    console.error(`[perplexity-mcp] ASI item types: ${[...allItemTypes].join(", ")}`);
    console.error(`[perplexity-mcp] ASI payload types: ${[...allPayloadTypes].join(", ")}`);

    if (!finalData) {
      console.error("[perplexity-mcp] ASI: No FINAL event found in reconnect stream.");
      return {
        answer: `ASI task may still be running. View results at: ${PERPLEXITY_URL}/search/${threadSlug}`,
        sources: [],
        media: [],
        suggestedFollowups: [],
        threadUrl: threadSlug ? `${PERPLEXITY_URL}/search/${threadSlug}` : undefined,
      };
    }

    console.error(`[perplexity-mcp] ASI task completed (status=${finalData.status}).`);

    // Extract data from blocks. Cast at the JSON-parse boundary: `finalData`
    // is `any` (parsed wire JSON), and `blocks` is the only place we narrow
    // its untyped shape into the typed discriminated union.
    const blocks: WorkflowBlock[] = (finalData.blocks || []) as WorkflowBlock[];
    let answer = "";
    const webSources: SearchResult["sources"] = [];
    const followups: string[] = [];
    const files: ASIFile[] = [];

    for (const block of blocks) {
      // workflow_root → workflow_block: contains the answer text and inline sources
      if (block.intended_usage === "workflow_root" && block.workflow_block) {
        const wb = block.workflow_block;
        const steps = wb.steps || [];

        // Walk through steps to find text payloads and source payloads
        for (const step of steps) {
          for (const item of (step.items || [])) {
            const payload = item.payload || {};

            // Text payload — the main answer
            if (payload.text_payload?.text) {
              if (answer) answer += "\n\n";
              answer += payload.text_payload.text;
            }

            // Sources payload (inline in workflow)
            if (payload.sources_payload?.sources) {
              for (const src of payload.sources_payload.sources) {
                webSources.push({
                  title: src.name ?? "",
                  url: src.url ?? "",
                  snippet: src.snippet ?? "",
                });
              }
            }
          }
        }
      }

      // web_results block: citation sources (may overlap with workflow sources)
      if (block.intended_usage === "web_results" && block.web_result_block?.web_results) {
        // Only add if we don't already have sources from workflow
        if (webSources.length === 0) {
          for (const wr of block.web_result_block.web_results) {
            webSources.push({
              title: wr.name ?? "",
              url: wr.url ?? "",
              snippet: wr.snippet ?? "",
            });
          }
        }
      }

      // assets block — files generated by ASI (spreadsheets, documents, etc.)
      if (block.intended_usage === "assets_answer_mode" && block.assets_mode_block?.assets) {
        const seenUrls = new Set<string>();
        for (const asset of block.assets_mode_block.assets) {
          // Downloadable files (XLSX, CSV, etc.) have download_info
          if (asset.download_info) {
            for (const dl of asset.download_info) {
              if (dl.url && dl.filename && !seenUrls.has(dl.url)) {
                seenUrls.add(dl.url);
                files.push({
                  filename: dl.filename,
                  assetType: asset.asset_type || "UNKNOWN",
                  url: dl.url,
                  size: dl.size || undefined,
                  mediaType: dl.media_type || undefined,
                });
              }
            }
          }
        }
      }

      // pending_followups block
      if (block.intended_usage === "pending_followups" && block.pending_followups_block?.followups) {
        for (const f of block.pending_followups_block.followups) {
          if (typeof f === "string") followups.push(f);
          else if (f?.text) followups.push(f.text);
        }
      }
    }

    // Fallback if no text found in workflow blocks
    answer = answer.trim() || `ASI task completed. View full results at: ${PERPLEXITY_URL}/search/${threadSlug}`;

    if (files.length > 0) {
      console.error(`[perplexity-mcp] ASI: ${files.length} file(s) detected: ${files.map(f => f.filename).join(", ")}`);
    }

    return {
      answer,
      sources: webSources,
      media: [],
      files: files.length > 0 ? files : undefined,
      suggestedFollowups: followups,
      threadUrl: threadSlug ? `${PERPLEXITY_URL}/search/${threadSlug}` : undefined,
      followUp: {
        backendUuid,
        readWriteToken,
        threadUrlSlug: threadSlug,
        threadTitle: finalData.thread_title || null,
      },
    };
  }

  /**
   * Download files generated by ASI tasks.
   *
   * Uses Playwright's `APIRequestContext` (`context.request.get`) instead of
   * an in-page `fetch()`. ASI assets typically live on off-origin CDN buckets
   * (e.g. `pplx-res.cloudinary.com`, GCS, S3); fetching them from inside the
   * Perplexity origin would trip CORS unless the browser was launched with
   * `--disable-web-security` — which we no longer do (see STEALTH_ARGS note).
   *
   * `APIRequestContext` runs outside the page context, automatically inherits
   * cookies from the BrowserContext, and is not subject to the same-origin
   * policy, so it works for both same-origin and off-origin asset URLs.
   *
   * Files are saved to ~/.perplexity-mcp/downloads/<threadSlug>/.
   *
   * Public contract is preserved: this still mutates each `file.localPath`
   * in-place on success and silently skips on failure (logs to stderr).
   */
  private async downloadASIFiles(files: ASIFile[], threadSlug: string): Promise<void> {
    if (!this.context || files.length === 0) return;

    const downloadDir = join(getConfigDir(), "downloads", threadSlug || "unknown");
    if (!existsSync(downloadDir)) {
      mkdirSync(downloadDir, { recursive: true });
    }

    for (const file of files) {
      if (!file.url) continue;
      try {
        console.error(`[perplexity-mcp] Downloading: ${file.filename} (${file.size ? Math.round(file.size / 1024) + "KB" : "unknown size"})...`);

        const response = await this.context.request.get(file.url, {
          // Conservative ceiling — assets are usually small (KB to a few MB).
          // Prevents an unresponsive CDN from stalling the MCP request loop.
          timeout: 60_000,
        });

        if (!response.ok()) {
          console.error(`[perplexity-mcp] Download failed for ${file.filename}: ERROR:${response.status()}`);
          continue;
        }

        const body = await response.body();
        const filePath = join(downloadDir, file.filename);
        writeFileSync(filePath, body);
        file.localPath = filePath;
        console.error(`[perplexity-mcp] Saved: ${filePath} (${body.length} bytes)`);
      } catch (err: any) {
        console.error(`[perplexity-mcp] Download error for ${file.filename}: ${err.message?.slice(0, 100)}`);
      }
    }
  }

  /**
   * Parse a completed ASI thread entry from GET /rest/thread/{slug}.
   * Used as fallback (Phase B) when streaming reconnect doesn't complete in time.
   *
   * Thread entry structure:
   * - plan.goals[].description — answer text (simple queries)
   * - text — JSON string of steps, FINAL step may have content.answer with full text + web_results
   * - step_type: "FINAL", status: "completed"
   */
  /**
   * Extract answer from the workflow_block in the last SSE snapshot.
   * Used when the reconnect loop didn't catch COMPLETED live but we have
   * a snapshot with workflow_block data (steps, items, sources).
   */
  private extractFromWorkflowBlock(
    sseText: string,
    threadSlug: string,
    backendUuid: string,
    readWriteToken: string,
  ): SearchResult | null {
    const events = sseText.split(/\r?\n\r?\n/);
    let lastData: any = null;

    // Find the last parseable event (largest snapshot)
    for (const event of events) {
      let di = event.indexOf("data: ");
      let doff = 6;
      if (di === -1) { di = event.indexOf("data:"); doff = 5; }
      if (di === -1) continue;
      try {
        const d = JSON.parse(event.slice(di + doff));
        if (d.blocks) lastData = d;
      } catch { /* skip */ }
    }

    if (!lastData?.blocks) return null;

    // Cast at the JSON-parse boundary: `lastData` is `any` (parsed wire JSON),
    // and `blocks` is the only place we narrow it into the typed union.
    const blocks: WorkflowBlock[] = lastData.blocks as WorkflowBlock[];
    const wfBlock = blocks.find(
      (b): b is WorkflowRootBlock => b.intended_usage === "workflow_root",
    )?.workflow_block;
    if (!wfBlock?.steps) return null;

    // Extract text from WORKFLOW_ITEM_TEXT items across all steps
    const textParts: string[] = [];
    const webSources: SearchResult["sources"] = [];
    const followups: string[] = [];

    for (const step of wfBlock.steps) {
      for (const item of (step.items || [])) {
        if (item.payload?.text_payload?.text) {
          textParts.push(item.payload.text_payload.text);
        }
      }
    }

    // Extract sources from web_result_block
    const wrBlock = blocks.find(
      (b): b is WebResultsBlock => b.intended_usage === "web_results",
    )?.web_result_block;
    if (wrBlock?.web_results) {
      for (const wr of wrBlock.web_results) {
        if (wr.url) {
          webSources.push({ title: wr.name ?? "", url: wr.url, snippet: wr.snippet ?? "" });
        }
      }
    }

    // Extract followups
    const pfBlock = blocks.find(
      (b): b is PendingFollowupsBlock => b.intended_usage === "pending_followups",
    )?.pending_followups_block;
    if (pfBlock?.followups) {
      for (const f of pfBlock.followups) {
        if (typeof f === "string") followups.push(f);
        else if (f.text) followups.push(f.text);
      }
    }

    const answer = textParts.join("\n\n").trim();
    if (!answer && webSources.length === 0) return null;

    const threadUrl = threadSlug ? `${PERPLEXITY_URL}/search/${threadSlug}` : undefined;
    console.error(`[perplexity-mcp] ASI: extracted ${textParts.length} text fragments (${answer.length} chars) + ${webSources.length} sources from workflow_block.`);

    return {
      answer: answer || `ASI task completed. View full results at: ${threadUrl}`,
      sources: webSources,
      media: [],
      suggestedFollowups: followups,
      threadUrl,
      followUp: { backendUuid, readWriteToken, threadUrlSlug: threadSlug, threadTitle: null },
    };
  }

  private parseASIThreadEntry(
    entry: any,
    threadSlug: string,
    backendUuid: string,
    readWriteToken: string,
  ): SearchResult {
    let answer = "";
    const webSources: SearchResult["sources"] = [];
    const followups: string[] = [];

    // Try to extract answer from the `text` field (JSON array of steps)
    try {
      const steps = JSON.parse(entry.text || "[]");
      const finalStep = steps.find((s: any) => s.step_type === "FINAL");
      if (finalStep?.content?.answer) {
        const answerData = typeof finalStep.content.answer === "string"
          ? JSON.parse(finalStep.content.answer)
          : finalStep.content.answer;

        if (answerData.text) answer = answerData.text;

        // Extract sources from answer's web_results
        if (answerData.web_results) {
          for (const wr of answerData.web_results) {
            webSources.push({
              title: wr.name ?? "",
              url: wr.url ?? "",
              snippet: wr.snippet ?? "",
            });
          }
        }
      }
    } catch { /* text field may not be valid JSON */ }

    // Fallback: extract from plan.goals
    if (!answer && entry.plan?.goals) {
      const goals = entry.plan.goals;
      // Use the last goal with a description (usually the final answer)
      for (let i = goals.length - 1; i >= 0; i--) {
        if (goals[i].description && goals[i].description.trim()) {
          answer = goals[i].description;
          break;
        }
      }
    }

    // Fallback: try workflow_items in the entry
    if (!answer && entry.workflow_items) {
      for (const item of entry.workflow_items) {
        if (item.payload?.text_payload?.text) {
          if (answer) answer += "\n\n";
          answer += item.payload.text_payload.text;
        }
      }
    }

    answer = answer.trim() || `ASI task completed. View full results at: ${PERPLEXITY_URL}/search/${threadSlug}`;

    return {
      answer,
      sources: webSources,
      media: [],
      suggestedFollowups: followups,
      threadUrl: threadSlug ? `${PERPLEXITY_URL}/search/${threadSlug}` : undefined,
      followUp: {
        backendUuid,
        readWriteToken,
        threadUrlSlug: threadSlug,
        threadTitle: entry.thread_title || null,
      },
    };
  }

  private parseSSEText(text: string): SearchResult {
    let fullAnswer = "";
    let fullReasoning = "";
    const webSources: SearchResult["sources"] = [];
    const media: SearchResult["media"] = [];
    const followups: string[] = [];
    let backendUuid: string | null = null;
    let readWriteToken: string | null = null;
    let threadUrlSlug: string | null = null;
    let threadTitle: string | null = null;

    // Research mode uses tabbed sections (ask_text_N_markdown).
    // Track each section separately so we can assemble the full report.
    const sectionTexts: Map<string, string> = new Map();
    let summaryText = "";

    // SSE events are separated by double newlines (could be \r\n\r\n or \n\n)
    const events = text.split(/\r?\n\r?\n/);

    for (const event of events) {
      if (event.startsWith("event: end_of_stream")) break;
      if (!event.startsWith("event: message")) continue;

      const dataIdx = event.indexOf("data: ");
      if (dataIdx === -1) continue;

      let jsonData: any;
      try {
        jsonData = JSON.parse(event.slice(dataIdx + 6));
      } catch {
        continue;
      }

      // Capture conversation metadata
      if (jsonData.backend_uuid) backendUuid = jsonData.backend_uuid;
      if (jsonData.read_write_token && !readWriteToken)
        readWriteToken = jsonData.read_write_token;
      if (jsonData.thread_url_slug && !threadUrlSlug)
        threadUrlSlug = jsonData.thread_url_slug;
      if (jsonData.thread_title) threadTitle = jsonData.thread_title;

      // Follow-up suggestions
      if (jsonData.related_query_items) {
        for (const item of jsonData.related_query_items) {
          if (item.text) followups.push(item.text);
        }
      }

      // Process blocks (schematized API)
      for (const block of jsonData.blocks ?? []) {
        const intended = block.intended_usage ?? "";

        // Sources
        if (intended === "sources_answer_mode") {
          const results = block.sources_mode_block?.web_results ?? [];
          for (const r of results) {
            webSources.push({
              title: r.name ?? "",
              url: r.url ?? "",
              snippet: r.snippet ?? "",
            });
          }
          continue;
        }

        // Media
        if (intended === "media_items") {
          for (const item of block.media_block?.media_items ?? []) {
            media.push({
              type: item.medium ?? "",
              url: item.url ?? "",
              name: item.name ?? "",
            });
          }
          continue;
        }

        // Diff patches (answer text + reasoning)
        const field = block.diff_block?.field ?? "";
        // Determine if this is a research section (ask_text_N_markdown)
        const isSection = /^ask_text_\d+_markdown$/.test(intended);
        const isSummary = intended === "ask_text";

        for (const patch of block.diff_block?.patches ?? []) {
          const path: string = patch.path ?? "";
          let value: any = patch.value ?? "";

          if (path === "/progress") continue;

          // Reasoning
          if (path.startsWith("/goals")) {
            if (typeof value === "object" && value?.chunks) {
              value = (value.chunks as string[]).join("");
            }
            if (typeof value === "string" && value) {
              if (value.startsWith(fullReasoning)) {
                value = value.slice(fullReasoning.length);
              }
              fullReasoning += value;
            }
            continue;
          }

          // Main answer / report sections
          if (field !== "markdown_block") continue;

          // Extract text from object values (chunks array or answer string)
          if (typeof value === "object" && value !== null) {
            if (Array.isArray(value.chunks) && value.chunks.length > 0) {
              value = value.chunks.join("");
            } else {
              value = value.answer ?? "";
            }
          }
          if (typeof value !== "string" || !value) continue;

          if (isSection) {
            // Research report section — accumulate per-section
            const prev = sectionTexts.get(intended) ?? "";
            sectionTexts.set(intended, prev + value);
          } else if (isSummary) {
            // Research summary (ask_text) — accumulate separately
            summaryText += value;
          } else {
            // Regular search/reason answer
            if (value.startsWith(fullAnswer)) {
              value = value.slice(fullAnswer.length);
            } else if (fullAnswer.endsWith(value)) {
              value = "";
            }
            fullAnswer += value;
          }
        }
      }

      // Legacy non-schematized text field fallback
      if (jsonData.text && !fullAnswer && sectionTexts.size === 0 && !summaryText) {
        try {
          const parsed =
            typeof jsonData.text === "string"
              ? JSON.parse(jsonData.text)
              : jsonData.text;
          if (Array.isArray(parsed)) {
            for (const step of parsed) {
              if (step.step_type === "FINAL" && step.content?.answer) {
                const answerObj = JSON.parse(step.content.answer);
                fullAnswer = answerObj.answer ?? "";
                break;
              }
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    // Assemble final answer: research report sections, summary, or regular answer
    if (sectionTexts.size > 1) {
      // Multi-section research report — assemble full report from sorted sections
      const sortedSections = [...sectionTexts.entries()]
        .sort(([a], [b]) => {
          const numA = parseInt(a.match(/\d+/)?.[0] ?? "0");
          const numB = parseInt(b.match(/\d+/)?.[0] ?? "0");
          return numA - numB;
        })
        .map(([, text]) => text.trim())
        .filter(t => t.length > 0);

      if (sortedSections.length > 0) {
        fullAnswer = sortedSections.join("\n\n");
        console.error(`[perplexity-mcp] Research report: ${sectionTexts.size} sections, ${fullAnswer.length} chars total.`);
      }
    } else if (sectionTexts.size === 1) {
      // Single section — use it directly (regular search/reason with ask_text_0_markdown)
      const singleSection = [...sectionTexts.values()][0].trim();
      if (singleSection.length > fullAnswer.length) {
        fullAnswer = singleSection;
      }
    }
    // If we have a summary but no section content, use the summary
    if (!fullAnswer && summaryText) {
      fullAnswer = summaryText.trim();
    }

    const result: SearchResult = {
      answer: fullAnswer.trim(),
      sources: webSources,
      media,
      suggestedFollowups: followups,
    };

    if (fullReasoning) result.reasoning = fullReasoning.trim();

    if (backendUuid) {
      result.followUp = {
        backendUuid,
        readWriteToken,
        threadUrlSlug,
        threadTitle,
      };
    }

    if (threadUrlSlug) {
      result.threadUrl = `${PERPLEXITY_URL}/search/${threadUrlSlug}`;
    }

    return result;
  }

  /**
   * Execute arbitrary JS in the browser context. Used for API inspection.
   */
  async evaluateInBrowser<T>(fn: (...args: any[]) => Promise<T>, arg?: any): Promise<T> {
    if (!this.page) throw new Error("Client not initialized");
    return this.page.evaluate(fn as any, arg);
  }

  /**
   * Navigate to a URL, intercept network requests for a duration, return matched ones.
   */
  async interceptRequests(
    url: string,
    durationMs: number,
    filter: (url: string) => boolean
  ): Promise<Array<{ method: string; url: string; status: number; body?: string }>> {
    if (!this.page) throw new Error("Client not initialized");
    const captured: Array<{ method: string; url: string; status: number; body?: string }> = [];

    const handler = async (response: any) => {
      const reqUrl: string = response.url();
      if (filter(reqUrl)) {
        let body: string | undefined;
        try { body = await response.text(); } catch { /* ignore */ }
        captured.push({
          method: response.request().method(),
          url: reqUrl,
          status: response.status(),
          body: body?.slice(0, 2000),
        });
      }
    };

    this.page.on("response", handler);
    await this.page.goto(url, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    await this.page.waitForTimeout(durationMs);
    this.page.off("response", handler);

    return captured;
  }

  private async resolveThreadEntryUuid(threadSlug: string): Promise<string | null> {
    if (!this.page) throw new Error("Client not initialized");

    const rawJson: string = await this.page.evaluate(
      async (url: string) => {
        const response = await fetch(url, { credentials: "include" });
        return response.text();
      },
      THREAD_ENDPOINT(threadSlug),
    );

    const threadData = JSON.parse(rawJson);
    if (threadData?.status !== "success") {
      return null;
    }

    const entries = Array.isArray(threadData.entries) ? threadData.entries : [];
    const lastEntry = entries[entries.length - 1] ?? null;
    return lastEntry?.uuid ?? threadData?.last_entry_uuid ?? null;
  }

  async exportThread(opts: {
    threadSlug?: string | null;
    entryUuid?: string | null;
    format: "pdf" | "markdown" | "docx";
  }): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    if (!this.page) throw new Error("Client not initialized");

    const entryUuid = opts.entryUuid ?? (opts.threadSlug ? await this.resolveThreadEntryUuid(opts.threadSlug) : null);
    if (!entryUuid) {
      throw new Error("Could not resolve the Perplexity entry UUID for export.");
    }

    return exportEntry({
      entryUuid,
      format: opts.format,
      fetchImpl: async (url: string, init?: RequestInit) => {
        const response = await this.page!.evaluate(
          async ({ requestUrl, requestInit }) => {
            const resp = await fetch(requestUrl, {
              ...requestInit,
              credentials: "include",
            });
            const text = await resp.text();
            return {
              status: resp.status,
              headers: Object.fromEntries(resp.headers.entries()),
              text,
            };
          },
          {
            requestUrl: url,
            requestInit: {
              method: init?.method,
              headers: init?.headers,
              body: typeof init?.body === "string" ? init.body : undefined,
            },
          },
        );

        return new Response(response.text, {
          status: response.status,
          headers: response.headers,
        });
      },
    });
  }

  /**
   * Authenticated fetch helper — routes through the persistent page so
   * cookies (session-token + cf_clearance) ride along. Mirrors the
   * exportThread() pattern but returns parsed JSON.
   */
  private async pageFetchJson(
    url: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; data: unknown }> {
    if (!this.page) throw new Error("Client not initialized");
    const payload = init?.body != null ? JSON.stringify(init.body) : null;
    return this.page.evaluate(
      async ({ u, method, body, headers }) => {
        const resp = await fetch(u, {
          method: method ?? "GET",
          credentials: "include",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body,
        });
        const ct = resp.headers.get("content-type") ?? "";
        const text = await resp.text();
        let data: unknown = text;
        if (ct.includes("application/json")) {
          try { data = JSON.parse(text); } catch { /* leave as text */ }
        }
        return { status: resp.status, data };
      },
      { u: url, method: init?.method ?? "GET", body: payload, headers: init?.headers ?? null },
    ) as Promise<{ status: number; data: unknown }>;
  }

  /**
   * Fetch a page of the user's library via POST /rest/thread/list_ask_threads.
   * Endpoint captured 2026-04-21 — body shape documented in
   * docs/export-endpoint-capture.md (alongside export).
   */
  async listCloudThreads(opts: {
    limit?: number;
    offset?: number;
    searchTerm?: string;
    excludeAsi?: boolean;
    ascending?: boolean;
  } = {}): Promise<{
    items: Array<{
      backendUuid: string;
      contextUuid: string;
      slug: string;
      title: string;
      queryStr: string;
      answerPreview: string;
      firstAnswer: string | null;
      createdAt: string;
      mode: string | null;
      displayModel: string | null;
      searchFocus: string | null;
      sources: string[];
      queryCount: number;
      threadStatus: string;
      readWriteToken: string | null;
    }>;
    total: number;
  }> {
    const url = buildListAskThreadsUrl();
    const body = buildListAskThreadsBody(opts);

    // Fast path: when impit is installed and we have a logged-in session
    // cookie, POST directly via the Rust client and skip the browser launch
    // entirely. Falls through to the browser path on any non-success outcome
    // so init() still gets a chance to refresh stale cookies.
    if (!this.page && isImpitAvailable()) {
      const fast = await listCloudThreadsViaImpit(opts);
      if (fast) return fast;
    }

    if (!this.page) await this.init();
    const { status, data } = await this.pageFetchJson(url, { method: "POST", body });
    if (status === 403 || status === 401) {
      throw new Error(`Perplexity rejected list_ask_threads (status ${status}). Re-login and retry.`);
    }
    if (status !== 200 || !Array.isArray(data)) {
      throw new Error(`list_ask_threads failed: status ${status}`);
    }
    return parseListThreadsRows(data as Array<Record<string, unknown>>);
  }

  /**
   * Fetch full content of a single cloud thread by slug. Returns the raw
   * entries — callers (cloud-sync) convert to markdown. Endpoint:
   * GET /rest/thread/<slug>?from_first=true (captured 2026-04-21).
   */
  async getCloudThread(slug: string, { limit = 50 }: { limit?: number } = {}): Promise<{
    entries: Array<{
      backendUuid: string;
      queryStr: string;
      answer: string;
      sources: Array<{ n: number; title: string; url: string; snippet?: string }>;
      mediaItems: Array<{ url: string; name?: string; type?: string }>;
      createdAt: string;
      status: string;
    }>;
    thread: { slug: string; title: string | null; contextUuid: string | null };
  }> {
    if (!slug) throw new Error("getCloudThread: slug required");
    if (!this.page) await this.init();
    // NOTE: `with_schematized_response=true` causes Perplexity to return a
    // structured shape that omits the raw `entries[].text` JSON we parse
    // for answer + sources. Keep it off.
    const url =
      `${PERPLEXITY_URL}/rest/thread/${encodeURIComponent(slug)}` +
      `?version=2.18&source=default&limit=${limit}&offset=0&from_first=true&with_parent_info=true`;
    const { status, data } = await this.pageFetchJson(url);
    if (status === 404) throw new Error(`Thread '${slug}' not found on Perplexity (404).`);
    if (status !== 200 || typeof data !== "object" || data == null) {
      throw new Error(`getCloudThread failed: status ${status}`);
    }
    const body = data as Record<string, unknown>;
    const rawEntries = Array.isArray(body.entries) ? body.entries as Array<Record<string, unknown>> : [];

    const parseAnswer = (text: unknown): { answer: string; sources: Array<{ n: number; title: string; url: string; snippet?: string }> } => {
      if (typeof text !== "string") return { answer: "", sources: [] };
      let steps: unknown;
      try { steps = JSON.parse(text); } catch { return { answer: "", sources: [] }; }
      if (!Array.isArray(steps)) return { answer: "", sources: [] };
      const final = steps.find((s: any) => s?.step_type === "FINAL");
      const answerRaw = final?.content?.answer;
      if (typeof answerRaw !== "string") return { answer: "", sources: [] };
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(answerRaw); } catch { return { answer: answerRaw, sources: [] }; }
      const answer = typeof parsed.answer === "string" ? parsed.answer : "";
      const webResults = Array.isArray(parsed.web_results) ? parsed.web_results as Array<Record<string, unknown>> : [];
      const sources = webResults.map((wr, i) => ({
        n: i + 1,
        title: String(wr.name ?? ""),
        url: String(wr.url ?? ""),
        ...(typeof wr.snippet === "string" && wr.snippet ? { snippet: wr.snippet } : {}),
      })).filter((s) => s.title || s.url);
      return { answer, sources };
    };

    return {
      thread: {
        slug,
        title: typeof rawEntries[0]?.thread_title === "string" ? rawEntries[0].thread_title as string : null,
        contextUuid: typeof rawEntries[0]?.context_uuid === "string" ? rawEntries[0].context_uuid as string : null,
      },
      entries: rawEntries.map((e) => {
        const { answer, sources: s } = parseAnswer(e.text);
        const srcFromBlock = Array.isArray(e.sources)
          ? (e.sources as Array<Record<string, unknown>>).map((wr, i) => ({
              n: i + 1,
              title: String(wr.name ?? wr.title ?? ""),
              url: String(wr.url ?? ""),
              ...(typeof wr.snippet === "string" ? { snippet: wr.snippet } : {}),
            })).filter((src) => src.title || src.url)
          : [];
        const createdUs = typeof e.created_us === "number" ? e.created_us : 0;
        const iso = typeof e.updated_datetime === "string"
          ? /[Zz]$/.test(e.updated_datetime) ? e.updated_datetime : `${e.updated_datetime}Z`
          : createdUs > 0
            ? new Date(Math.floor(createdUs / 1000)).toISOString()
            : new Date().toISOString();
        return {
          backendUuid: String(e.backend_uuid ?? ""),
          queryStr: String(e.query_str ?? ""),
          answer: answer || "",
          sources: s.length ? s : srcFromBlock,
          mediaItems: Array.isArray(e.media_items)
            ? (e.media_items as Array<Record<string, unknown>>).map((m) => ({
                url: String(m.url ?? m.image ?? ""),
                name: typeof m.name === "string" ? m.name : undefined,
                type: typeof m.type === "string" ? m.type : undefined,
              })).filter((m) => m.url)
            : [],
          createdAt: iso,
          status: String(e.status ?? "completed").toLowerCase(),
        };
      }),
    };
  }

  async shutdown(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
