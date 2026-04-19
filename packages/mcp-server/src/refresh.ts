/**
 * Live refresh of account info (models/config, ASI access, rate limits, experiments).
 *
 * Architecture — three pluggable tiers, tried in order:
 *
 *   1. got-scraping — pure JS HTTP client (Apify's got fork). Reorders TLS
 *      extensions + HTTP/2 SETTINGS + header ordering to look Chrome-ish.
 *      ~200ms round trip. Always available (shipped as a regular dep).
 *
 *   2. impit (optional) — Rust-backed JA3/JA4 impersonation via rustls-patched +
 *      reqwest. Closer to real Chrome than got-scraping. Only attempted if the
 *      user has installed it into ~/.perplexity-mcp/native-deps/ (Settings
 *      → Speed Boost). ~300-500ms.
 *
 *   3. browser — headless Patchright. Guaranteed to work because Chromium
 *      speaks the same TLS as whatever solved Turnstile at login time. ~3-5s.
 *
 * Each tier returns the same TierResult shape so the orchestrator can just
 * walk them in order. A CF challenge (HTML response instead of JSON) counts
 * as "try the next tier". Anything else (network error, 5xx, unparseable)
 * also cascades.
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BROWSER_DATA_DIR,
  COOKIES_FILE,
  CONFIG_DIR,
  PERPLEXITY_URL,
  MODELS_CONFIG_ENDPOINT,
  ASI_ACCESS_ENDPOINT,
  RATE_LIMIT_ENDPOINT,
  EXPERIMENTS_ENDPOINT,
  USER_INFO_ENDPOINT,
  findChromeExecutable,
  getSavedCookies,
  resolveBrowserExecutable,
  type AccountInfo,
  type ModelsConfigResponse,
  type ASIAccessResponse,
  type RateLimitResponse,
  type UserInfoResponse,
  type PlaywrightCookie,
} from "./config.js";

const MODELS_CACHE_FILE = join(BROWSER_DATA_DIR, "..", "models-cache.json");
const IMPIT_RUNTIME_DIR = join(CONFIG_DIR, "native-deps");

const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-site-isolation-trials",
  "--disable-web-security",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  "--disable-extensions",
  "--disable-popup-blocking",
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const CHROME_CLIENT_HINTS: Record<string, string> = {
  "sec-ch-ua": '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-ch-ua-platform-version": '"15.0.0"',
  "sec-ch-ua-arch": '"x86"',
  "sec-ch-ua-bitness": '"64"',
  "sec-ch-ua-full-version": '"138.0.7204.184"',
  "sec-ch-ua-full-version-list":
    '"Not)A;Brand";v="8.0.0.0", "Chromium";v="138.0.7204.184", "Google Chrome";v="138.0.7204.184"',
  "sec-ch-ua-model": '""',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "x-app-apiclient": "default",
  "x-app-apiversion": "2.18",
  "x-perplexity-request-try-number": "1",
  "x-perplexity-request-reason": "use-preferred-search-models",
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  referer: `${PERPLEXITY_URL}/`,
  origin: PERPLEXITY_URL,
};

export type RefreshTier = "got-scraping" | "impit" | "browser";

export interface RefreshResult {
  ok: boolean;
  source: "live" | "no-cookies" | "cf-challenge" | "failed";
  tier: RefreshTier | null;
  modelCount: number;
  accountTier: "Max" | "Pro" | "Enterprise" | "Free" | "Unknown";
  error?: string;
  cachePath: string;
  elapsedMs: number;
  tierAttempts?: Array<{ tier: RefreshTier; ok: boolean; elapsedMs: number; error?: string }>;
}

export interface RefreshOptions {
  log?: (line: string) => void;
  timeoutMs?: number;
  /** Force a particular tier for testing. Omit for normal cascade. */
  forceTier?: RefreshTier;
}

