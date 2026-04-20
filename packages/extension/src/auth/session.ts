import { existsSync, readFileSync, statSync } from "node:fs";
import type { AccountSnapshot, ModelsConfigSource, RefreshTier } from "@perplexity-user-mcp/shared";
import { MODELS_FALLBACK, MODELS_FALLBACK_CAPTURED_AT } from "@perplexity-user-mcp/shared";
import { getConfigDir, getProfilePaths, getActiveName } from "perplexity-user-mcp/profiles";
import type { AccountInfo } from "../browser/runtime.js";
import { getImpitStatus } from "../native-deps.js";

let lastRefreshTier: RefreshTier | null = null;

function getActiveProfileSnapshotPaths() {
  const name = getActiveName() ?? "default";
  return getProfilePaths(name);
}

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
  return getActiveProfileSnapshotPaths().modelsCache;
}

export function hasStoredLogin(): boolean {
  const name = getActiveName() ?? "default";
  const { vault, vaultPlain } = getProfilePaths(name);
  return existsSync(vault) || existsSync(vaultPlain);
}

export function getAccountSnapshot(): AccountSnapshot {
  const paths = getActiveProfileSnapshotPaths();
  const modelsCacheFile = paths.modelsCache;
  const accountInfo = readJsonFile<AccountInfo>(modelsCacheFile);
  const loggedIn = hasStoredLogin() || !!accountInfo;

  const cacheMtime = existsSync(modelsCacheFile)
    ? statSync(modelsCacheFile).mtime
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
    configDir: getConfigDir(),
    browserProfileDir: paths.browserData,
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

