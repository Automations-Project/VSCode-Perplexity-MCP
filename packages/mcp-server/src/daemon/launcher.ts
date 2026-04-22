import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PerplexityClient } from "../client.js";
import { getActiveName, getConfigDir } from "../profiles.js";
import { watchReinit } from "../reinit-watcher.js";
import type { StartedDaemonServer } from "./server.js";
import { startDaemonServer } from "./server.js";
import { getTunnelBinaryPath } from "./install-tunnel.js";
import { acquire, getLockfilePath, isStale, read, release, replace, type DaemonLockRecord } from "./lockfile.js";
import { ensureToken, getTokenPath, readToken } from "./token.js";
import type { StartedTunnel, TunnelState } from "./tunnel.js";
import { getTunnelProvider, readTunnelSettings } from "./tunnel-providers/index.js";

export interface DaemonHealthStatus {
  ok: boolean;
  pid: number;
  uuid: string | null;
  version: string;
  port: number;
  uptimeMs: number;
  startedAt: string;
  heartbeatCount?: number;
  tunnel?: {
    status?: string;
    url?: string | null;
    pid?: number | null;
    error?: string | null;
  };
}

export interface DaemonStatus {
  running: boolean;
  healthy: boolean;
  stale: boolean;
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
  const healthy = Boolean(health?.ok && health.uuid === record.uuid);
  const stale = !healthy && isStale(record, { echoedUuid: health?.uuid ?? null });

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
    configDir,
    lockPath,
    tokenPath,
    record,
    health,
  };
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<DaemonConnectionInfo> {
  const configDir = options.configDir ?? getConfigDir();
  const deadline = Date.now() + (options.startTimeoutMs ?? 15_000);
  let launched = false;

  while (Date.now() < deadline) {
    const status = await getDaemonStatus({
      configDir,
      reclaimStale: true,
      healthTimeoutMs: options.healthTimeoutMs,
      treatSelfAsZombie: options.treatSelfAsZombie,
    });
    if (status.running && status.healthy && status.record && status.health) {
      return toConnectionInfo(status.record, status.health);
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

  throw new Error(`Timed out waiting for daemon startup in ${configDir}.`);
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<StartedDaemonInstance> {
  const configDir = options.configDir ?? getConfigDir();
  const lockPath = getLockfilePath(configDir);
  const tokenPath = getTokenPath(configDir);
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 200;
  const version = options.version ?? process.env.npm_package_version ?? "0.5.0";

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
      startedAt,
      cloudflaredPid: null,
      tunnelUrl: null,
    };

    if (!acquire(provisional, { lockPath })) {
      await delay(retryDelayMs);
      continue;
    }

    let watcher: ReturnType<typeof watchReinit> | undefined;
    let server: StartedDaemonServer | undefined;
    let finalizePromise: Promise<void> | null = null;
    let finalizeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      finalizeResolve = resolve;
    });

    const profile = process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
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
      watcher = watchReinit(profile, async () => {
        await client.reinit();
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
      watcher?.dispose();
      release({ lockPath, expectedUuid: uuid });
      await server?.close?.().catch(() => undefined);
      throw error;
    }
  }

  throw new Error(`Unable to start or attach to daemon after ${retries} attempts.`);
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

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PERPLEXITY_CONFIG_DIR: options.configDir,
    },
  });
  child.unref();
}

function resolveCliEntry(): string {
  const mjsPath = fileURLToPath(new URL("../cli.mjs", import.meta.url));
  if (existsSync(mjsPath)) {
    return mjsPath;
  }
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}
