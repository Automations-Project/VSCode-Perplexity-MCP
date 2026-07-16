import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { resolveNodePath } from "../auto-config/index.js";
import { getSettingsSnapshot } from "../settings.js";
import { isLockStale, killStaleDaemonPid, removeStaleLock } from "./stale-version.js";
import {
  disableDaemonTunnel,
  enableDaemonTunnel,
  ensureDaemon,
  exportHistoryViaDaemon,
  getDaemonStatus,
  getAuditLogPath,
  getLockfilePath,
  getTunnelBinaryPath,
  hydrateCloudHistoryEntryViaDaemon,
  installCloudflared,
  listOAuthClients,
  listOAuthConsents,
  readAuditTail,
  read as readDaemonLock,
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
  /**
   * MCP package version from dist/mcp/package.json — used for code-graph
   * staleness (must match lock.mcpVersion / getPackageVersion()).
   */
  bundledVersion: string;
  /**
   * Extension package version. Stamped into the daemon env as
   * PERPLEXITY_LOCK_COMPAT_VERSION so lock.version satisfies legacy reapers
   * that compared lock.version to extension.packageJSON.version.
   */
  extensionVersion?: string;
  /** Optional logger; falls back to a no-op for tests / pre-init paths. */
  log?: (line: string) => void;
  /**
   * Async provider returning env vars to merge into the daemon's spawn env.
   * Called once per spawn (no caching). Implementations live in extension.ts
   * and may read VS Code SecretStorage; this seam keeps daemon/runtime.ts
   * free of any vscode import.
   *
   * Returned keys will be merged AFTER process.env and BEFORE the hard-coded
   * overrides (ELECTRON_RUN_AS_NODE / PERPLEXITY_CONFIG_DIR / ...), so the
   * provider cannot accidentally override critical spawn env. (Merge logic
   * itself is added in a follow-up task; this task only declares the type.)
   */
  buildDaemonEnv?: () => Promise<Record<string, string>>;
  /**
   * Surface a user-facing daemon problem (a toast in the extension host).
   *
   * Same seam rationale as `buildDaemonEnv`: the implementation lives in
   * extension.ts so this module stays free of any vscode import. Omitted in
   * tests / standalone paths, where the message still reaches daemon.log.
   */
  notifyDaemonProblem?: (problem: DaemonSpawnProblem) => void;
}

/** A daemon-spawn failure worth interrupting the user for. */
export interface DaemonSpawnProblem {
  kind: "node-missing";
  message: string;
  /** True when we started a degraded daemon on the editor's own runtime. */
  degradedFallbackStarted: boolean;
}

let runtimeConfig: RuntimeConfig | null = null;

export function configureDaemonRuntime(config: RuntimeConfig): void {
  runtimeConfig = config;
}

/**
 * If a daemon.lock exists with a `version` that doesn't match the bundled
 * version, the running daemon was launched by a previous extension version
 * and is pinned to chunk filenames that no longer exist on disk. SIGTERM the
 * pid and remove the lock so the existing ensure-loop falls through to the
 * spawn path. See [stale-version.ts] for the rule.
 */
function reapStaleVersionedDaemon(config: RuntimeConfig): void {
  const lockPath = getLockfilePath(config.configDir);
  let lock: { pid: number; version: string; mcpVersion?: string } | null = null;
  try {
    lock = readDaemonLock({ lockPath }) as { pid: number; version: string; mcpVersion?: string } | null;
  } catch {
    return; // corrupt JSON — existing flow handles it
  }
  if (!lock) return;
  if (!isLockStale(lock, config.bundledVersion)) return;

  const log = config.log ?? (() => undefined);
  const lockCode = lock.mcpVersion ?? lock.version ?? "unknown";
  log(
    `[daemon] stale daemon detected (lock.mcpVersion=${lock.mcpVersion ?? "—"} lock.version=${lock.version ?? "—"} ` +
      `code=${lockCode}, bundledMcp=${config.bundledVersion}) — restarting`,
  );
  killStaleDaemonPid(lock.pid, log);
  removeStaleLock(lockPath);
}

// Observed-port tracking (issue #14). The daemon binds an OS-assigned
// ephemeral port on every start, and VS Code caches the URL we bake into the
// McpHttpServerDefinition — so when a respawn lands on a new port, someone
// must tell VS Code to re-resolve or it hammers the dead port forever.
// Every daemon-ensure in the extension funnels through ensureBundledDaemon,
// which makes this the one place that can see the port move.
let lastObservedPort: number | null = null;
let portChangeListener: ((port: number) => void) | null = null;

