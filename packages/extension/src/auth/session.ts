import { existsSync, readFileSync, statSync } from "node:fs";
import type { AccountSnapshot, DaemonAuthStatus, ModelsConfigSource, RefreshTier } from "@perplexity-user-mcp/shared";
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

/** True when `pid` is a live process. EPERM = alive, just owned by someone else. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * daemon-status.json, but only when the daemon that wrote it is still alive.
 *
 * The daemon's shutdown() sets authenticated:false and writes the file on its
 * way out, and a crashed/killed daemon just leaves its last write behind. Both
 * strand a `{authenticated:false, reason:"not-logged-in"}` file on disk, which
 * the dashboard renders forever as "Daemon sees an anonymous session — run
 * login to connect." — telling users to run a login that cannot possibly clear
 * it (issue #10 follow-ups).
 *
 * ponytail: pid reuse could theoretically resurrect a stale status. It is
 * cosmetic and self-corrects on the next daemon write — cross-check daemon.lock
 * only if it ever shows up in practice.
 *
 * @internal Exported only so unit tests can assert the liveness branches; not
 * part of the supported API.
 */
export function readLiveDaemonStatus(filePath: string): DaemonAuthStatus | null {
  const status = readJsonFile<DaemonAuthStatus>(filePath);
  if (!status) return null;
  // Pre-pid daemons: nothing to verify, so trust the file as before.
  if (typeof status.pid !== "number") return status;
  return isProcessAlive(status.pid) ? status : null;
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

  // Read live daemon auth state — null when the file is absent (stdio mode /
  // first run) OR when the daemon that wrote it is no longer running.
  const daemonAuth = readLiveDaemonStatus(paths.daemonStatus);

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
    daemonAuth,
  };
}

