import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PerplexityClient } from "../client.js";
import { getActiveName, getConfigDir } from "../profiles.js";
import { getPackageVersion } from "../package-version.js";
import { watchActiveProfile, watchReinit } from "../reinit-watcher.js";
import type { StartedDaemonServer } from "./server.js";
import { startDaemonServer } from "./server.js";
import { getTunnelBinaryPath } from "./install-tunnel.js";
import { acquire, getLockfilePath, isStale, read, release, replace, type DaemonLockRecord } from "./lockfile.js";
import { ensureToken, getTokenPath, readToken } from "./token.js";
import type { StartedTunnel, TunnelState } from "./tunnel.js";
import { getTunnelProvider, readTunnelSettings } from "./tunnel-providers/index.js";

/**
 * Consumer-side mirror of the daemon's `getHealth()` payload (server.ts).
 *
 * NOTE: this is a hand-maintained duplicate applied with an unchecked `as`
 * cast, so TypeScript will NOT catch a field that server.ts stops sending —
 * it will just silently arrive as undefined. Keep it in sync by hand.
 */
export interface DaemonHealthStatus {
  ok: boolean;
  pid: number;
  uuid: string | null;
  version: string;
  port: number;
  uptimeMs: number;
  startedAt: string;
  heartbeatCount?: number;
  /** Busy/queue snapshot of the shared page, for join-time hydration. */
  busy?: {
    busy: boolean;
    active: { tool: string; clientId?: string | null; startedAt: string } | null;
    queued: number;
    updatedAt: string;
  };
  tunnel?: {
    status?: string;
    url?: string | null;
    pid?: number | null;
    error?: string | null;
  };
}

/**
 * The code-graph version a lock claims.
 *
 * Prefers `mcpVersion` (authoritative — it names the on-disk hashed ESM chunk
 * graph the daemon pinned at startup). Falls back to the legacy `version`
 * field for locks written by older daemons that only stamped one. Note
 * `version` may deliberately carry the *extension* version when the extension
 * spawned the daemon (PERPLEXITY_LOCK_COMPAT_VERSION), which is exactly why
 * `mcpVersion` wins when present.
 *
 * Mirrors the extension-side rule in daemon/stale-version.ts — keep the two in
 * agreement.
 */
export function lockCodeVersion(
  record: { version?: string | null; mcpVersion?: string | null } | null | undefined,
): string | null {
  if (!record) return null;
  if (typeof record.mcpVersion === "string" && record.mcpVersion.length > 0) return record.mcpVersion;
  if (typeof record.version === "string" && record.version.length > 0) return record.version;
  return null;
}

export interface DaemonStatus {
  running: boolean;
  healthy: boolean;
  stale: boolean;
  /**
   * A LIVE daemon answers health but runs a different code graph than the
   * caller's `expectedMcpVersion`. It is NOT stale (its pid is alive, so the
   * lock must not simply be released — that would leave two daemons racing the
   * same profile) and it will never become healthy, so `ensureDaemon` stops it
   * and starts a matching one. Absent unless `expectedMcpVersion` was supplied.
   */
  versionMismatch?: boolean;
  configDir: string;
  lockPath: string;
  tokenPath: string;
  record: DaemonLockRecord | null;
  health: DaemonHealthStatus | null;
}

export interface EnsureDaemonOptions {
  configDir?: string;
  host?: string;
  port?: number;
  tunnel?: boolean;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
  spawnDaemon?: (options: { configDir: string; host?: string; port?: number; tunnel?: boolean }) => void | Promise<void>;
  // Forwarded to getDaemonStatus. Only the VS Code extension host opts in:
  // a lockfile whose pid equals our process.pid indicates a zombie daemon
  // left behind by a prior activation (the daemon is supposed to run in a
  // detached child, never in the extension host itself).
  treatSelfAsZombie?: boolean;
  /**
   * MCP code-graph version this caller requires. When set, a live daemon from
   * a different build is stopped and replaced instead of attached to — see
   * `getDaemonStatus`'s `expectedMcpVersion`. Omit to attach to any healthy
   * daemon (the pre-existing behavior).
   */
  expectedMcpVersion?: string;
}

export interface StartDaemonOptions {
  configDir?: string;
  host?: string;
  port?: number;
  tunnel?: boolean;
  signal?: AbortSignal;
  retries?: number;
  retryDelayMs?: number;
  healthTimeoutMs?: number;
  version?: string;
  createClient?: () => PerplexityClient;
}

export interface DaemonConnectionInfo {
  pid: number;
  uuid: string;
  port: number;
  url: string;
  bearerToken: string;
  version: string;
  startedAt: string;
  tunnelUrl?: string | null;
}

