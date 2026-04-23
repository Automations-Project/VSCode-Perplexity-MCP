/**
 * Cloudflared named-tunnel provider.
 *
 * Runs a persistent Cloudflare tunnel that routes a user-owned hostname
 * (e.g. https://mcp.example.com) to the local daemon HTTP port. Unlike
 * cloudflared-quick, the URL is stable across restarts.
 *
 * Setup (one-time, handled by 8.4.3 UI + 8.4.4 CLI) produces:
 *   - ~/.cloudflared/cert.pem              (origin cert from `cloudflared login`)
 *   - ~/.cloudflared/<uuid>.json           (tunnel credentials, written by create)
 *   - <configDir>/cloudflared-named.yml    (managed ingress config we serialize)
 *
 * Port-drift rewrite (load-bearing): the managed YAML embeds the daemon's
 * loopback port. The daemon picks a fresh OS-assigned port on most restarts,
 * so the persisted port is almost always stale by the time start() runs. We
 * rewrite the managed YAML with the current port on every start() — idempotent
 * atomic writes are cheap, forgetting the rewrite routes cloudflared to a
 * dead port.
 *
 * The managed YAML is treated as provider-owned — hand-edits to add extra
 * ingress rules WILL be silently dropped on the next start() because we
 * serialize only the four canonical keys (tunnel / credentials-file /
 * hostname / service). Warning on drift is deferred to 8.4.3.
 */

import { existsSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

import type { StartedTunnel, TunnelState } from "../tunnel.js";
import { getTunnelBinaryPath } from "../install-tunnel.js";
import {
  readNamedTunnelConfig,
  writeTunnelConfig,
} from "./cloudflared-named-setup.js";
import type { SetupCheck, TunnelProvider, TunnelProviderStartOptions } from "./types.js";

const execFile = promisify(execFileCallback);

/** Grace period between SIGTERM and SIGKILL when stopping a named tunnel. */
const STOP_GRACE_MS = 3_000;

/**
 * cloudflared emits `INF Registered tunnel connection connIndex=N` on stderr
 * once per edge connection when the tunnel is live. The first one means the
 * tunnel is routing traffic — that's our "enabled" signal.
 */
const READY_LINE_REGEX = /Registered tunnel connection/i;

type SpawnFn = typeof nodeSpawn;

interface ProviderDependencies {
  spawn?: SpawnFn;
  homedir?: () => string;
}

/**
 * Build a provider bound to a specific dependency set. The exported
 * singleton uses node defaults; tests construct a one-off via
 * createCloudflaredNamedProvider({ dependencies: { spawn: fakeSpawn } }).
 */
export function createCloudflaredNamedProvider(
  options: { dependencies?: ProviderDependencies } = {},
): TunnelProvider {
  const spawnImpl = options.dependencies?.spawn ?? nodeSpawn;
  const homedirImpl = options.dependencies?.homedir ?? homedir;

  return {
    id: "cf-named",
    displayName: "Cloudflare Named Tunnel",
    description:
      "Persistent URL on your own Cloudflare-managed zone. Requires one-time `cloudflared login` + tunnel create.",

    async isSetupComplete(configDir: string): Promise<SetupCheck> {
      // Ordered: binary → cert → managed config → credentials file.
      // Each failure returns a distinct `reason` so the UI can surface the
      // next action the user should take.
      const binaryPath = getTunnelBinaryPath(configDir);
      if (!existsSync(binaryPath)) {
        return {
          ready: false,
          reason: "cloudflared binary not installed.",
          action: { label: "Install cloudflared", kind: "install-binary" },
        };
      }

      const certPath = join(homedirImpl(), ".cloudflared", "cert.pem");
      if (!existsSync(certPath)) {
        return {
          ready: false,
          reason: "cloudflared login required — origin cert not found.",
          action: { label: "Run cloudflared login", kind: "open-url" },
        };
      }

      const config = readNamedTunnelConfig(configDir);
      if (!config) {
        return {
          ready: false,
          reason: "named tunnel not configured — run the setup flow.",
        };
      }

      if (!existsSync(config.credentialsPath)) {
        return {
          ready: false,
          reason: `credentials file not found at ${config.credentialsPath}.`,
        };
      }

      return { ready: true };
    },

    async start(startOptions: TunnelProviderStartOptions): Promise<StartedTunnel> {
      // Re-validate — isSetupComplete is the single source of truth for "can
      // we start?". Callers hit start() after the UI/CLI confirmed setup, but
      // state can drift (user deleted the credentials file between clicks).
      const binaryPath = getTunnelBinaryPath(startOptions.configDir);
      if (!existsSync(binaryPath)) {
        throw new Error(
          "cloudflared is not installed. Run `npx perplexity-user-mcp daemon install-tunnel` first.",
        );
      }
      const certPath = join(homedirImpl(), ".cloudflared", "cert.pem");
      if (!existsSync(certPath)) {
        throw new Error(
          "cloudflared named tunnel not set up — origin cert missing. Run `cloudflared tunnel login`.",
        );
      }
      const existing = readNamedTunnelConfig(startOptions.configDir);
      if (!existing) {
        throw new Error(
          "named tunnel not configured — run the cf-named setup flow from the dashboard or CLI.",
        );
      }
      if (!existsSync(existing.credentialsPath)) {
        throw new Error(
          `named tunnel credentials file missing at ${existing.credentialsPath}.`,
        );
      }

      // Port-drift rewrite (see module-level comment). Always rewrite —
      // cheap, atomic, and the one bug we most want to avoid.
      const refreshed = writeTunnelConfig({
        configDir: startOptions.configDir,
        uuid: existing.uuid,
        hostname: existing.hostname,
        port: startOptions.port,
        credentialsPath: existing.credentialsPath,
      });

      return spawnNamedTunnel({
        binaryPath,
        configPath: refreshed.configPath,
        hostname: refreshed.hostname,
        onStateChange: startOptions.onStateChange,
        spawnImpl,
      });
    },
  };
}

/**
 * Default singleton wired to node's real spawn. Registered in the provider
 * registry; tests use createCloudflaredNamedProvider() for DI.
 */
export const cloudflaredNamedProvider: TunnelProvider = createCloudflaredNamedProvider();

// ─────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────

interface SpawnNamedTunnelOptions {
  binaryPath: string;
  configPath: string;
  hostname: string;
  onStateChange: (state: TunnelState) => void;
  spawnImpl: SpawnFn;
}

/**
 * Parallel to startTunnel() in tunnel.ts, but:
 *   - args are `tunnel --no-autoupdate --config <yml> run` (not `--url ...`)
 *   - ready-detection watches for "Registered tunnel connection" on stderr
 *     (not trycloudflare.com URL extraction)
 *   - URL is statically `https://<hostname>` (known before spawn)
 *
 * Kept local to this file to avoid refactoring the working quick-tunnel path.
 */
function spawnNamedTunnel(options: SpawnNamedTunnelOptions): StartedTunnel {
  const args = [
    "tunnel",
    "--no-autoupdate",
    "--config",
    options.configPath,
    "run",
  ];
  const child = options.spawnImpl(options.binaryPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    windowsHide: true,
  });

  const hostnameUrl = `https://${options.hostname}`;

  let stopping = false;
  let settled = false;
  let resolveExited: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  let state: TunnelState = {
    status: "starting",
    url: null,
    pid: child.pid ?? null,
    error: null,
  };

  const updateState = (next: TunnelState) => {
    state = next;
    options.onStateChange(state);
  };
  updateState(state);

  let resolveReady: (url: string) => void;
  let rejectReady: (error: Error) => void;
  const waitUntilReady = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const handleLine = (line: string) => {
    if (settled) return;
    if (!READY_LINE_REGEX.test(line)) return;
    settled = true;
    updateState({
      status: "enabled",
      url: hostnameUrl,
      pid: child.pid ?? null,
      error: null,
    });
    resolveReady(hostnameUrl);
  };

  if (child.stderr) createInterface({ input: child.stderr }).on("line", handleLine);
  if (child.stdout) createInterface({ input: child.stdout }).on("line", handleLine);

  child.on("error", (error) => {
    if (!settled) {
      settled = true;
      rejectReady(error);
    }
    updateState({
      status: stopping ? "disabled" : "crashed",
      url: null,
      pid: child.pid ?? null,
      error: error.message,
    });
  });

  child.on("exit", (code, signal) => {
    if (!settled) {
      settled = true;
      rejectReady(
        new Error(
          `cloudflared exited before the named tunnel came online (code=${code ?? "null"} signal=${signal ?? "null"}).`,
        ),
      );
    }
    updateState({
      status: stopping ? "disabled" : "crashed",
      url: stopping ? null : state.url,
      pid: null,
      error: stopping
        ? null
        : `cloudflared exited (code=${code ?? "null"} signal=${signal ?? "null"}).`,
    });
    resolveExited();
  });

  const stop = async () => {
    if (stopping) return;
    stopping = true;

    if (child.exitCode !== null || child.killed) {
      updateState({ status: "disabled", url: null, pid: null, error: null });
      resolveExited();
      return;
    }

    // On Windows, detached cloudflared doesn't reliably respond to SIGTERM;
    // use taskkill /T /F for the same reason startTunnel() does. Skip the
    // grace window on win32 because the OS process tree needs force-kill
    // anyway.
    if (process.platform === "win32") {
      await execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => undefined);
      await exited;
      return;
    }

    child.kill("SIGTERM");
    const escalate = setTimeout(() => {
      if (!killedOrExited(child)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // best-effort
        }
      }
    }, STOP_GRACE_MS);
    try {
      await exited;
    } finally {
      clearTimeout(escalate);
    }
  };

  return {
    pid: child.pid ?? 0,
    waitUntilReady,
    stop,
    getState: () => state,
  };
}

function killedOrExited(child: ChildProcess): boolean {
  return child.killed || child.exitCode !== null;
}
