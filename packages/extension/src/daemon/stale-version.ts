import { unlinkSync } from "node:fs";

/**
 * 0.8.10 — guard against the extension activating against a daemon that was
 * launched by an older bundled version. The 0.8.5-launched Node process pins
 * its ESM module graph at startup with hashed chunk filenames; later upgrades
 * overwrite those files on disk, and dynamic imports for code-split chunks
 * (e.g. perplexity_doctor's `doctor-XXXXX.mjs`) fail forever.
 *
 * Rule: any version difference is "stale". We do NOT compare semver — a lock
 * from a future version is also wrong (the running daemon's chunk filenames
 * won't match what's on disk after a downgrade either).
 *
 * Lock missing / corrupt / pid-dead is intentionally NOT this helper's
 * concern — the existing ensureDaemon flow handles those cases.
 */
export function isLockStale(
  lock: { version?: string | null } | null | undefined,
  bundledVersion: string,
): boolean {
  if (!lock) return false;
  // Older daemons predating the version field — treat as mismatch.
  if (typeof lock.version !== "string" || lock.version.length === 0) return true;
  return lock.version !== bundledVersion;
}

/** Best-effort unlink. Swallows ENOENT; rethrows nothing. */
export function removeStaleLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone or unwritable; the spawn path will surface a clearer error
  }
}

/**
 * Send SIGTERM to the stale daemon's pid. Wrapped to swallow ESRCH (already
 * dead) and downgrade EPERM (different owner / pid recycled into a system
 * process) to a logged warning so activation never throws here. Any failure
 * to bind the new daemon's port is a separate problem the existing
 * ensure-loop already surfaces.
 */
export function killStaleDaemonPid(
  pid: number,
  log: (line: string) => void,
): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ESRCH") return; // already gone
    if (code === "EPERM") {
      log(`[daemon] kill(${pid}) returned EPERM — pid not owned by us, continuing`);
      return;
    }
    log(`[daemon] kill(${pid}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