export interface StartedDaemonInstance extends DaemonConnectionInfo {
  attached: boolean;
  close: () => Promise<void>;
  closed: Promise<void>;
}

export async function getDaemonStatus(options: {
  configDir?: string;
  reclaimStale?: boolean;
  healthTimeoutMs?: number;
  // When true, a lockfile whose pid matches our process.pid is treated as a
  // zombie (the daemon was accidentally bound inside the caller's process).
  // The extension host sets this so a stale in-process daemon left behind by
  // a previous extension activation gets reclaimed. Off by default so that
  // startDaemon's own bookkeeping (which legitimately runs in-process during
  // tests and the CLI `daemon start` flow) isn't nuked.
  treatSelfAsZombie?: boolean;
  /**
   * MCP code-graph version the caller requires (i.e. `getPackageVersion()` /
   * the bundled `dist/mcp/package.json` version). When set, a live daemon
   * whose lock claims a different code graph is reported `healthy: false` +
   * `versionMismatch: true`.
   *
   * Why it matters: a daemon pins its hashed ESM chunk filenames at startup.
   * After an upgrade overwrites those files, the old process's dynamic imports
   * for code-split chunks fail forever — it answers /daemon/health perfectly
   * while being unable to actually serve tools. The extension already reaped
   * this on its own activation path; supplying this makes plain `attach`
   * (every external stdio client) reclaim it too.
   *
   * Never applied to a lock held by our OWN pid — see the guard below.
   */
  expectedMcpVersion?: string;
} = {}): Promise<DaemonStatus> {
  const configDir = options.configDir ?? getConfigDir();
  const lockPath = getLockfilePath(configDir);
  const tokenPath = getTokenPath(configDir);
  const record = read({ lockPath });

  if (!record) {
    return {
      running: false,
      healthy: false,
      stale: false,
      configDir,
      lockPath,
      tokenPath,
      record: null,
      health: null,
    };
  }

  if (options.treatSelfAsZombie && record.pid === process.pid) {
    if (options.reclaimStale) {
      release({ lockPath, expectedUuid: record.uuid });
    }
    return {
      running: false,
      healthy: false,
      stale: true,
      configDir,
      lockPath,
      tokenPath,
      record,
      health: null,
    };
  }

  // Probe with the lockfile's bearer first. If it returns 401 (bearer drift
  // between lockfile and token file) fall back to the token file's bearer —
  // the token file is the authoritative source the daemon actually uses for
  // auth.
  let health = await probeHealth(record, { timeoutMs: options.healthTimeoutMs });
  if (!health) {
    try {
      const tokenRecord = readToken({ tokenPath });
      if (tokenRecord && tokenRecord.bearerToken !== record.bearerToken) {
        health = await probeHealth(
          { ...record, bearerToken: tokenRecord.bearerToken },
          { timeoutMs: options.healthTimeoutMs },
        );
        if (health && options.reclaimStale) {
          // Heal the lockfile so future probes use the correct bearer directly.
          try {
            replace(
              { ...record, bearerToken: tokenRecord.bearerToken },
              { lockPath, expectedUuid: record.uuid },
            );
          } catch {
            // best-effort: next publishTunnelState will sync
          }
        }
      }
    } catch {
      // readToken may throw if file is malformed; treat as unhealthy
    }
  }
  const probeHealthy = Boolean(health?.ok && health.uuid === record.uuid);

  // Code-graph gate. A daemon from a different build answers health fine but
  // cannot import the hashed chunks now on disk, so "responds" != "usable".
  //
  // NEVER gate a lock held by our own pid. That is the attach-to-self case:
  // startDaemon runs the server in-process for the CLI `daemon start` flow and
  // in tests, so the lock's pid IS us and its code graph IS the code currently
  // executing. A mismatch there could only mean the CALLER's expectation is
  // stale — self-termination is never the answer, and gating it would break
  // startDaemon's attach.
  const gateVersion =
    options.expectedMcpVersion !== undefined && record.pid !== process.pid;
  const versionMismatch =
    gateVersion && probeHealthy && lockCodeVersion(record) !== options.expectedMcpVersion;

  const healthy = probeHealthy && !versionMismatch;
  // Deliberately keyed off `probeHealthy`, not `healthy`: a version-mismatched
  // daemon is alive and answering, so isStale() would say "not stale" anyway —
  // but being explicit keeps the two concepts from drifting. Stale means "the
  // holder is gone"; mismatched means "the holder is wrong".
  const stale = !probeHealthy && isStale(record, { echoedUuid: health?.uuid ?? null });

  if (stale && options.reclaimStale) {
    release({ lockPath, expectedUuid: record.uuid });
    return {
      running: false,
      healthy: false,
      stale: true,
      configDir,
      lockPath,
      tokenPath,
      record,
      health,
    };
  }

  return {
    running: !stale,
    healthy,
    stale,
    ...(versionMismatch ? { versionMismatch: true } : {}),
    configDir,
    lockPath,
    tokenPath,
    record,
    health,
  };
}

