import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AccountSnapshot, ModelsConfigSource, RefreshTier } from "@perplexity/shared";
import { MODELS_FALLBACK, MODELS_FALLBACK_CAPTURED_AT } from "@perplexity/shared";
import type { AccountInfo } from "../browser/runtime.js";
import { BROWSER_DATA_DIR, CONFIG_DIR, COOKIES_FILE, PerplexityClient } from "../browser/runtime.js";
import { getImpitStatus } from "../native-deps.js";

const MODELS_CACHE_FILE = join(BROWSER_DATA_DIR, "..", "models-cache.json");
let lastRefreshTier: RefreshTier | null = null;

export function setLastRefreshTier(tier: RefreshTier | null): void {
  lastRefreshTier = tier;
}

export function getLastRefreshTier(): RefreshTier | null {
  return lastRefreshTier;
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function deriveTier(accountInfo: AccountInfo | null, loggedIn: boolean): AccountSnapshot["tier"] {
  if (!loggedIn) {
    return "Anonymous";
  }

  if (!accountInfo) {
    return "Authenticated";
  }

  if (accountInfo.isMax) {
    return "Max";
  }

  if (accountInfo.isPro) {
    return "Pro";
  }

  if (accountInfo.isEnterprise) {
    return "Enterprise";
  }

  return "Authenticated";
}

export function getModelsCachePath(): string {
  return MODELS_CACHE_FILE;
}

export function hasStoredLogin(): boolean {
  return existsSync(COOKIES_FILE) || existsSync(BROWSER_DATA_DIR);
}

export function getAccountSnapshot(): AccountSnapshot {
  const accountInfo = readJsonFile<AccountInfo>(MODELS_CACHE_FILE);
  const storedCookies = existsSync(COOKIES_FILE);
  const loggedIn = storedCookies || !!accountInfo;

  const cacheMtime = existsSync(MODELS_CACHE_FILE)
    ? statSync(MODELS_CACHE_FILE).mtime
    : null;

  let modelsConfig = accountInfo?.modelsConfig ?? null;
  let modelsConfigSource: ModelsConfigSource;
  let lastUpdated: string | null;

  if (modelsConfig) {
    modelsConfigSource = cacheMtime && Date.now() - cacheMtime.getTime() < 60_000 ? "live" : "cache";
    lastUpdated = cacheMtime ? cacheMtime.toISOString() : null;
  } else {
    modelsConfig = MODELS_FALLBACK;
    modelsConfigSource = "fallback";
    lastUpdated = MODELS_FALLBACK_CAPTURED_AT;
  }

  const speedBoost = getImpitStatus();

  return {
    loggedIn,
    userId: null,
    tier: deriveTier(accountInfo, loggedIn),
    canUseComputer: accountInfo?.canUseComputer ?? false,
    modelsConfig,
    modelsConfigSource,
    rateLimits: accountInfo?.rateLimits ?? null,
    configDir: CONFIG_DIR,
    browserProfileDir: BROWSER_DATA_DIR,
    lastUpdated,
    lastRefreshTier,
    speedBoost: {
      installed: speedBoost.installed,
      version: speedBoost.version,
      installedAt: speedBoost.installedAt,
      runtimeDir: speedBoost.runtimeDir,
    },
  };
}

export async function runInteractiveLogin(options: {
  chromePath?: string;
  log?: (line: string) => void;
}): Promise<AccountSnapshot> {
  const previousChromePath = process.env.PERPLEXITY_CHROME_PATH;
  const previousHeadlessOnly = process.env.PERPLEXITY_HEADLESS_ONLY;

  if (options.chromePath) {
    process.env.PERPLEXITY_CHROME_PATH = options.chromePath;
  } else {
    delete process.env.PERPLEXITY_CHROME_PATH;
  }

  delete process.env.PERPLEXITY_HEADLESS_ONLY;

  const client = new PerplexityClient();
  try {
    const result = await client.loginViaBrowser({ log: options.log });
    if (!result.success) {
      throw new Error(result.message);
    }

    return getAccountSnapshot();
  } finally {
    await client.shutdown().catch(() => undefined);

    if (previousChromePath) {
      process.env.PERPLEXITY_CHROME_PATH = previousChromePath;
    } else {
      delete process.env.PERPLEXITY_CHROME_PATH;
    }

    if (previousHeadlessOnly) {
      process.env.PERPLEXITY_HEADLESS_ONLY = previousHeadlessOnly;
    } else {
      delete process.env.PERPLEXITY_HEADLESS_ONLY;
    }
  }
}
