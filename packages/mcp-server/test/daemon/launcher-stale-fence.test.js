import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquire, getLockfilePath } from "../../src/daemon/lockfile.ts";
import { getDaemonStatus } from "../../src/daemon/launcher.ts";

// Issue #15: stale-reclaim used to release the lockfile but never terminate
// the losing process. "Stale" usually means the pid is dead — but isStale()
// also condemns a LIVE holder whose health responder echoes a different uuid
// than the lock. Dropping the lock while that process lived on left an orphan
// daemon holding Chromium + the browser-data profile singleton; the next
// ensure spawned a fresh daemon straight into a profile-lock fight with it
// (the reporter counted FIVE daemons, one of them four days old).
//
// The fence: a live, foreign, stale holder is SIGTERM/SIGKILLed before the
// lock is released.

describe("getDaemonStatus — stale reclaim fences a live holder (issue #15)", () => {
  const tempDirs = [];
  const zombies = [];

  afterEach(() => {
    for (const pid of zombies.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already reaped by the fence — the expected case
      }
    }
    while (tempDirs.length) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  /**
   * A REAL live process answering /daemon/health — but with a uuid that does
   * NOT match the lock record. That is the live-holder-judged-stale shape:
   * probeHealthy is false (uuid mismatch) and isStale() condemns the record
   * via echoedUuid, while the recorded pid is very much alive.
   */
  async function startMismatchedResponder(configDir) {
    const bearerToken = "fence-token";
    const fixture = new URL("./fixtures/fake-daemon.mjs", import.meta.url);
    const child = spawn(
      process.execPath,
      [fileURLToPath(fixture), "responder-uuid", bearerToken],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    zombies.push(child.pid);

    const port = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("responder never reported a port")), 10_000);
      child.stdout.on("data", (d) => {
        buf += String(d);
        const line = buf.split("\n").find((l) => l.trim().startsWith("{"));
        if (line) {
          clearTimeout(timer);
          resolve(JSON.parse(line).port);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`responder exited early (${code})`));
      });
    });

    expect(
      acquire(
        {
          pid: child.pid,
          uuid: "lock-uuid-that-nobody-answers-for",
          port,
          bearerToken,
          version: "0.8.55",
          startedAt: new Date().toISOString(),
        },
        { lockPath: getLockfilePath(configDir) },
      ),
    ).toBe(true);

    return { pid: child.pid, port };
  }

  it("kills the live stale holder before releasing the lock", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-fence-"));
    tempDirs.push(configDir);
    const holder = await startMismatchedResponder(configDir);
    const lockPath = getLockfilePath(configDir);

    const status = await getDaemonStatus({ configDir, reclaimStale: true });

    expect(status.stale).toBe(true);
    expect(status.running).toBe(false);
    // The lock is gone AND the orphan is gone. Releasing without killing left
    // it alive holding the browser profile — the #15 pile-up seed.
    expect(existsSync(lockPath)).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(holder.pid, 0)).toThrow();
  }, 20_000);

  it("without reclaimStale it only reports — never kills", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-fence-observe-"));
    tempDirs.push(configDir);
    const holder = await startMismatchedResponder(configDir);
    const lockPath = getLockfilePath(configDir);

    const status = await getDaemonStatus({ configDir, reclaimStale: false });

    expect(status.stale).toBe(true);
    // Observation mode must stay side-effect free.
    expect(existsSync(lockPath)).toBe(true);
    expect(() => process.kill(holder.pid, 0)).not.toThrow();
  }, 20_000);

  it("a dead-pid stale lock is released without any signalling", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-fence-dead-"));
    tempDirs.push(configDir);
    const lockPath = getLockfilePath(configDir);
    expect(
      acquire(
        {
          pid: 0x7fffffff, // above every platform's pid ceiling — provably dead
          uuid: "dead-holder",
          port: 43999,
          bearerToken: "t",
          version: "0.8.55",
          startedAt: new Date().toISOString(),
        },
        { lockPath },
      ),
    ).toBe(true);

    const status = await getDaemonStatus({ configDir, reclaimStale: true });
    expect(status.stale).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  }, 20_000);
});