/**
 * Stop the process holding the lock and free it, so the caller can start a
 * replacement. Used for the two "alive but unusable" cases: a wedged daemon
 * (never answers health) and a version-mismatched one (answers, wrong code
 * graph). Refuses to signal our own pid.
 */
async function reclaimDaemonProcess(
  record: DaemonLockRecord,
  configDir: string,
  reason: string,
): Promise<void> {
  console.error(`[perplexity-mcp] reclaiming daemon pid ${record.pid} in ${configDir}: ${reason}`);
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    // already gone or not ours — the release below still frees the lock
  }
  await delay(1_000);
  try {
    process.kill(record.pid, 0);
    process.kill(record.pid, "SIGKILL");
  } catch {
    // ESRCH — exited after SIGTERM
  }
  try {
    release({ lockPath: getLockfilePath(configDir), expectedUuid: record.uuid });
  } catch {
    // best-effort; the next getDaemonStatus will retry the reclaim
  }
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<DaemonConnectionInfo> {
  const configDir = options.configDir ?? getConfigDir();

  // Two passes (issue #14): pass 0 is the normal ensure loop; if it times out
  // WEDGED — a live pid holding the lock whose port never once answered
  // health — pass 1 reclaims and retries. isStale() is pid-liveness only, so
  // without this a daemon that hung between lock-acquire and port-sync (lock
  // pinned at port 0), or whose socket died under a live process, reads as
  // running:true forever: the spawn gate never opens and every ensure times
  // out with no way to recover short of manually deleting daemon.lock.
  for (let pass = 0; pass < 2; pass++) {
    const deadline = Date.now() + (options.startTimeoutMs ?? 15_000);
    let launched = false;
    let reclaimedMismatch = false;
    let lastStatus: DaemonStatus | null = null;

    while (Date.now() < deadline) {
      const status = await getDaemonStatus({
        configDir,
        reclaimStale: true,
        healthTimeoutMs: options.healthTimeoutMs,
        treatSelfAsZombie: options.treatSelfAsZombie,
        ...(options.expectedMcpVersion !== undefined
          ? { expectedMcpVersion: options.expectedMcpVersion }
          : {}),
      });
      lastStatus = status;
      if (status.running && status.healthy && status.record && status.health) {
        return toConnectionInfo(status.record, status.health);
      }

      // A live daemon on the wrong code graph will never become healthy, so
      // don't burn the whole timeout waiting: stop it now and let the next
      // poll spawn a matching one. It is NOT stale, so getDaemonStatus
      // deliberately left its lock alone — releasing it without stopping the
      // process would leave two daemons racing one profile.
      // getDaemonStatus never flags a mismatch for our own pid, so this can't
      // signal ourselves; the explicit check keeps that guarantee local.
      if (
        status.versionMismatch &&
        status.record &&
        status.record.pid !== process.pid &&
        !reclaimedMismatch
      ) {
        reclaimedMismatch = true;
        await reclaimDaemonProcess(
          status.record,
          configDir,
          `lock claims code graph ${lockCodeVersion(status.record) ?? "unknown"}, need ${options.expectedMcpVersion}`,
        );
        continue;
      }

      if (!status.running && !launched) {
        await (options.spawnDaemon ?? spawnDetachedDaemon)({
          configDir,
          host: options.host,
          port: options.port,
          tunnel: options.tunnel,
        });
        launched = true;
      }

      await delay(options.pollIntervalMs ?? 200);
    }

    const record = lastStatus?.record ?? null;
    const wedged = Boolean(lastStatus?.running && !lastStatus.healthy && record);
    // Never SIGTERM ourselves: a lock carrying our own pid is the
    // treatSelfAsZombie case, which getDaemonStatus already reclaims when the
    // caller opted in; if it didn't opt in, killing is not ours to do.
    if (pass === 0 && wedged && record && record.pid !== process.pid) {
      await reclaimDaemonProcess(
        record,
        configDir,
        `never answered health (lock port ${record.port}) — retrying once`,
      );
      continue;
    }
    break;
  }

  throw new Error(`Timed out waiting for daemon startup in ${configDir}.`);
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<StartedDaemonInstance> {
  const configDir = options.configDir ?? getConfigDir();
  const lockPath = getLockfilePath(configDir);
  const tokenPath = getTokenPath(configDir);
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 200;
  // Code-graph version (hashed ESM chunks). Always the MCP package version.
  const mcpVersion = getPackageVersion();
  // `version` stays on the lock for legacy extension reapers that compared
  // lock.version to extension.packageJSON.version. When the extension spawns
  // us it sets PERPLEXITY_LOCK_COMPAT_VERSION to its own package version so
  // those reapers leave a healthy daemon alone. Fall back to mcpVersion for
  // CLI / npx starts.
  const compatVersion =
    (typeof process.env.PERPLEXITY_LOCK_COMPAT_VERSION === "string" &&
    process.env.PERPLEXITY_LOCK_COMPAT_VERSION.trim().length > 0
      ? process.env.PERPLEXITY_LOCK_COMPAT_VERSION.trim()
      : null) ??
    options.version ??
    mcpVersion;
  const version = compatVersion;

  for (let attempt = 0; attempt < retries; attempt++) {
    const status = await getDaemonStatus({
      configDir,
      reclaimStale: true,
      healthTimeoutMs: options.healthTimeoutMs,
    });

    if (status.running && status.healthy && status.record && status.health) {
      return {
        attached: true,
        ...toConnectionInfo(status.record, status.health),
        close: async () => undefined,
        closed: Promise.resolve(),
      };
    }

    if (status.running) {
      await delay(retryDelayMs);
      continue;
    }

    const uuid = randomUUID();
    const startedAt = new Date().toISOString();
    const token = ensureToken({ tokenPath });
    const provisional: DaemonLockRecord = {
      pid: process.pid,
      uuid,
      port: typeof options.port === "number" ? options.port : 0,
      bearerToken: token.bearerToken,
      version,
      mcpVersion,
      startedAt,
      cloudflaredPid: null,
      tunnelUrl: null,
    };

    if (!acquire(provisional, { lockPath })) {
      await delay(retryDelayMs);
      continue;
    }

    let watcher: ReturnType<typeof watchReinit> | undefined;
    let activeWatcher: ReturnType<typeof watchActiveProfile> | undefined;
    let server: StartedDaemonServer | undefined;
    let finalizePromise: Promise<void> | null = null;
    let finalizeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      finalizeResolve = resolve;
    });

    // Track the currently-watched profile so the active-pointer watcher can
    // rebind the per-profile reinit watcher when the user switches accounts.
    // Without this rebind the daemon keeps watching the old profile's
    // `.reinit` and silently misses logins on the new profile.
    let currentWatchedProfile = process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
    const profile = currentWatchedProfile;
    const client = options.createClient ? options.createClient() : new PerplexityClient();
    let tunnelState: TunnelState = {
      status: "disabled",
      url: null,
      pid: null,
      error: null,
    };
    let tunnelController: StartedTunnel | null = null;
    let tunnelStartPromise: Promise<void> | null = null;

    const buildRecord = (bearerToken = server?.bearerToken ?? token.bearerToken): DaemonLockRecord => ({
      pid: process.pid,
      uuid,
      port: server?.port ?? provisional.port,
      bearerToken,
      version,
      mcpVersion,
      startedAt,
      cloudflaredPid: tunnelState.pid ?? null,
      tunnelUrl: tunnelState.url ?? null,
    });

    const syncLockfile = (bearerToken = server?.bearerToken ?? token.bearerToken) => {
      replace(buildRecord(bearerToken), { lockPath, expectedUuid: uuid });
    };

    const publishTunnelState = () => {
      if (!server) {
        return;
      }
      syncLockfile(server.bearerToken);
      server.publishEvent("daemon:tunnel-url", {
        status: tunnelState.status,
        url: tunnelState.url,
        pid: tunnelState.pid,
        error: tunnelState.error ?? null,
      });
    };

    const enableTunnelRuntime = async () => {
      if (!server) {
        throw new Error("Daemon server is not ready yet.");
      }
      if (tunnelState.status === "enabled") {
        return;
      }
      if (tunnelStartPromise) {
        await tunnelStartPromise;
        return;
      }

      const settings = readTunnelSettings(configDir);
      const provider = getTunnelProvider(settings.activeProvider);
      const setup = await provider.isSetupComplete(configDir);
      if (!setup.ready) {
        throw new Error(setup.reason ?? `${provider.displayName} setup incomplete.`);
      }

      tunnelController = await provider.start({
        port: server.port,
        configDir,
        onStateChange: (nextState) => {
          tunnelState = nextState;
          if (nextState.status === "crashed" || nextState.status === "disabled") {
            tunnelController = null;
          }
          publishTunnelState();
        },
      });

      tunnelStartPromise = tunnelController.waitUntilReady
        .then(() => undefined)
        .finally(() => {
          tunnelStartPromise = null;
        });

      await tunnelStartPromise;
    };

    const disableTunnelRuntime = async () => {
      const controller = tunnelController;
      tunnelController = null;
      if (!controller) {
        if (tunnelState.status !== "disabled") {
          tunnelState = {
            status: "disabled",
            url: null,
            pid: null,
            error: null,
          };
          publishTunnelState();
        }
        return;
      }

      await controller.stop();
      tunnelState = {
        status: "disabled",
        url: null,
        pid: null,
        error: null,
      };
      publishTunnelState();
    };

    const finalize = async () => {
      if (!finalizePromise) {
        finalizePromise = (async () => {
          await disableTunnelRuntime().catch(() => undefined);
          watcher?.dispose();
          activeWatcher?.dispose();
          if (options.signal && abortHandler) {
            options.signal.removeEventListener("abort", abortHandler);
          }
          process.off("SIGINT", signalHandler);
          process.off("SIGTERM", signalHandler);
          release({ lockPath, expectedUuid: uuid });
          finalizeResolve?.();
        })();
      }
      await finalizePromise;
    };

    const signalHandler = () => {
      void close();
    };
    const abortHandler = () => {
      void close();
    };

    const close = async () => {
      if (server) {
        await server.close().catch(() => undefined);
      }
      await finalize();
    };

    try {
      watcher = watchReinit(currentWatchedProfile, async () => {
        try {
          await client.reinit();
        } catch (err) {
          // A failed reinit (CF block, profile lock, no browser) must never take
          // down a healthy listening server — the next .reinit write retries.
          // Log so it surfaces in daemon.log instead of vanishing.
          console.error(`[perplexity-mcp] reinit watcher: ${(err as Error).message}`);
        }
      });

      // Profile-switch handler: when the user picks a different account from
      // the dashboard `setActive()` rewrites `<configDir>/active` atomically.
      // We catch that, rebind the per-profile `.reinit` watcher so subsequent
      // login events on the newly-active profile propagate, then call
      // `client.reinit()` so cookies for the new profile are picked up
      // immediately rather than lingering on whatever browser context was
      // loaded for the old profile.
      activeWatcher = watchActiveProfile(configDir, async () => {
        try {
          const nextProfile = process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
          if (nextProfile !== currentWatchedProfile) {
            currentWatchedProfile = nextProfile;
            watcher?.dispose();
            watcher = watchReinit(nextProfile, async () => {
              try {
                await client.reinit();
              } catch (err) {
                console.error(`[perplexity-mcp] reinit watcher: ${(err as Error).message}`);
              }
            });
          }
          await client.reinit();
        } catch (err) {
          // Don't let a single rebind failure crash the daemon — the next
          // active-pointer write will retry. Log so it surfaces in daemon.log.
          console.error(`[perplexity-mcp] active-profile watcher: ${(err as Error).message}`);
        }
      });

      server = await startDaemonServer({
        host: options.host,
        port: options.port,
        uuid,
        version,
        configDir,
        bearerToken: token.bearerToken,
        createClient: () => client,
        onShutdown: finalize,
        getTunnelState: () => tunnelState,
        onEnableTunnel: enableTunnelRuntime,
        onDisableTunnel: disableTunnelRuntime,
        onTunnelAutoDisable: async (info) => {
          // Security middleware detected a 401 burst on the tunnel. Snip the
          // tunnel immediately; the dashboard banner surfaces this via the
          // daemon:tunnel-auto-disabled SSE event (published from server.ts).
          await disableTunnelRuntime().catch(() => undefined);
          tunnelState = {
            status: "crashed",
            url: null,
            pid: null,
            error: `Auto-disabled: ${info.failures} auth failures within ${Math.round(info.windowMs / 1000)}s.`,
          };
          publishTunnelState();
        },
        onTokenRotated: async (nextToken) => {
          syncLockfile(nextToken.bearerToken);
        },
      });

      syncLockfile(server.bearerToken);

      process.on("SIGINT", signalHandler);
      process.on("SIGTERM", signalHandler);
      options.signal?.addEventListener("abort", abortHandler);

      if (options.tunnel) {
        await enableTunnelRuntime();
      }

      return {
        attached: false,
        pid: process.pid,
        uuid,
        port: server.port,
        url: server.url,
        bearerToken: server.bearerToken,
        version,
        startedAt,
        tunnelUrl: tunnelState.url,
        close,
        closed,
      };
    } catch (error) {
      // Bug-3: even if startDaemonServer threw before `server` was assigned
      // (e.g. EADDRINUSE inside httpServer.listen), we MUST release the
      // lockfile we acquired above. Otherwise subsequent launches fail with
      // a stale lockfile that no live daemon owns.
      watcher?.dispose();
      await server?.close?.().catch(() => undefined);
      release({ lockPath, expectedUuid: uuid });

      if (isAddressInUseError(error)) {
        // Pinned port: the user (or extension) explicitly asked for this
        // port. Don't silently rotate — surface a clear error the caller
        // can render to the user. Lock is already released above.
        if (typeof options.port === "number" && options.port > 0) {
          throw new Error(
            `Port ${options.port} is in use; daemon cannot start. Another perplexity daemon instance or unrelated process holds it.`,
          );
        }
        // Any-free-port mode: let the retry loop pick another OS-assigned
        // port. Brief backoff so we don't thrash if something is racing us.
        await delay(retryDelayMs);
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Unable to start or attach to daemon after ${retries} attempts.`);
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EADDRINUSE";
}

export async function stopDaemon(options: {
  configDir?: string;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
  /**
   * When graceful /daemon/shutdown fails OR the wait-timeout elapses, signal
   * the lockfile pid directly (SIGTERM then SIGKILL) and release the lockfile.
   * Required for the "Kill daemon" UX when the daemon is unresponsive.
   */
  force?: boolean;
} = {}): Promise<{ stopped: boolean; forced: boolean; pid?: number | null }> {
  const configDir = options.configDir ?? getConfigDir();
  const status = await getDaemonStatus({
    configDir,
    reclaimStale: true,
    healthTimeoutMs: options.healthTimeoutMs,
  });

  if (!status.running || !status.record) {
    // Nothing live. If force=true and there's a stale lockfile, release it.
    if (options.force && status.record) {
      try {
        release({ lockPath: getLockfilePath(configDir), expectedUuid: status.record.uuid });
      } catch {
        // best-effort
      }
    }
    return { stopped: false, forced: false, pid: status.record?.pid ?? null };
  }

  const recordForShutdown = status.record;

  if (status.healthy) {
    try {
      await adminRequest(recordForShutdown, "/daemon/shutdown", { method: "POST" });
    } catch (err) {
      if (!options.force) throw err;
    }
  }
  const deadline = Date.now() + (options.waitTimeoutMs ?? 10_000);

  while (Date.now() < deadline) {
    const nextStatus = await getDaemonStatus({
      configDir,
      reclaimStale: true,
      healthTimeoutMs: options.healthTimeoutMs,
    });
    if (!nextStatus.running) {
      return { stopped: true, forced: false, pid: recordForShutdown.pid };
    }
    await delay(options.pollIntervalMs ?? 200);
  }

  if (!options.force) {
    throw new Error("Timed out waiting for daemon shutdown.");
  }

  // Force path: try signalling the pid directly. SIGTERM first, then SIGKILL.
  const pid = recordForShutdown.pid;
  let signalled = false;
  try {
    process.kill(pid, "SIGTERM");
    signalled = true;
    await delay(1000);
    try {
      process.kill(pid, 0);
      // still alive
      process.kill(pid, "SIGKILL");
      await delay(500);
    } catch {
      // ESRCH — process already gone
    }
  } catch {
    // process may already be dead or not ours (pid recycled)
  }
  try {
    release({ lockPath: getLockfilePath(configDir), expectedUuid: recordForShutdown.uuid });
  } catch {
    // best-effort
  }
  return { stopped: signalled, forced: true, pid };
}

export async function restartDaemon(options: {
  configDir?: string;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
  spawnDaemon?: EnsureDaemonOptions["spawnDaemon"];
  startTimeoutMs?: number;
  treatSelfAsZombie?: boolean;
} = {}): Promise<{ stopped: boolean; reSpawned: boolean; connection: DaemonConnectionInfo | null }> {
  let stopped = false;
  try {
    const result = await stopDaemon({
      configDir: options.configDir,
      waitTimeoutMs: options.waitTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      healthTimeoutMs: options.healthTimeoutMs,
    });
    stopped = result.stopped;
  } catch {
    // Ignore — may already be down. We'll attempt to bring a fresh one up.
  }

  const connection = await ensureDaemon({
    configDir: options.configDir,
    healthTimeoutMs: options.healthTimeoutMs,
    startTimeoutMs: options.startTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    spawnDaemon: options.spawnDaemon,
    treatSelfAsZombie: options.treatSelfAsZombie,
  });

  return { stopped, reSpawned: true, connection };
}

export async function rotateDaemonToken(options: {
  configDir?: string;
  healthTimeoutMs?: number;
} = {}): Promise<DaemonConnectionInfo> {
  const configDir = options.configDir ?? getConfigDir();
  const status = await getDaemonStatus({
    configDir,
    reclaimStale: true,
    healthTimeoutMs: options.healthTimeoutMs,
  });

  if (!status.running || !status.healthy || !status.record) {
    throw new Error("Daemon is not running.");
  }

  await adminRequest(status.record, "/daemon/rotate-token", { method: "POST" });
  await delay(100);
  const updated = await getDaemonStatus({
    configDir,
    reclaimStale: false,
    healthTimeoutMs: options.healthTimeoutMs,
  });

  if (!updated.running || !updated.healthy || !updated.record || !updated.health) {
    throw new Error("Daemon token rotation completed, but the daemon is not healthy.");
  }

  return toConnectionInfo(updated.record, updated.health);
}

export async function enableDaemonTunnel(options: {
  configDir?: string;
  healthTimeoutMs?: number;
} = {}): Promise<DaemonStatus> {
  const configDir = options.configDir ?? getConfigDir();
  const status = await getDaemonStatus({
    configDir,
    reclaimStale: true,
    healthTimeoutMs: options.healthTimeoutMs,
  });

  if (!status.running || !status.healthy || !status.record) {
    throw new Error("Daemon is not running.");
  }

  await adminRequest(status.record, "/daemon/enable-tunnel", { method: "POST" });
  await delay(100);
  return await getDaemonStatus({
    configDir,
    reclaimStale: false,
    healthTimeoutMs: options.healthTimeoutMs,
  });
}

export async function disableDaemonTunnel(options: {
  configDir?: string;
  healthTimeoutMs?: number;
} = {}): Promise<DaemonStatus> {
  const configDir = options.configDir ?? getConfigDir();
  const status = await getDaemonStatus({
    configDir,
    reclaimStale: true,
    healthTimeoutMs: options.healthTimeoutMs,
  });

  if (!status.running || !status.healthy || !status.record) {
    throw new Error("Daemon is not running.");
  }

  await adminRequest(status.record, "/daemon/disable-tunnel", { method: "POST" });
  await delay(100);
  return await getDaemonStatus({
    configDir,
    reclaimStale: false,
    healthTimeoutMs: options.healthTimeoutMs,
  });
}

export interface ConsentEntrySummary {
  clientId: string;
  redirectUri: string;
  approvedAt: string;
  expiresAt: number;
}

async function requireRunningRecord(options: {
  configDir?: string;
  healthTimeoutMs?: number;
}): Promise<DaemonLockRecord> {
  const configDir = options.configDir ?? getConfigDir();
  const status = await getDaemonStatus({
    configDir,
    reclaimStale: true,
    healthTimeoutMs: options.healthTimeoutMs,
  });
  if (!status.running || !status.healthy || !status.record) {
    throw new Error("Daemon is not running.");
  }
  return status.record;
}

export async function listOAuthConsents(options: {
  configDir?: string;
  healthTimeoutMs?: number;
} = {}): Promise<ConsentEntrySummary[]> {
  const record = await requireRunningRecord(options);
  const body = await adminRequest(record, "/daemon/oauth-consents", { method: "GET" });
  const consents = (body as { consents?: ConsentEntrySummary[] })?.consents;
  return Array.isArray(consents) ? consents : [];
}

export async function revokeOAuthConsent(
  clientId: string,
  redirectUri?: string,
  options: { configDir?: string; healthTimeoutMs?: number } = {},
): Promise<number> {
  const record = await requireRunningRecord(options);
  const body = await adminRequest(record, "/daemon/oauth-consents", {
    method: "DELETE",
    body: redirectUri ? { clientId, redirectUri } : { clientId },
  });
  const removed = (body as { removed?: number })?.removed ?? 0;
  return Number(removed) || 0;
}

export async function revokeAllOAuthConsents(
  options: { configDir?: string; healthTimeoutMs?: number } = {},
): Promise<number> {
  const record = await requireRunningRecord(options);
  const body = await adminRequest(record, "/daemon/oauth-consents", { method: "DELETE" });
  const removed = (body as { removed?: number })?.removed ?? 0;
  return Number(removed) || 0;
}

export interface AuthorizedClientSummary {
  clientId: string;
  clientName?: string;
  registeredAt: number;
  lastUsedAt?: string;
  consentLastApprovedAt?: string;
  activeTokens: number;
}

export async function listOAuthClients(options: {
  configDir?: string;
  healthTimeoutMs?: number;
} = {}): Promise<AuthorizedClientSummary[]> {
  const record = await requireRunningRecord(options);
  const body = await adminRequest(record, "/daemon/oauth-clients", { method: "GET" });
  const clients = (body as { clients?: AuthorizedClientSummary[] })?.clients;
  return Array.isArray(clients) ? clients : [];
}

export async function revokeOAuthClient(
  clientId: string,
  options: { configDir?: string; healthTimeoutMs?: number } = {},
): Promise<boolean> {
  const record = await requireRunningRecord(options);
  const body = await adminRequest(record, "/daemon/oauth-clients", {
    method: "DELETE",
    body: { clientId },
  });
  const ok = (body as { ok?: boolean })?.ok;
  return Boolean(ok);
}

export async function revokeAllOAuthClients(
  options: { configDir?: string; healthTimeoutMs?: number } = {},
): Promise<number> {
  const record = await requireRunningRecord(options);
  const body = await adminRequest(record, "/daemon/oauth-clients", { method: "DELETE" });
  const removed = (body as { removed?: number })?.removed ?? 0;
  return Number(removed) || 0;
}

async function probeHealth(
  record: DaemonLockRecord,
  options: { timeoutMs?: number } = {},
): Promise<DaemonHealthStatus | null> {
  if (!record.port || record.port <= 0) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);

  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/daemon/health`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${record.bearerToken}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (process.env.PERPLEXITY_DEBUG === "1") {
        console.error(`[trace] probeHealth non-ok status=${response.status} port=${record.port}`);
      }
      return null;
    }
    return await response.json() as DaemonHealthStatus;
  } catch (err) {
    if (process.env.PERPLEXITY_DEBUG === "1") {
      const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(`[trace] probeHealth threw port=${record.port}: ${stack}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function adminRequest(
  record: DaemonLockRecord,
  path: string,
  options: { method: string; body?: unknown },
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${record.port}${path}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${record.bearerToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Daemon admin request failed (${response.status}): ${detail || response.statusText}`);
  }

  if (response.status === 204) {
    return null;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  return await response.text().catch(() => null);
}

function toConnectionInfo(record: DaemonLockRecord, health: DaemonHealthStatus): DaemonConnectionInfo {
  return {
    pid: record.pid,
    uuid: record.uuid,
    port: record.port,
    url: `http://127.0.0.1:${record.port}`,
    bearerToken: record.bearerToken,
    version: record.version,
    startedAt: record.startedAt,
    tunnelUrl: health.tunnel?.url ?? record.tunnelUrl ?? null,
  };
}

async function spawnDetachedDaemon(options: {
  configDir: string;
  host?: string;
  port?: number;
  tunnel?: boolean;
}): Promise<void> {
  const cliEntry = resolveCliEntry();
  const args = [cliEntry, "daemon", "start"];
  if (typeof options.port === "number") {
    args.push("--port", String(options.port));
  }
  if (options.tunnel) {
    args.push("--tunnel");
  }

  // Strip launcher-scoped flags that must never reach the daemon's own
  // PerplexityClient.init() — they would force headless mode or stdio bypass.
  const env = { ...process.env };
  delete env.PERPLEXITY_HEADLESS_ONLY;
  delete env.PERPLEXITY_NO_DAEMON;

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...env,
      PERPLEXITY_CONFIG_DIR: options.configDir,
    },
  });
  child.unref();
}

function resolveCliEntry(): string {
  // tsup CJS-bundles this module into the VS Code extension host, where
  // import.meta.url is polyfilled to empty. Extension callers must pass
  // spawnDaemon (see packages/extension/src/daemon/runtime.ts); this path
  // is only for plain Node ESM (CLI / npx).
  const moduleUrl =
    typeof import.meta.url === "string" && import.meta.url.length > 0 ? import.meta.url : null;
  if (!moduleUrl) {
    throw new Error(
      "Cannot resolve CLI entry: import.meta.url is unavailable in this runtime. " +
        "Pass spawnDaemon to ensureDaemon when running from a CJS-bundled host " +
        "(e.g. the VS Code extension).",
    );
  }
  const mjsPath = fileURLToPath(new URL("../cli.mjs", moduleUrl));
  if (existsSync(mjsPath)) {
    return mjsPath;
  }
  return fileURLToPath(new URL("../cli.js", moduleUrl));
}
