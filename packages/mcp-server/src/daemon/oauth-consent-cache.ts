/**
 * OAuth consent cache — remembers per-(clientId, redirectUri) consents so
 * the user isn't prompted every time Claude Desktop / Cursor / Cline
 * refreshes an access token (which happens on a ~1h cycle).
 *
 * Storage: <configDir>/oauth-consent.json, 0600.
 * Entries carry an absolute `expiresAt` (ms since epoch). On each check
 * we lazily prune expired entries. Deleting a record is synchronous and
 * best-effort (if the file is locked we lose the mutation; next write
 * will overwrite it).
 *
 * Revoking a consent entry does NOT invalidate already-issued access
 * tokens — those live 1h anyway; revoking the CLIENT (see
 * oauth-provider.revokeClient) is the way to invalidate outstanding
 * tokens. Phase 8.2's dashboard panel composes these two.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { getConfigDir } from "../profiles.js";

export interface ConsentEntry {
  clientId: string;
  redirectUri: string;
  approvedAt: string;
  expiresAt: number;
}

export interface ConsentCacheOptions {
  cachePath?: string;
  now?: () => number;
}

export function getConsentCachePath(configDir = getConfigDir()): string {
  return join(configDir, "oauth-consent.json");
}

function resolvePath(options: ConsentCacheOptions): string {
  return options.cachePath ?? getConsentCachePath();
}

function resolveNow(options: ConsentCacheOptions): number {
  return (options.now ?? Date.now)();
}

function load(cachePath: string): ConsentEntry[] {
  if (!existsSync(cachePath)) return [];
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is ConsentEntry =>
      e &&
      typeof e === "object" &&
      typeof e.clientId === "string" &&
      typeof e.redirectUri === "string" &&
      typeof e.approvedAt === "string" &&
      typeof e.expiresAt === "number"
    );
  } catch {
    return [];
  }
}

function persist(cachePath: string, entries: ConsentEntry[]): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(entries, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  rmSync(cachePath, { force: true });
  renameSync(tempPath, cachePath);
  applyPrivatePermissions(cachePath);
}

/**
 * Record an approval for (clientId, redirectUri). Overwrites any prior
 * entry for the same pair. Returns the stored entry.
 */
export function record(
  clientId: string,
  redirectUri: string,
  ttlMs: number,
  options: ConsentCacheOptions = {},
): ConsentEntry {
  const cachePath = resolvePath(options);
  const now = resolveNow(options);
  const entry: ConsentEntry = {
    clientId,
    redirectUri,
    approvedAt: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
  };
  const all = load(cachePath)
    .filter((e) => !(e.clientId === clientId && e.redirectUri === redirectUri))
    .filter((e) => e.expiresAt > now);
  all.push(entry);
  persist(cachePath, all);
  return entry;
}

/**
 * Returns true iff a non-expired consent exists for (clientId, redirectUri).
 * Expired entries are pruned from disk as a side effect.
 */
export function check(
  clientId: string,
  redirectUri: string,
  options: ConsentCacheOptions = {},
): boolean {
  const cachePath = resolvePath(options);
  const now = resolveNow(options);
  const all = load(cachePath);
  const live = all.filter((e) => e.expiresAt > now);
  if (live.length !== all.length) {
    persist(cachePath, live);
  }
  return live.some((e) => e.clientId === clientId && e.redirectUri === redirectUri);
}

/**
 * Returns all non-expired consents. Expired entries are pruned on read.
 */
export function list(options: ConsentCacheOptions = {}): ConsentEntry[] {
  const cachePath = resolvePath(options);
  const now = resolveNow(options);
  const all = load(cachePath);
  const live = all.filter((e) => e.expiresAt > now);
  if (live.length !== all.length) {
    persist(cachePath, live);
  }
  return live.slice().sort((a, b) => b.expiresAt - a.expiresAt);
}

/**
 * Revoke consent entries. If `redirectUri` is omitted, every entry for
 * the given `clientId` is removed (a client may register multiple
 * redirects). If `clientId` is omitted, everything is cleared. Returns
 * the number of entries removed.
 */
export function revoke(
  options: ConsentCacheOptions & { clientId?: string; redirectUri?: string } = {},
): number {
  const cachePath = resolvePath(options);
  const now = resolveNow(options);
  const all = load(cachePath).filter((e) => e.expiresAt > now);
  const kept = all.filter((e) => {
    if (!options.clientId) return false; // revoke-all
    if (e.clientId !== options.clientId) return true;
    if (options.redirectUri !== undefined && e.redirectUri !== options.redirectUri) return true;
    return false;
  });
  const removed = all.length - kept.length;
  if (removed > 0) {
    persist(cachePath, kept);
  }
  return removed;
}

function applyPrivatePermissions(cachePath: string): void {
  if (process.platform === "win32") {
    restrictWindowsAcl(cachePath);
    return;
  }
  chmodSync(cachePath, 0o600);
}

function restrictWindowsAcl(cachePath: string): void {
  const username = getWindowsUserName();
  const grantTarget = `${username}:(R,W)`;
  const result = spawnSync("icacls", [cachePath, "/inheritance:r", "/grant:r", grantTarget], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    // Best effort — don't fail the daemon over ACL tightening. The file is
    // still written with Node's default umask and sits inside configDir.
    return;
  }
}

function getWindowsUserName(): string {
  const username = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  if (domain && username) return `${domain}\\${username}`;
  if (username) return username;
  return "";
}
