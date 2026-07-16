import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquire, getLockfilePath, read } from "../../src/daemon/lockfile.ts";
import {
  ensureDaemon,
  getDaemonStatus,
  lockCodeVersion,
  startDaemon,
} from "../../src/daemon/launcher.ts";

// Code-graph version gate.
//
// A daemon pins its hashed ESM chunk filenames at startup. An upgrade
// overwrites those files, so the OLD process answers /daemon/health perfectly
// while every dynamic import for a code-split chunk (doctor's hashed chunk,
// …) fails forever. "Responds" is not "usable".
//
// The extension already reaped this on its own activation path
// (reapStaleVersionedDaemon), but plain `attach` — i.e. every external stdio
// client: Cursor, Claude Desktop, Cline, Codex CLI — went through ensureDaemon
// and happily attached to it. This gate closes that.
//
// Hard constraint: attach-to-self during daemon start must keep working.
// startDaemon runs the server IN-PROCESS for the CLI `daemon start` flow and
// in tests, so the lock's pid is our own and its code graph IS the code
// executing. Gating that could only ever mean the caller's expectation is
// stale, and self-termination is never the answer.

function createMockClient() {
  return {
    authenticated: true,
    userId: "version-gate-test",
    accountInfo: {
      isMax: false,
      isPro: true,
      isEnterprise: false,
      canUseComputer: false,
      modelsConfig: null,
      rateLimits: null,
    },
    init: async () => undefined,
    reinit: async () => undefined,
    shutdown: async () => undefined,
  };
}

function readPackageVersion() {
  return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
}

describe("lockCodeVersion", () => {
  it("prefers mcpVersion — the authoritative chunk-graph version", () => {
    expect(lockCodeVersion({ version: "0.8.55", mcpVersion: "0.8.54" })).toBe("0.8.54");
  });

  it("falls back to legacy version when mcpVersion is absent", () => {
    // Locks written by older daemons only stamped `version`.
    expect(lockCodeVersion({ version: "0.8.40" })).toBe("0.8.40");
    expect(lockCodeVersion({ version: "0.8.40", mcpVersion: undefined })).toBe("0.8.40");
    expect(lockCodeVersion({ version: "0.8.40", mcpVersion: "" })).toBe("0.8.40");
  });

  it("returns null when neither field carries a version", () => {
    expect(lockCodeVersion(null)).toBeNull();
    expect(lockCodeVersion(undefined)).toBeNull();
    expect(lockCodeVersion({})).toBeNull();
  });
});