/** Register the (single) listener notified when the daemon's port changes. */
export function onBundledDaemonPortChange(listener: (port: number) => void): void {
  portChangeListener = listener;
}

function notifyDaemonPortObserved(port: number): void {
  const changed = lastObservedPort !== null && lastObservedPort !== port;
  lastObservedPort = port;
  if (changed) {
    try {
      portChangeListener?.(port);
    } catch {
      // A listener failure must never break the ensure path.
    }
  }
}

/**
 * `Perplexity.daemonPort` from settings, or undefined when unset/invalid.
 * This setting existed (and the port-pin nudge wrote it) but nothing ever
 * consumed it — pinning was a no-op and every daemon start drew a fresh
 * ephemeral port (issue #14).
 */
function getPinnedDaemonPort(): number | undefined {
  try {
    const port = getSettingsSnapshot().daemonPort;
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  } catch {
    // settings unavailable outside the extension host
  }
  return undefined;
}

export async function ensureBundledDaemon(options: { startTimeoutMs?: number } = {}) {
  const config = requireRuntimeConfig();
  reapStaleVersionedDaemon(config);
  const pinnedPort = getPinnedDaemonPort();
  const info = await ensureDaemon({
    configDir: config.configDir,
    spawnDaemon: spawnBundledDaemon,
    treatSelfAsZombie: true,
    // Belt-and-braces with reapStaleVersionedDaemon above: that reaps on this
    // activation path, this makes the launcher itself refuse to attach to a
    // daemon from a different build (e.g. one spawned by another window still
    // running the previous VSIX). bundledVersion is the MCP package version
    // from dist/mcp/package.json — the same value the daemon stamps as
    // lock.mcpVersion.
    expectedMcpVersion: config.bundledVersion,
    ...(pinnedPort !== undefined ? { port: pinnedPort } : {}),
    ...(options.startTimeoutMs !== undefined ? { startTimeoutMs: options.startTimeoutMs } : {}),
  });
  notifyDaemonPortObserved(info.port);
  return info;
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

  let consentTtlHours = 24;
  try {
    consentTtlHours = getSettingsSnapshot().oauthConsentCacheTtlHours;
  } catch {
    // settings unavailable outside the extension host — fall back to default
  }
  let extraEnv: Record<string, string> = {};
  if (config.buildDaemonEnv) {
    try {
      const provided = await config.buildDaemonEnv();
      if (provided && typeof provided === "object") {
        for (const [k, v] of Object.entries(provided)) {
          if (typeof k === "string" && typeof v === "string") {
            extraEnv[k] = v;
          } else {
            (config.log ?? (() => undefined))(
              `[daemon] buildDaemonEnv produced non-string entry for ${String(k)}; ignored`,
            );
          }
        }
      }
    } catch (err) {
      (config.log ?? (() => undefined))(
        `[daemon] buildDaemonEnv threw: ${err instanceof Error ? err.message : String(err)}; spawning without overlay`,
      );
    }
  }

  // Telemetry: log only the SET/UNSET status of vault passphrase, never the value.
  (config.log ?? (() => undefined))(
    `[daemon] PERPLEXITY_VAULT_PASSPHRASE: ${extraEnv.PERPLEXITY_VAULT_PASSPHRASE ? "set" : "unset"}`,
  );

  // Strip launcher-scoped flags that must never reach the daemon's own
  // PerplexityClient.init() — they would force headless mode or stdio bypass.
  const baseEnv = { ...process.env };
  delete baseEnv.PERPLEXITY_HEADLESS_ONLY;
  delete baseEnv.PERPLEXITY_NO_DAEMON;

  // Prefer a real Node binary. Spawning the IDE's Electron binary with
  // ELECTRON_RUN_AS_NODE works for pure-JS health checks, but Chromium
  // (patchright) launched from that process is unstable on Windsurf/Devin/
  // VS Code hosts — the daemon dies mid-tool-call and every MCP client sees
  // `transport closed`. resolveNodePath() already handles PATH + well-known
  // install locations (and PERPLEXITY_NODE_PATH override).
  const nodePath = resolveNodePath();
  const execName = nodePath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const usingRealNode = execName.startsWith("node");
  // resolveNodePath()'s last resort is the literal string "node" — it found
  // nothing on disk and is betting on PATH. That bet is the only way we can
  // get ENOENT here, and it's the case worth telling the user about.
  const isUnresolvedNodeGuess = nodePath === "node";
  (config.log ?? (() => undefined))(
    `[daemon] spawning with ${nodePath}${usingRealNode ? "" : " (non-node host; ELECTRON_RUN_AS_NODE=1)"}` +
      `${isUnresolvedNodeGuess ? " (unresolved — relying on PATH)" : ""}`,
  );

  // When using real Node, strip any inherited ELECTRON_RUN_AS_NODE so a
  // leftover flag from the extension host cannot confuse child tooling.
  if (usingRealNode) {
    delete baseEnv.ELECTRON_RUN_AS_NODE;
    delete extraEnv.ELECTRON_RUN_AS_NODE;
  }

  // Legacy reaper compat: stamp lock.version with the extension package
  // version so pre-0.8.57 reapers (lock.version === extension.version) leave
  // this daemon alone. The daemon still records mcpVersion for new reapers.
  if (config.extensionVersion) {
    extraEnv.PERPLEXITY_LOCK_COMPAT_VERSION = config.extensionVersion;
  }

  const launch = (bin: string, electronAsNode: boolean) => {
    const fd = openDaemonLogFd(options.configDir);
    const child = spawn(bin, args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...baseEnv,
        ...extraEnv,
        // Hard-coded overrides — must come AFTER extraEnv so a buggy provider
        // cannot clobber them.
        // Only needed when falling back to an Electron host binary.
        ...(electronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        PERPLEXITY_CONFIG_DIR: options.configDir,
        PERPLEXITY_OAUTH_CONSENT_TTL_HOURS: String(consentTtlHours),
      },
    });
    closeSync(fd);
    return child;
  };

  const appendDaemonLog = (line: string) => {
    try {
      const extraFd = openDaemonLogFd(options.configDir);
      require("node:fs").writeSync(extraFd, line);
      closeSync(extraFd);
    } catch {
      // logging best-effort
    }
  };

  const child = launch(nodePath, !usingRealNode);
  child.on("error", (err) => {
    appendDaemonLog(
      `\n[trace] spawnBundledDaemon error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );

    const isEnoent = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    if (!isEnoent || !isUnresolvedNodeGuess) {
      return;
    }

    // resolveNodePath() guessed bare "node" and PATH did not have it. Without
    // this the only symptom is ensureDaemon timing out after 15s and a line
    // buried in daemon.log — the user gets no idea Node is simply missing.
    //
    // Fall back ONCE to the editor's own Electron binary in Node mode. That is
    // a DEGRADED daemon, not a fix: pure-JS work (health, doctor, models
    // cache, history) is fine, but Chromium launched via patchright from an
    // Electron host is unstable on VS Code/Windsurf/Devin — the daemon dies
    // mid-tool-call and every MCP client sees `transport closed`. It buys the
    // user a working dashboard + doctor to diagnose from; installing Node (or
    // setting PERPLEXITY_NODE_PATH) is the actual fix, which is why the toast
    // says so rather than quietly limping on.
    const message =
      "Node.js not found — install Node 22+ or set PERPLEXITY_NODE_PATH to your node binary.";
    appendDaemonLog(
      `[daemon] ${message} Falling back once to ${process.execPath} with ELECTRON_RUN_AS_NODE=1 ` +
        `(degraded: browser-backed tools may drop mid-call).\n`,
    );
    (config.log ?? (() => undefined))(`[daemon] ${message} Falling back to the editor runtime (degraded).`);

    let degradedFallbackStarted = false;
    try {
      const fallback = launch(process.execPath, true);
      fallback.on("error", (fallbackErr) => {
        appendDaemonLog(
          `\n[trace] spawnBundledDaemon electron-fallback error: ` +
            `${fallbackErr instanceof Error ? fallbackErr.stack ?? fallbackErr.message : String(fallbackErr)}\n`,
        );
      });
      fallback.unref();
      degradedFallbackStarted = true;
    } catch (fallbackErr) {
      appendDaemonLog(`\n[trace] spawnBundledDaemon electron-fallback threw: ${String(fallbackErr)}\n`);
    }

    try {
      config.notifyDaemonProblem?.({ kind: "node-missing", message, degradedFallbackStarted });
    } catch {
      // A notifier failure must never break the spawn path.
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
