// Best-effort filesystem helpers shared across the MCP server.

import { unlinkSync } from "node:fs";
import { join } from "node:path";

const SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

/**
 * Remove stale Chromium SingletonLock/Cookie/Socket files from a persistent
 * user-data-dir. Chromium silently exits with code 0 when these files claim
 * an active instance, so a stale lock from an unclean previous exit will
 * break `launchPersistentContext`. The files are recreated on every launch
 * and only carry exclusivity (not state), so deleting them pre-launch is safe.
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