describe("getDaemonStatus — expectedMcpVersion gate", () => {
  const runtimes = [];

  afterEach(async () => {
    while (runtimes.length > 0) {
      const runtime = runtimes.pop();
      await runtime?.close?.().catch(() => undefined);
      if (runtime?.configDir) {
        rmSync(runtime.configDir, { recursive: true, force: true });
      }
    }
  });

  async function startRuntime() {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-vgate-"));
    const runtime = await startDaemon({ configDir, createClient: createMockClient });
    runtimes.push({ ...runtime, configDir });
    return { configDir, runtime };
  }

  it("no expectedMcpVersion → healthy, and never reports versionMismatch (back-compat)", async () => {
    const { configDir } = await startRuntime();
    const status = await getDaemonStatus({ configDir, reclaimStale: false });
    expect(status.healthy).toBe(true);
    expect(status.running).toBe(true);
    expect(status.versionMismatch).toBeUndefined();
  });

  it("matching expectedMcpVersion → still healthy", async () => {
    const { configDir } = await startRuntime();
    const status = await getDaemonStatus({
      configDir,
      reclaimStale: false,
      expectedMcpVersion: readPackageVersion(),
    });
    expect(status.healthy).toBe(true);
    expect(status.versionMismatch).toBeUndefined();
  });

  it("ATTACH-TO-SELF: a mismatch on our OWN pid is ignored — never self-gated", async () => {
    // startDaemon ran the server in-process, so the lock carries process.pid.
    // Even with a deliberately wrong expectation, this must stay healthy: the
    // daemon IS the code currently executing.
    const { configDir } = await startRuntime();
    const lockPath = getLockfilePath(configDir);
    expect(read({ lockPath }).pid).toBe(process.pid);

    const status = await getDaemonStatus({
      configDir,
      reclaimStale: true,
      expectedMcpVersion: "0.0.0-not-our-version",
    });

    expect(status.healthy).toBe(true);
    expect(status.running).toBe(true);
    expect(status.versionMismatch).toBeUndefined();
    // And the lock survives — we must never reclaim ourselves.
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("getDaemonStatus / ensureDaemon — HEALTHY foreign daemon on the wrong code graph", () => {
  const tempDirs = [];
  const zombies = [];

  afterEach(() => {
    for (const pid of zombies.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already reaped by the reclaim — the expected case
      }
    }
    while (tempDirs.length) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  /**
   * Stand up a REAL foreign process that answers /daemon/health, and hand it
   * the lock with the given version fields.
   *
   * The daemon must genuinely be healthy: that is the entire point. A lock
   * with port 0 (or a dead pid) never reaches the version gate at all — it is
   * caught earlier as wedged/stale — so a fixture like that would pass whether
   * or not the gate exists.
   */
  async function startForeignDaemon(configDir, versionFields) {
    const uuid = "foreign-daemon";
    const bearerToken = "foreign-token";
    const fixture = new URL("./fixtures/fake-daemon.mjs", import.meta.url);
    const child = spawn(process.execPath, [fileURLToPath(fixture), uuid, bearerToken], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    zombies.push(child.pid);

    const port = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("fake daemon never reported a port")), 10_000);
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
        reject(new Error(`fake daemon exited early (${code})`));
      });
    });

    expect(
      acquire(
        {
          pid: child.pid,
          uuid,
          port,
          bearerToken,
          startedAt: new Date().toISOString(),
          ...versionFields,
        },
        { lockPath: getLockfilePath(configDir) },
      ),
    ).toBe(true);

    return { pid: child.pid, port, uuid };
  }

  it("is genuinely healthy WITHOUT the gate — proving the gate is what flips it", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-vgate-control-"));
    tempDirs.push(configDir);
    await startForeignDaemon(configDir, { version: "0.8.55", mcpVersion: "0.0.1-old" });

    // Control: no expectedMcpVersion → this daemon attaches happily today.
    // This is exactly the pre-fix behavior that let every external stdio
    // client bind to a stale-version daemon after an upgrade.
    const status = await getDaemonStatus({ configDir, reclaimStale: false });
    expect(status.healthy).toBe(true);
    expect(status.running).toBe(true);
    expect(status.versionMismatch).toBeUndefined();
  }, 20_000);

  it("mismatched mcpVersion → not healthy, flagged, NOT stale, and the lock is preserved", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-vgate-mismatch-"));
    tempDirs.push(configDir);
    await startForeignDaemon(configDir, { version: "0.8.55", mcpVersion: "0.0.1-old" });
    const lockPath = getLockfilePath(configDir);

    const status = await getDaemonStatus({
      configDir,
      reclaimStale: true,
      expectedMcpVersion: readPackageVersion(),
    });

    expect(status.healthy).toBe(false);
    expect(status.versionMismatch).toBe(true);
    // Alive, so NOT stale — and therefore the lock must survive. Releasing a
    // live daemon's lock without stopping it would put two daemons on one
    // profile (and one Chromium each).
    expect(status.stale).toBe(false);
    expect(status.running).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(read({ lockPath }).uuid).toBe("foreign-daemon");
  }, 20_000);

  it("mcpVersion wins over the legacy version field", async () => {
    // The extension deliberately stamps its OWN package version into
    // `version` (PERPLEXITY_LOCK_COMPAT_VERSION) so pre-0.8.57 reapers leave a
    // healthy daemon alone. So a `version` that happens to match must NOT
    // rescue a daemon whose mcpVersion is wrong.
    const configDir = mkdtempSync(join(tmpdir(), "pplx-vgate-precedence-"));
    tempDirs.push(configDir);
    const current = readPackageVersion();
    await startForeignDaemon(configDir, { version: current, mcpVersion: "0.0.1-old" });

    const status = await getDaemonStatus({
      configDir,
      reclaimStale: false,
      expectedMcpVersion: current,
    });
    expect(status.versionMismatch).toBe(true);
    expect(status.healthy).toBe(false);
  }, 20_000);

  it("legacy lock without mcpVersion is gated on the `version` fallback", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-vgate-legacy-"));
    tempDirs.push(configDir);
    await startForeignDaemon(configDir, { version: "0.7.0" });

    const status = await getDaemonStatus({
      configDir,
      reclaimStale: false,
      expectedMcpVersion: readPackageVersion(),
    });
    expect(status.versionMismatch).toBe(true);
    expect(status.healthy).toBe(false);
  }, 20_000);

  it("ensureDaemon stops the mismatched daemon and starts a matching one", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-vgate-reclaim-"));
    tempDirs.push(configDir);
    const foreign = await startForeignDaemon(configDir, {
      version: "0.8.55",
      mcpVersion: "0.0.1-old",
    });

    const started = [];
    const spawnDaemon = async () => {
      const runtime = await startDaemon({ configDir, createClient: createMockClient });
      if (!runtime.attached) started.push(runtime);
    };

    const info = await ensureDaemon({
      configDir,
      spawnDaemon,
      pollIntervalMs: 50,
      startTimeoutMs: 8_000,
      expectedMcpVersion: readPackageVersion(),
    });

    try {
      expect(info.uuid).not.toBe(foreign.uuid);
      expect(info.port).toBeGreaterThan(0);
      expect(info.port).not.toBe(foreign.port);
      // Stopped, not merely un-locked.
      await new Promise((r) => setTimeout(r, 300));
      expect(() => process.kill(foreign.pid, 0)).toThrow();
    } finally {
      for (const r of started) await r.close?.().catch(() => undefined);
    }
  }, 30_000);

  it("a MATCHING foreign daemon is attached to, never killed", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-vgate-match-"));
    tempDirs.push(configDir);
    const foreign = await startForeignDaemon(configDir, { mcpVersion: readPackageVersion(), version: "0.8.55" });

    const info = await ensureDaemon({
      configDir,
      spawnDaemon: async () => {
        throw new Error("must not spawn — the running daemon matches our code graph");
      },
      pollIntervalMs: 50,
      startTimeoutMs: 4_000,
      expectedMcpVersion: readPackageVersion(),
    });

    expect(info.uuid).toBe(foreign.uuid);
    expect(info.port).toBe(foreign.port);
    expect(() => process.kill(foreign.pid, 0)).not.toThrow();
  }, 20_000);
});
