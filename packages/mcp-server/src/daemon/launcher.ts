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
import { acquire, getLockfilePath, isStale, read, release, replace, type DaemonLockRecord } from "./lockfile.js";
import { ensureToken, getTokenPath } from "./token.js";

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

  const health = await probeHealth(record, { timeoutMs: options.healthTimeoutMs });
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

    const finalize = async () => {
      if (!finalizePromise) {
        finalizePromise = (async () => {
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
        onTokenRotated: async (nextToken) => {
          replace(
            {
              pid: process.pid,
              uuid,
              port: server!.port,
              bearerToken: nextToken.bearerToken,
              version,
              startedAt,
              cloudflaredPid: null,
              tunnelUrl: null,
            },
            { lockPath, expectedUuid: uuid },
          );
        },
      });

      replace(
        {
          pid: process.pid,
          uuid,
          port: server.port,
          bearerToken: server.bearerToken,
          version,
          startedAt,
          cloudflaredPid: null,
          tunnelUrl: null,
        },
        { lockPath, expectedUuid: uuid },
      );

      process.on("SIGINT", signalHandler);
      process.on("SIGTERM", signalHandler);
      options.signal?.addEventListener("abort", abortHandler);

      return {
        attached: false,
        pid: process.pid,
        uuid,
        port: server.port,
        url: server.url,
        bearerToken: server.bearerToken,
        version,
        startedAt,
        tunnelUrl: null,
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
} = {}): Promise<{ stopped: boolean; pid?: number | null }> {
  const configDir = options.configDir ?? getConfigDir();
  const status = await getDaemonStatus({
    configDir,
    reclaimStale: true,
    healthTimeoutMs: options.healthTimeoutMs,
  });

  if (!status.running || !status.healthy || !status.record) {
    return { stopped: false, pid: status.record?.pid ?? null };
  }

  await adminRequest(status.record, "/daemon/shutdown", { method: "POST" });
  const deadline = Date.now() + (options.waitTimeoutMs ?? 10_000);

  while (Date.now() < deadline) {
    const nextStatus = await getDaemonStatus({
      configDir,
      reclaimStale: true,
      healthTimeoutMs: options.healthTimeoutMs,
    });
    if (!nextStatus.running) {
      return { stopped: true, pid: status.record.pid };
    }
    await delay(options.pollIntervalMs ?? 200);
  }

  throw new Error("Timed out waiting for daemon shutdown.");
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
      return null;
    }
    return await response.json() as DaemonHealthStatus;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function adminRequest(
  record: DaemonLockRecord,
  path: string,
  options: { method: string; body?: unknown },
): Promise<void> {
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
