// Best-effort filesystem + browser-launch helpers shared across the MCP server.

import { unlinkSync } from "node:fs";
import { join } from "node:path";

// Chromium process-singleton / profile-lock files that block a fresh
// `launchPersistentContext` when left behind by an unclean prior exit.
// `SingletonLock`/`SingletonCookie`/`SingletonSocket` are the POSIX
// (Linux/macOS) mechanism; `lockfile` is the WINDOWS ProcessSingleton lock —
// it was never listed here, which is why the issue #8 Windows `exitCode 21`
// deadlock could not self-recover. `Default/LOCK` is a LevelDB lock (not the
// process singleton) and is deliberately left alone.
const SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"];

/**
 * Remove stale Chromium singleton / profile-lock files from a persistent
 * user-data-dir. Chromium refuses to start (POSIX: silent exit 0; Windows:
 * exit 21) when these files claim an active instance, so a stale lock from an
 * unclean previous exit breaks `launchPersistentContext`. The files are
 * recreated on every launch and only carry exclusivity (not state), so
 * deleting them pre-launch is safe. On Windows a file still held open by a
 * LIVE process cannot be unlinked (EPERM/EACCES) — that throw is swallowed
 * below, and the caller's retry handles the brief post-close release lag.
 */
export function clearStaleSingletonLocks(dir) {
  for (const name of SINGLETON_FILES) {
    try {
      unlinkSync(join(dir, name));
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        // Best-effort: log and continue.
        console.error(`[perplexity-mcp] Could not remove ${name} in ${dir}:`, err.message);
      }
    }
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Signatures patchright/Chromium emit when a `launchPersistentContext`
// collides with another instance holding the same --user-data-dir (the
// profile singleton lock). On Windows the child Chrome exits immediately
// (exitCode 21) and Playwright surfaces it as "Target page, context or
// browser has been closed"; other phrasings name the process singleton or
// report the profile already in use.
const LOCK_CONTENTION_RE =
  /target page, context or browser has been closed|processsingleton|profile.*(in use|already)|singletonlock|already running|exit(ed)?(?:\s+(?:with\s+)?code)?\s*21\b/i;

/**
 * True when `err` looks like a transient Chromium profile-lock collision that
 * is worth retrying after clearing stale locks (issue #8).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isLockContentionError(err) {
  if (!err) return false;
  const msg = typeof err === "string" ? err : (err.message ?? String(err));
  return LOCK_CONTENTION_RE.test(msg);
}

/**
 * Run `launch` with bounded retry + exponential backoff, retrying ONLY
 * transient lock-contention failures. On Windows, closing a persistent
 * context does not release the profile lock synchronously, so relaunching on
 * the same --user-data-dir can momentarily collide; retrying after clearing
 * stale locks recovers without a full restart (issue #8). Non-lock errors
 * (missing executable, network) are rethrown immediately — no pointless waits.
 *
 * @template T
 * @param {(attempt: number) => Promise<T> | T} launch
 * @param {{
 *   retries?: number,
 *   baseDelayMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   isRetriable?: (err: unknown) => boolean,
 *   beforeAttempt?: (attempt: number) => void,
 * }} [opts]
 * @returns {Promise<T>}
 */
export async function launchWithRetry(launch, opts = {}) {
  const {
    retries = 3,
    baseDelayMs = 200,
    sleep = defaultSleep,
    isRetriable = isLockContentionError,
    beforeAttempt,
  } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (beforeAttempt) {
      try { beforeAttempt(attempt); } catch { /* best-effort lock clearing */ }
    }
    try {
      return await launch(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetriable(err)) throw err;
      console.error(
        `[perplexity-mcp] Browser launch hit a profile-lock collision (attempt ${attempt + 1}/${retries + 1}); retrying after backoff.`,
      );
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr; // unreachable — loop either returns or throws
}
