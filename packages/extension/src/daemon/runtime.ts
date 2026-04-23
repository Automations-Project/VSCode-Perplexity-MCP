import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getSettingsSnapshot } from "../settings.js";
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
  listOAuthClients,
  listOAuthConsents,
  readAuditTail,
  restartDaemon,
  revokeAllOAuthClients,
  revokeAllOAuthConsents,
  revokeOAuthClient,
  revokeOAuthConsent,
  rotateDaemonToken,
  stopDaemon,
  syncCloudHistoryViaDaemon,
  type AuthorizedClientSummary,
  type ConsentEntrySummary,
  type DaemonCloudSyncProgress,
  type DaemonCloudSyncResult,
  type DaemonExportResult,
  type DaemonHydrateResult,
  type InstallTunnelResult,
} from "perplexity-user-mcp/daemon";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — subpath export from mcp-server daemon bundle
import {
  listTunnelProviderStatuses,
  readTunnelSettings,
  writeTunnelSettings,
  readNgrokSettings,
  writeNgrokSettings,
  clearNgrokSettings,
  runCloudflaredLogin,
  listNamedTunnels,
  createNamedTunnel,
  deleteNamedTunnel,
  clearNamedTunnelConfig,
  writeTunnelConfig,
  readNamedTunnelConfig,
  type TunnelProviderId,
  type TunnelProviderStatus,
  type NgrokSettings,
  type CloudflaredLoginResult,
  type NamedTunnelSummary,
  type CreatedTunnel,
  type NamedTunnelConfig,
  type DeletedNamedTunnel,
} from "perplexity-user-mcp/daemon/tunnel-providers";
import { existsSync as fsExistsSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

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

export async function killBundledDaemon() {
  const config = requireRuntimeConfig();
  // force=true escalates to SIGTERM/SIGKILL + lockfile release if the
  // daemon doesn't respond to the graceful /daemon/shutdown.
  return stopDaemon({ configDir: config.configDir, force: true, waitTimeoutMs: 3_000 });
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

export async function listBundledTunnelProviders(): Promise<TunnelProviderStatus[]> {
  const config = requireRuntimeConfig();
  return listTunnelProviderStatuses(config.configDir);
}

export function getBundledActiveTunnelProvider(): TunnelProviderId {
  const config = requireRuntimeConfig();
  return readTunnelSettings(config.configDir).activeProvider;
}

export function setBundledActiveTunnelProvider(id: TunnelProviderId): TunnelProviderId {
  const config = requireRuntimeConfig();
  const next = writeTunnelSettings(config.configDir, { activeProvider: id });
  return next.activeProvider;
}

export function getBundledNgrokSettings(): { configured: boolean; domain?: string; updatedAt?: string } {
  const config = requireRuntimeConfig();
  const settings = readNgrokSettings(config.configDir);
  if (!settings) return { configured: false };
  return {
    configured: true,
    ...(settings.domain ? { domain: settings.domain } : {}),
    updatedAt: settings.updatedAt,
  };
}

export function setBundledNgrokAuthtoken(authtoken: string): NgrokSettings {
  const config = requireRuntimeConfig();
  return writeNgrokSettings(config.configDir, { authtoken });
}

export function setBundledNgrokDomain(domain: string | null): NgrokSettings {
  const config = requireRuntimeConfig();
  return writeNgrokSettings(config.configDir, { domain });
}

export function clearBundledNgrokSettings(): void {
  const config = requireRuntimeConfig();
  clearNgrokSettings(config.configDir);
}

// ─────────────────────────────────────────────────────────────────────
// cf-named (cloudflared named-tunnel) setup wrappers — 8.4.3
// ─────────────────────────────────────────────────────────────────────

/**
 * Spawn `cloudflared tunnel login` on the host. Opens the user's default
 * browser so they can authorize the cert that lands at
 * `~/.cloudflared/cert.pem`. Resolves once the cert is observed.
 */
export async function runCfNamedLogin(
  options: { signal?: AbortSignal } = {},
): Promise<CloudflaredLoginResult> {
  const config = requireRuntimeConfig();
  return runCloudflaredLogin({
    configDir: config.configDir,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * List all cloudflared tunnels visible to the user's origin cert. Read-only;
 * no side effects. Used by the UI's "bind existing tunnel" alternative.
 */
export async function listCfNamedTunnels(): Promise<NamedTunnelSummary[]> {
  const config = requireRuntimeConfig();
  return listNamedTunnels({ configDir: config.configDir });
}

export async function deleteCfNamedTunnel(uuid: string): Promise<DeletedNamedTunnel> {
  const config = requireRuntimeConfig();
  return deleteNamedTunnel({ configDir: config.configDir, uuid });
}

/**
 * Either create a fresh tunnel (runs `cloudflared tunnel create` + DNS route)
 * OR bind the managed YAML to an existing tunnel UUID the user already set up
 * by hand. The "bind-existing" branch skips both network calls and just
 * rewrites `<configDir>/cloudflared-named.yml`.
 *
 * For bind-existing we require the `~/.cloudflared/<uuid>.json` credentials
 * file to exist up front; cloudflared would fail later with a cryptic error if
 * it's missing and the YAML would persist a broken config.
 *
 * Port is pinned to 1 as a placeholder — the provider's start() rewrites the
 * port on every spawn (port-drift rewrite). The YAML is worthless until
 * start() runs anyway, so the placeholder never leaks.
 */
export async function createCfNamedTunnel(params: {
  mode: "create" | "bind-existing";
  name?: string;
  hostname: string;
  uuid?: string;
}): Promise<CreatedTunnel | NamedTunnelConfig> {
  const config = requireRuntimeConfig();
  if (!params.hostname) throw new Error("hostname is required.");

  if (params.mode === "bind-existing") {
    const uuid = (params.uuid ?? "").trim();
    if (!uuid) throw new Error("uuid is required for bind-existing mode.");
    const credentialsPath = pathJoin(homedir(), ".cloudflared", `${uuid}.json`);
    if (!fsExistsSync(credentialsPath)) {
      throw new Error(
        `Credentials file not found at ${credentialsPath}. Run "cloudflared tunnel create" for this UUID first, or switch to "create" mode.`,
      );
    }
    return writeTunnelConfig({
      configDir: config.configDir,
      uuid,
      hostname: params.hostname,
      // Placeholder port. The provider's start() rewrites this to the live
      // daemon port on every spawn, so the value we persist here is never read.
      port: 1,
      credentialsPath,
    });
  }

  // mode === "create"
  const name = (params.name ?? "").trim();
  if (!name) throw new Error("name is required for create mode.");
  const created = await createNamedTunnel({
    configDir: config.configDir,
    name,
    hostname: params.hostname,
  });
  // Wire the newly-created tunnel into the managed YAML so the next daemon
  // start picks it up without a second UI round-trip.
  writeTunnelConfig({
    configDir: config.configDir,
    uuid: created.uuid,
    hostname: params.hostname,
    port: 1,
    credentialsPath: created.credentialsPath,
  });
  return created;
}

/** Read the managed cf-named YAML, or null if not configured. */
export async function readCfNamedConfig(): Promise<NamedTunnelConfig | null> {
  const config = requireRuntimeConfig();
  return readNamedTunnelConfig(config.configDir);
}

export function clearCfNamedConfig(): boolean {
  const config = requireRuntimeConfig();
  return clearNamedTunnelConfig(config.configDir);
}

export function getBundledCfNamedState(): {
  config: { uuid: string; hostname: string; configPath: string; credentialsPresent: boolean } | null;
} {
  const config = requireRuntimeConfig();
  const managed = readNamedTunnelConfig(config.configDir);
  if (!managed) return { config: null };
  return {
    config: {
      uuid: managed.uuid,
      hostname: managed.hostname,
      configPath: managed.configPath,
      credentialsPresent: fsExistsSync(managed.credentialsPath),
    },
  };
}

export function readBundledDaemonAuditTail(limit = 50) {
  const config = requireRuntimeConfig();
  return readAuditTail(limit, { auditPath: getAuditLogPath(config.configDir) });
}

export async function listBundledOAuthConsents(): Promise<ConsentEntrySummary[]> {
  const config = requireRuntimeConfig();
  return listOAuthConsents({ configDir: config.configDir });
}

export async function revokeBundledOAuthConsent(clientId: string, redirectUri?: string): Promise<number> {
  const config = requireRuntimeConfig();
  return revokeOAuthConsent(clientId, redirectUri, { configDir: config.configDir });
}

export async function revokeAllBundledOAuthConsents(): Promise<number> {
  const config = requireRuntimeConfig();
  return revokeAllOAuthConsents({ configDir: config.configDir });
}

export async function listBundledOAuthClients(): Promise<AuthorizedClientSummary[]> {
  const config = requireRuntimeConfig();
  return listOAuthClients({ configDir: config.configDir });
}

export async function revokeBundledOAuthClient(clientId: string): Promise<boolean> {
  const config = requireRuntimeConfig();
  return revokeOAuthClient(clientId, { configDir: config.configDir });
}

export async function revokeAllBundledOAuthClients(): Promise<number> {
  const config = requireRuntimeConfig();
  return revokeAllOAuthClients({ configDir: config.configDir });
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
  let consentTtlHours = 24;
  try {
    consentTtlHours = getSettingsSnapshot().oauthConsentCacheTtlHours;
  } catch {
    // settings unavailable outside the extension host — fall back to default
  }
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
      PERPLEXITY_OAUTH_CONSENT_TTL_HOURS: String(consentTtlHours),
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
