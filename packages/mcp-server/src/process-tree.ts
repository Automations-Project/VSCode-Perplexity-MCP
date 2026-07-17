import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const execFile = promisify(execFileCb);

/**
 * Process-tree termination and browser-profile squatter eviction.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two field failures (issues #15 + the "loops of tabs" report) share one root:
 * a Chromium that outlives the daemon that launched it keeps holding the
 * profile's ProcessSingleton. Every later `launchPersistentContext` on that
 * `browser-data` is FORWARDED to the orphan ("Opening in existing browser
 * session"), the new chrome.exe exits 0, Playwright reports "Target page,
 * context or browser has been closed" — and each retry opens another tab in
 * the orphan. The daemon then loops reinit forever (138 cycles observed).
 *
 * Orphans are born two ways:
 *  - On Windows, `process.kill(pid, "SIGTERM")` is TerminateProcess: the
 *    daemon's signal handler never runs, so its Chrome child survives every
 *    reclaim (wedge / version-gate / stale-fence) and every force-stop.
 *  - A crashed/force-closed editor takes the daemon down without cleanup.
 */

/**
 * Terminate a process AND its children.
 *
 * Windows: `taskkill /T /F` — the only reliable way to take the child Chrome
 * down with the daemon (mirrors the tunnel providers, which learned this
 * first). POSIX: SIGTERM first so the daemon's finalize() can close its
 * browser gracefully, then SIGKILL the stragglers.
 */
export async function terminateProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;

  if (process.platform === "win32") {
    await execFile("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000,
    }).catch(() => undefined);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  await delay(1_000);
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // ESRCH — exited after SIGTERM
  }
}

/**
 * Find pids whose command line carries `--user-data-dir=<userDataDir>` — i.e.
 * browser processes bound to OUR profile. The marker is the full flag+path,
 * not the bare directory string, to keep false positives out.
 */
export async function findProfileBrowserPids(userDataDir: string): Promise<number[]> {
  const marker = `--user-data-dir=${userDataDir}`;

  if (process.platform === "win32") {
    // wmic is removed on current Windows 11; CIM via PowerShell is the stable
    // query surface. The marker travels via ENV, never inline: a literal in
    // the -Command string would sit in PowerShell's own command line and the
    // query would match (and try to evict) its own shell.
    const script =
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:PPLX_EVICT_MARKER) } | ForEach-Object { $_.ProcessId }";
    try {
      const { stdout } = await execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          windowsHide: true,
          timeout: 15_000,
          env: { ...process.env, PPLX_EVICT_MARKER: marker },
        },
      );
      return parsePids(stdout);
    } catch {
      return [];
    }
  }

  try {
    const { stdout } = await execFile("pgrep", ["-f", "--", marker], { timeout: 10_000 });
    return parsePids(stdout);
  } catch {
    // pgrep exits 1 on "no match" — that is the common, healthy case.
    return [];
  }
}

function parsePids(stdout: string): number[] {
  return String(stdout)
    .split(/\s+/)
    .map((tok) => Number.parseInt(tok, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export interface EvictResult {
  evicted: number[];
  refusedReason: "foreign-daemon-owns-profile" | null;
}

/**
 * Kill browser processes squatting `userDataDir` — with an ownership guard.
 *
 * The guard is the whole safety story: `browser-data` is daemon-single-owner
 * (issue #8), so eviction is legitimate ONLY when the caller is that owner or
 * nobody is. If a LIVE daemon other than us holds `<configDir>/daemon.lock`,
 * the squatting Chrome is probably ITS browser and we are the trespasser
 * (an in-process stdio fallback, a doctor misuse) — killing it would sabotage
 * every attached client. Refuse instead.
 *
 * Runs only from launch-retry paths (i.e. after a real singleton collision),
 * never on the happy path — a healthy launch spawns no PowerShell/pgrep.
 */
export async function evictProfileSquatters(
  userDataDir: string,
  configDir: string,
): Promise<EvictResult> {
  const lockPath = join(configDir, "daemon.lock");
  if (existsSync(lockPath)) {
    try {
      const { readFileSync } = await import("node:fs");
      const record = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      if (
        Number.isInteger(record.pid) &&
        record.pid! > 0 &&
        record.pid !== process.pid &&
        isProcessAlive(record.pid!)
      ) {
        return { evicted: [], refusedReason: "foreign-daemon-owns-profile" };
      }
    } catch {
      // Unreadable lock — nobody provably owns the profile; eviction may proceed.
    }
  }

  const pids = await findProfileBrowserPids(userDataDir);
  if (pids.length === 0) return { evicted: [], refusedReason: null };

  console.error(
    `[perplexity-mcp] evicting orphaned browser process(es) ${pids.join(", ")} squatting ${userDataDir} ` +
      `(no live daemon owns this profile; they forward our launches to themselves and spam tabs).`,
  );
  for (const pid of pids) {
    await terminateProcessTree(pid);
  }
  // Give the OS a beat to release the profile ProcessSingleton before the
  // caller's next launch attempt.
  await delay(300);
  return { evicted: pids, refusedReason: null };
}