interface TierPayload {
  models: ModelsConfigResponse;
  asi: ASIAccessResponse | null;
  rateLimits: RateLimitResponse | null;
  experiments: Record<string, any> | null;
  userInfo: UserInfoResponse | null;
  /** Fresh cookies pulled off the successful tier (for cookies.json write-back). */
  freshCookies?: PlaywrightCookie[];
}

interface TierResult {
  ok: boolean;
  payload?: TierPayload;
  error?: string;
  challenged?: boolean;
  elapsedMs: number;
}

function noopLog(_: string) {}

function buildCookieHeader(cookies: PlaywrightCookie[]): string {
  return cookies
    .filter((c) => c.domain?.includes("perplexity.ai"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function detectCfChallenge(body: string): boolean {
  if (!body) return false;
  const head = body.slice(0, 2000).toLowerCase();
  return (
    head.includes("just a moment") ||
    head.includes("cf-mitigated") ||
    head.includes("enable javascript and cookies to continue") ||
    (head.includes("<html") && head.includes("cloudflare"))
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  Tier 1 — got-scraping                                          */
/* ═══════════════════════════════════════════════════════════════ */

async function tierGotScraping(cookies: PlaywrightCookie[], log: (l: string) => void, timeoutMs: number): Promise<TierResult> {
  const started = Date.now();
  let gotScraping: typeof import("got-scraping").gotScraping;
  try {
    ({ gotScraping } = await import("got-scraping"));
  } catch (err) {
    return { ok: false, error: `got-scraping missing: ${(err as Error).message}`, elapsedMs: Date.now() - started };
  }

  const cookieHeader = buildCookieHeader(cookies);
  const headers: Record<string, string> = {
    cookie: cookieHeader,
    "user-agent": USER_AGENT,
    ...CHROME_CLIENT_HINTS,
  };

  const fetchJson = async <T>(url: string, name: string): Promise<T | { __challenged: true } | null> => {
    try {
      const res = await gotScraping({
        url,
        headers,
        timeout: { request: timeoutMs },
        throwHttpErrors: false,
        responseType: "text",
        headerGeneratorOptions: {
          browsers: [{ name: "chrome", minVersion: 130 }],
          operatingSystems: ["windows"],
        },
      });

      const body = typeof res.body === "string" ? res.body : String(res.body ?? "");
      if (res.statusCode !== 200) {
        log(`got-scraping: ${name} status=${res.statusCode}`);
        if (detectCfChallenge(body)) return { __challenged: true };
        return null;
      }
      const ct = res.headers["content-type"] ?? "";
      if (!String(ct).includes("application/json")) {
        log(`got-scraping: ${name} non-JSON content-type=${ct}`);
        if (detectCfChallenge(body)) return { __challenged: true };
        return null;
      }
      return JSON.parse(body) as T;
    } catch (err) {
      log(`got-scraping: ${name} threw ${(err as Error).message}`);
      return null;
    }
  };

  const [models, asi, rateLimits, experiments, userInfo] = await Promise.all([
    fetchJson<ModelsConfigResponse>(MODELS_CONFIG_ENDPOINT, "models/config"),
    fetchJson<ASIAccessResponse>(ASI_ACCESS_ENDPOINT, "asi-access"),
    fetchJson<RateLimitResponse>(RATE_LIMIT_ENDPOINT, "rate-limit"),
    fetchJson<Record<string, any>>(EXPERIMENTS_ENDPOINT, "experiments"),
    fetchJson<UserInfoResponse>(USER_INFO_ENDPOINT, "user/info"),
  ]);

  // Any CF challenge on the critical endpoint → treat as tier failure (cascade).
  const challenged = !!(models && (models as any).__challenged);
  if (challenged) {
    return { ok: false, challenged: true, error: "CF challenge via got-scraping", elapsedMs: Date.now() - started };
  }
  if (!models) {
    return { ok: false, error: "got-scraping: models/config fetch failed", elapsedMs: Date.now() - started };
  }

  return {
    ok: true,
    payload: {
      models: models as ModelsConfigResponse,
      asi: asi && !(asi as any).__challenged ? (asi as ASIAccessResponse) : null,
      rateLimits: rateLimits && !(rateLimits as any).__challenged ? (rateLimits as RateLimitResponse) : null,
      experiments: experiments && !(experiments as any).__challenged ? (experiments as Record<string, any>) : null,
      userInfo: userInfo && !(userInfo as any).__challenged ? (userInfo as UserInfoResponse) : null,
    },
    elapsedMs: Date.now() - started,
  };
}

/* ═══════════════════════════════════════════════════════════════ */
/*  Tier 2 — impit (optional, user-installed)                      */
/* ═══════════════════════════════════════════════════════════════ */

/**
 * Minimal shape of the `impit` module that we actually call.
 * Full types aren't declared in our tsconfig because impit is NOT a build-time
 * dependency — it's installed at runtime by the user via "Install Speed Boost".
 */
interface ImpitModule {
  Impit: new (opts: { browser: string; ignoreTlsErrors?: boolean; proxyUrl?: string }) => {
    fetch(
      url: string,
      init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "follow" | "manual" | "error" }
    ): Promise<{
      status: number;
      headers: Headers | Record<string, string>;
      text(): Promise<string>;
      json(): Promise<unknown>;
    }>;
  };
}

/**
 * Dynamically import impit from the user's native-deps directory.
 * Returns null if impit isn't installed there.
 */
async function loadImpit(): Promise<ImpitModule | null> {
  const candidates = [
    join(IMPIT_RUNTIME_DIR, "node_modules", "impit", "index.js"),
    join(IMPIT_RUNTIME_DIR, "node_modules", "impit", "dist", "index.js"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      return req(p) as ImpitModule;
    } catch {
      // fall through to next candidate
    }
  }
  return null;
}

export function isImpitAvailable(): boolean {
  const marker = join(IMPIT_RUNTIME_DIR, "node_modules", "impit", "package.json");
  return existsSync(marker);
}

async function tierImpit(cookies: PlaywrightCookie[], log: (l: string) => void, timeoutMs: number): Promise<TierResult> {
  const started = Date.now();

  const impitMod = await loadImpit();
  if (!impitMod) {
    return { ok: false, error: "impit not installed (optional speed boost)", elapsedMs: Date.now() - started };
  }

  let client: InstanceType<ImpitModule["Impit"]>;
  try {
    client = new impitMod.Impit({ browser: "chrome", ignoreTlsErrors: false });
  } catch (err) {
    return { ok: false, error: `impit init failed: ${(err as Error).message}`, elapsedMs: Date.now() - started };
  }

  const cookieHeader = buildCookieHeader(cookies);
  const headers: Record<string, string> = {
    cookie: cookieHeader,
    "user-agent": USER_AGENT,
    ...CHROME_CLIENT_HINTS,
  };

  const fetchJson = async <T>(url: string, name: string): Promise<T | { __challenged: true } | null> => {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await client.fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(to);

      const body = await res.text();
      if (res.status !== 200) {
        log(`impit: ${name} status=${res.status}`);
        if (detectCfChallenge(body)) return { __challenged: true };
        return null;
      }
      const rhdrs: any = res.headers;
      const ct = typeof rhdrs?.get === "function" ? rhdrs.get("content-type") ?? "" : rhdrs?.["content-type"] ?? "";
      if (!String(ct).includes("application/json")) {
        log(`impit: ${name} non-JSON content-type=${ct}`);
        if (detectCfChallenge(body)) return { __challenged: true };
        return null;
      }
      return JSON.parse(body) as T;
    } catch (err) {
      log(`impit: ${name} threw ${(err as Error).message}`);
      return null;
    }
  };

  const [models, asi, rateLimits, experiments, userInfo] = await Promise.all([
    fetchJson<ModelsConfigResponse>(MODELS_CONFIG_ENDPOINT, "models/config"),
    fetchJson<ASIAccessResponse>(ASI_ACCESS_ENDPOINT, "asi-access"),
    fetchJson<RateLimitResponse>(RATE_LIMIT_ENDPOINT, "rate-limit"),
    fetchJson<Record<string, any>>(EXPERIMENTS_ENDPOINT, "experiments"),
    fetchJson<UserInfoResponse>(USER_INFO_ENDPOINT, "user/info"),
  ]);

  const challenged = !!(models && (models as any).__challenged);
  if (challenged) {
    return { ok: false, challenged: true, error: "CF challenge via impit", elapsedMs: Date.now() - started };
  }
  if (!models) {
    return { ok: false, error: "impit: models/config fetch failed", elapsedMs: Date.now() - started };
  }

  return {
    ok: true,
    payload: {
      models: models as ModelsConfigResponse,
      asi: asi && !(asi as any).__challenged ? (asi as ASIAccessResponse) : null,
      rateLimits: rateLimits && !(rateLimits as any).__challenged ? (rateLimits as RateLimitResponse) : null,
      experiments: experiments && !(experiments as any).__challenged ? (experiments as Record<string, any>) : null,
      userInfo: userInfo && !(userInfo as any).__challenged ? (userInfo as UserInfoResponse) : null,
    },
    elapsedMs: Date.now() - started,
  };
}

/* ═══════════════════════════════════════════════════════════════ */
/*  Tier 3 — headless Patchright browser (fallback, guaranteed)    */
/* ═══════════════════════════════════════════════════════════════ */

async function tierBrowser(cookies: PlaywrightCookie[], log: (l: string) => void, timeoutMs: number): Promise<TierResult> {
  const started = Date.now();

  try {
    await resolveBrowserExecutable();
  } catch (err) {
    return { ok: false, error: (err as Error).message, elapsedMs: Date.now() - started };
  }

  let chromium: typeof import("patchright").chromium;
  try {
    chromium = (await import("patchright")).chromium;
  } catch (err) {
    return { ok: false, error: `patchright missing: ${(err as Error).message}`, elapsedMs: Date.now() - started };
  }

  const chromePath = findChromeExecutable();
  log(`browser: launching headless chromium (${chromePath ? "system Chrome" : "bundled"})`);

  const browser = await chromium.launch({
    headless: true,
    args: STEALTH_ARGS,
    ...(chromePath ? { executablePath: chromePath } : {}),
    ignoreDefaultArgs: ["--enable-automation"],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENT,
    });
    await context.addCookies(cookies as any);

    const page = await context.newPage();
    const navResp = await page.goto(PERPLEXITY_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch((e) => {
      log(`browser: goto failed ${(e as Error).message}`);
      return null;
    });

    const status = navResp?.status() ?? 0;
    const title = await page.title().catch(() => "");
    log(`browser: navigation status=${status}, title="${title}"`);

    if (title.includes("Just a moment") || title.toLowerCase().includes("cloudflare")) {
      return { ok: false, challenged: true, error: "CF challenge via browser — cookies expired", elapsedMs: Date.now() - started };
    }

    const fetchJson = async <T>(url: string, name: string): Promise<T | null> => {
      try {
        const result: any = await page.evaluate(async (u: string) => {
          try {
            const r = await fetch(u, { credentials: "include" });
            const ct = r.headers.get("content-type") ?? "";
            if (!r.ok || !ct.includes("application/json")) {
              return { ok: false, status: r.status, contentType: ct };
            }
            return { ok: true, body: await r.json() };
          } catch (e: any) {
            return { ok: false, error: e?.message ?? String(e) };
          }
        }, url);

        if (!result?.ok) {
          log(`browser: ${name} non-OK status=${result?.status ?? "n/a"} ct=${result?.contentType ?? "n/a"} err=${result?.error ?? "n/a"}`);
          return null;
        }
        return result.body as T;
      } catch (err) {
        log(`browser: ${name} evaluate threw: ${(err as Error).message}`);
        return null;
      }
    };

    const [models, asi, rateLimits, experiments, userInfo] = await Promise.all([
      fetchJson<ModelsConfigResponse>(MODELS_CONFIG_ENDPOINT, "models/config"),
      fetchJson<ASIAccessResponse>(ASI_ACCESS_ENDPOINT, "asi-access"),
      fetchJson<RateLimitResponse>(RATE_LIMIT_ENDPOINT, "rate-limit"),
      fetchJson<Record<string, any>>(EXPERIMENTS_ENDPOINT, "experiments"),
      fetchJson<UserInfoResponse>(USER_INFO_ENDPOINT, "user/info"),
    ]);

    if (!models) {
      return { ok: false, error: "browser: models/config fetch failed inside page", elapsedMs: Date.now() - started };
    }

    log(
      `browser: fetched — models=${Object.keys(models.models || {}).length}, asi=${!!asi}, ` +
        `rateLimits=${!!rateLimits}, experiments=${experiments ? Object.keys(experiments).length + " keys" : "null"}, ` +
        `userInfo=${userInfo ? JSON.stringify(userInfo) : "null"}`
    );

    const freshCookies = await context
      .cookies(PERPLEXITY_URL)
      .then((arr) =>
        arr.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
        })) as PlaywrightCookie[]
      )
      .catch(() => undefined);

    return {
      ok: true,
      payload: { models, asi, rateLimits, experiments, userInfo, freshCookies },
      elapsedMs: Date.now() - started,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/* ═══════════════════════════════════════════════════════════════ */
/*  Orchestrator                                                   */
/* ═══════════════════════════════════════════════════════════════ */

export async function refreshAccountInfo(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const log = opts.log ?? noopLog;
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 25000;

  const savedCookies = getSavedCookies();
  if (savedCookies.length === 0) {
    return {
      ok: false,
      source: "no-cookies",
      tier: null,
      modelCount: 0,
      accountTier: "Unknown",
      error: "No saved cookies — run Perplexity: Login first.",
      cachePath: MODELS_CACHE_FILE,
      elapsedMs: Date.now() - started,
    };
  }

  const attempts: RefreshResult["tierAttempts"] = [];

  type TierFn = (c: PlaywrightCookie[], l: (l: string) => void, t: number) => Promise<TierResult>;
  const tierMap: Record<RefreshTier, TierFn> = {
    "got-scraping": tierGotScraping,
    impit: tierImpit,
    browser: tierBrowser,
  };

  const pipeline: Array<[RefreshTier, TierFn]> = opts.forceTier
    ? [[opts.forceTier, tierMap[opts.forceTier]]]
    : (() => {
        const chain: Array<[RefreshTier, TierFn]> = [["got-scraping", tierGotScraping]];
        if (isImpitAvailable()) chain.push(["impit", tierImpit]);
        chain.push(["browser", tierBrowser]);
        return chain;
      })();

  let successful: { tier: RefreshTier; result: TierResult } | null = null;
  let lastChallenged = false;

  for (const [name, fn] of pipeline) {
    log(`refresh: attempting tier=${name}`);
    const result = await fn(savedCookies, log, timeoutMs);
    attempts.push({ tier: name, ok: result.ok, elapsedMs: result.elapsedMs, error: result.error });
    if (result.ok) {
      successful = { tier: name, result };
      log(`refresh: tier=${name} succeeded in ${result.elapsedMs}ms`);
      break;
    }
    lastChallenged = lastChallenged || !!result.challenged;
    log(`refresh: tier=${name} failed in ${result.elapsedMs}ms (${result.error ?? "unknown"})`);
  }

  if (!successful) {
    return {
      ok: false,
      source: lastChallenged ? "cf-challenge" : "failed",
      tier: null,
      modelCount: 0,
      accountTier: "Unknown",
      error: lastChallenged
        ? "All tiers hit Cloudflare challenge. Run Perplexity: Login to re-solve Turnstile."
        : "All refresh tiers failed. See logs.",
      cachePath: MODELS_CACHE_FILE,
      elapsedMs: Date.now() - started,
      tierAttempts: attempts,
    };
  }

  const { tier, result } = successful;
  const payload = result.payload!;
  const existing = readExistingCache();

  // Prefer /rest/user/info flags (direct, stable) over /rest/experiments
  // which returns many unrelated server-side A/B flags and has been seen to
  // drop the subscription fields intermittently. Experiments is still used
  // for server_is_max (not mirrored in user/info).
  const isEnterpriseFromUser = payload.userInfo?.is_enterprise === true;
  const isEnterpriseFromExp = payload.experiments?.server_is_enterprise === true;
  const isProFromExp = payload.experiments?.server_is_pro === true;
  const isMaxFromExp = payload.experiments?.server_is_max === true;
  const canUseComputer = payload.asi?.can_use_computer ?? existing?.canUseComputer ?? false;

  const info: AccountInfo = {
    // If Computer mode is accessible but no experiments flag fires, infer Pro —
    // Computer is gated to paid tiers, so the account is at least Pro.
    isPro: isProFromExp || (canUseComputer && !isMaxFromExp && !isEnterpriseFromUser && !isEnterpriseFromExp),
    isMax: isMaxFromExp,
    isEnterprise: isEnterpriseFromUser || isEnterpriseFromExp,
    canUseComputer,
    modelsConfig: payload.models,
    rateLimits: payload.rateLimits ?? existing?.rateLimits ?? null,
  };

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(MODELS_CACHE_FILE, JSON.stringify(info, null, 2));
  log(`refresh: wrote ${MODELS_CACHE_FILE} (${Object.keys(payload.models.models || {}).length} models)`);

  // Write back fresh cookies if the tier produced them (only the browser tier does).
  if (payload.freshCookies && payload.freshCookies.length > 0) {
    try {
      mkdirSync(dirname(COOKIES_FILE), { recursive: true });
      writeFileSync(
        COOKIES_FILE,
        JSON.stringify({ allCookies: payload.freshCookies, savedAt: new Date().toISOString() }, null, 2)
      );
      log(`refresh: persisted ${payload.freshCookies.length} fresh cookies to ${COOKIES_FILE}`);
    } catch (err) {
      log(`refresh: could not persist fresh cookies (non-fatal): ${(err as Error).message}`);
    }
  }

  return {
    ok: true,
    source: "live",
    tier,
    modelCount: Object.keys(payload.models.models || {}).length,
    accountTier: deriveTier(info),
    cachePath: MODELS_CACHE_FILE,
    elapsedMs: Date.now() - started,
    tierAttempts: attempts,
  };
}

function deriveTier(info: AccountInfo): RefreshResult["accountTier"] {
  if (info.isMax) return "Max";
  if (info.isEnterprise) return "Enterprise";
  if (info.isPro) return "Pro";
  return "Free";
}

function readExistingCache(): AccountInfo | null {
  if (!existsSync(MODELS_CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(MODELS_CACHE_FILE, "utf8")) as AccountInfo;
  } catch {
    return null;
  }
}

export function getModelsCacheInfo(): { path: string; exists: boolean; mtime: Date | null; ageHours: number | null } {
  const exists = existsSync(MODELS_CACHE_FILE);
  const mtime = exists ? statSync(MODELS_CACHE_FILE).mtime : null;
  const ageHours = mtime ? (Date.now() - mtime.getTime()) / 3_600_000 : null;
  return { path: MODELS_CACHE_FILE, exists, mtime, ageHours };
}

export function getImpitRuntimeDir(): string {
  return IMPIT_RUNTIME_DIR;
}
