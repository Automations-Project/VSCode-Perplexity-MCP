import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  disableDaemonTunnel,
  enableDaemonTunnel,
  ensureDaemon,
  exportHistoryViaDaemon,
  getDaemonStatus,
  getAuditLogPath,
  getTunnelBinaryPath,
  hydrateCloudHistoryEntryViaDaemon,
  installCloudflared,
  readAuditTail,
  restartDaemon,
  rotateDaemonToken,
  syncCloudHistoryViaDaemon,
  type DaemonCloudSyncProgress,
  type DaemonCloudSyncResult,
  type DaemonExportResult,
  type DaemonHydrateResult,
  type InstallTunnelResult,
} from "perplexity-user-mcp/daemon";

const DAEMON_LOG_MAX_BYTES = 2 * 1024 * 1024;

interface RuntimeConfig {
  configDir: string;
  serverPath: string;
}

let runtimeConfig: RuntimeConfig | null = null;

export function configureDaemonRuntime(config: RuntimeConfig): void {
  runtimeConfig = config;
}

export async function ensureBundledDaemon() {
  const config = requireRuntimeConfig();
  return ensureDaemon({
    configDir: config.configDir,
    spawnDaemon: spawnBundledDaemon,
    treatSelfAsZombie: true,
  });
}

export async function exportHistoryFromDaemon(historyId: string, format: "pdf" | "markdown" | "docx"): Promise<DaemonExportResult> {
  const config = requireRuntimeConfig();
  return exportHistoryViaDaemon(historyId, format, {
    configDir: config.configDir,
    spawnDaemon: spawnBundledDaemon,
  });
}

export async function syncCloudHistoryFromDaemon(
  onProgress: (progress: DaemonCloudSyncProgress) => void,
  options: { pageSize?: number } = {},
): Promise<DaemonCloudSyncResult> {
  const config = requireRuntimeConfig();
  return syncCloudHistoryViaDaemon({
    configDir: config.configDir,
    spawnDaemon: spawnBundledDaemon,
    pageSize: options.pageSize,
    onProgress,
  });
}

export async function hydrateCloudEntryFromDaemon(historyId: string): Promise<DaemonHydrateResult> {
  const config = requireRuntimeConfig();
  return hydrateCloudHistoryEntryViaDaemon(historyId, {
    configDir: config.configDir,
    spawnDaemon: spawnBundledDaemon,
  });
}

export async function getBundledDaemonStatus() {
  const config = requireRuntimeConfig();
  return getDaemonStatus({
    configDir: config.configDir,
    reclaimStale: true,
  });
}

export async function rotateBundledDaemonToken() {
  const config = requireRuntimeConfig();
  return rotateDaemonToken({ configDir: config.configDir });
}

export async function restartBundledDaemon() {
  const config = requireRuntimeConfig();
  return restartDaemon({
    configDir: config.configDir,
    spawnDaemon: spawnBundledDaemon,
    treatSelfAsZombie: true,
  });
}

export async function enableBundledDaemonTunnel() {
  const config = requireRuntimeConfig();
  return enableDaemonTunnel({ configDir: config.configDir });
}

export async function disableBundledDaemonTunnel() {
  const config = requireRuntimeConfig();
  return disableDaemonTunnel({ configDir: config.configDir });
}

export function isCloudflaredInstalled(): boolean {
  const config = requireRuntimeConfig();
  return existsSync(getTunnelBinaryPath(config.configDir));
}

export async function installBundledCloudflared(): Promise<InstallTunnelResult> {
  const config = requireRuntimeConfig();
  return installCloudflared({ configDir: config.configDir });
}

export function readBundledDaemonAuditTail(limit = 50) {
  const config = requireRuntimeConfig();
  return readAuditTail(limit, { auditPath: getAuditLogPath(config.configDir) });
}

export function getBundledDaemonConfigDir(): string {
  return requireRuntimeConfig().configDir;
}

function requireRuntimeConfig(): RuntimeConfig {
  if (!runtimeConfig) {
    throw new Error("Daemon runtime has not been configured yet.");
  }
  return runtimeConfig;
}

async function spawnBundledDaemon(options: { configDir: string; host?: string; port?: number; tunnel?: boolean }): Promise<void> {
  const config = requireRuntimeConfig();
  const args = [config.serverPath, "daemon", "start"];
  if (typeof options.port === "number") {
    args.push("--port", String(options.port));
  }
  if (options.tunnel) {
    args.push("--tunnel");
  }

  const logFd = openDaemonLogFd(options.configDir);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      // Critical: process.execPath inside a VS Code extension host points at
      // Electron, not Node. Without this flag Electron ignores the JS script
      // and starts a GUI session. ELECTRON_RUN_AS_NODE=1 tells the same
      // binary to behave as a pure Node runtime for this child.
      ELECTRON_RUN_AS_NODE: "1",
      PERPLEXITY_CONFIG_DIR: options.configDir,
    },
  });
  closeSync(logFd);
  child.on("error", (err) => {
    try {
      const extraFd = openDaemonLogFd(options.configDir);
      const message = `\n[trace] spawnBundledDaemon error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
      require("node:fs").writeSync(extraFd, message);
      closeSync(extraFd);
    } catch {
      // logging best-effort
    }
  });
  child.unref();
}

function openDaemonLogFd(configDir: string): number {
  mkdirSync(configDir, { recursive: true });
  const logPath = join(configDir, "daemon.log");
  try {
    const stat = statSync(logPath);
    if (stat.size > DAEMON_LOG_MAX_BYTES) {
      renameSync(logPath, logPath + ".1");
    }
  } catch {
    // fresh log
  }
  return openSync(logPath, "a");
}
