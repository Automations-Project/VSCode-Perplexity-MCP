/**
 * Cloudflared named-tunnel setup helpers.
 *
 * Wraps the `cloudflared` CLI to drive a persistent (named) tunnel. Named
 * tunnels require an origin cert (`~/.cloudflared/cert.pem`), a tunnel UUID
 * + credentials file, and a YAML config that maps a hostname -> local port.
 *
 * This module ships the setup primitives only; provider registration lives in
 * cloudflared-named.ts (Phase 8.4.2). The dashboard/CLI call these helpers
 * during the one-time setup flow.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

import { getTunnelBinaryPath } from "../install-tunnel.js";

/**
 * Minimal spawn signature we rely on — matches the three-arg overload of
 * `node:child_process.spawn` used for piping stdio and collecting output.
 * Declared as a type alias so tests can inject a fake implementation.
 */
type SpawnFn = typeof nodeSpawn;

export interface CloudflaredLoginResult {
  ok: boolean;
  certPath: string;
  stderr?: string;
}

export interface NamedTunnelSummary {
  /** cloudflared's tunnel UUID. */
  uuid: string;
  /** Human-readable name. */
  name: string;
  createdAt?: string;
  connections?: number;
}

export interface CreatedTunnel extends NamedTunnelSummary {
  /** Path to the credentials JSON cloudflared wrote. */
  credentialsPath: string;
}

export interface NamedTunnelConfig {
  uuid: string;
  /** e.g. "mcp.example.com" */
  hostname: string;
  /** Local daemon HTTP port. */
  port: number;
  /** Full path to the written .yml. */
  configPath: string;
  credentialsPath: string;
}

const CONFIG_FILENAME = "cloudflared-named.yml";
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CERT_POLL_INTERVAL_MS = 250;

// ─────────────────────────────────────────────────────────────────────
// cloudflared login
// ─────────────────────────────────────────────────────────────────────

/**
 * Runs `cloudflared tunnel login`. Opens a browser. Blocks until the cert
 * lands at `~/.cloudflared/cert.pem` (or throws on timeout / abort). The
 * login subprocess is best-effort terminated on resolve/reject.
 */
export function runCloudflaredLogin(options: {
  configDir: string;
  binaryPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Override the cert watch location (defaults to `$HOME/.cloudflared/cert.pem`). */
  certPath?: string;
  /**
   * When true, pipe the cloudflared child's stderr AND stdout to the parent
   * process's stderr so CLI users see the "open this URL in your browser"
   * prompt (some cloudflared builds emit it on stdout, others on stderr).
   * Never forwards to parent stdout — the CLI reserves stdout for --json
   * machine-readable output. Default false (test hermeticity + dashboard
   * flow that wraps output in notifications instead).
   */
  forwardOutput?: boolean;
  /** Test-only dependency injection seam. */
  dependencies?: { spawn?: SpawnFn };
}): Promise<CloudflaredLoginResult> {
  return new Promise<CloudflaredLoginResult>((resolve, reject) => {
    const binaryPath = options.binaryPath ?? getTunnelBinaryPath(options.configDir);
    try {
      assertBinaryExists(binaryPath);
    } catch (err) {
      reject(err as Error);
      return;
    }

    const certPath = options.certPath ?? defaultCertPath();
    // If a cert is already present at entry, the spawn + 250ms poll loop
    // would race: the first poll tick would see the existing cert and resolve
    // ok in ~300ms, killing cloudflared before it ever opened a browser. That
    // gave misleading "success" to callers who expected a fresh login flow
    // and also hid stale / wrong-account cert problems. runCloudflaredLogin
    // is strictly "perform a login flow"; idempotent "already configured"
    // belongs in the provider's isSetupComplete, not here.
    if (existsSync(certPath)) {
      reject(
        new Error(
          `cert already exists at ${certPath}; rename or delete it to re-run login.`,
        ),
      );
      return;
    }

    const spawnImpl = options.dependencies?.spawn ?? nodeSpawn;
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    const child = spawnImpl(binaryPath, ["tunnel", "login"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrChunks.push(text);
      if (options.forwardOutput) process.stderr.write(text);
    });
    // Some cloudflared builds emit the browse URL to stdout — capture both.
    // When forwarding, route stdout to PARENT STDERR (never parent stdout).
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrChunks.push(text);
      if (options.forwardOutput) process.stderr.write(text);
    });

    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let overallTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (overallTimer) clearTimeout(overallTimer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      killChild(child);
    };

    const resolveOk = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: true, certPath, stderr: stderrChunks.join("") });
    };

    const rejectWith = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      rejectWith(new Error("cloudflared login aborted by caller."));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        rejectWith(new Error("cloudflared login aborted by caller."));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    pollTimer = setInterval(() => {
      try {
        if (existsSync(certPath)) resolveOk();
      } catch {
        // ignore fs races; next tick will retry
      }
    }, CERT_POLL_INTERVAL_MS);

    overallTimer = setTimeout(() => {
      rejectWith(
        new Error(
          `cloudflared login timed out after ${Math.round(timeoutMs / 1000)}s — cert not written to ${certPath}.`,
        ),
      );
    }, timeoutMs);

    child.on("error", (err) => {
      rejectWith(new Error(`cloudflared login failed to start: ${err.message}`));
    });
    child.on("exit", () => {
      // If cert already present, resolve. Otherwise give the poller one more
      // chance before failing so we don't lose a race where exit fires before
      // the poll interval sees the file.
      if (settled) return;
      if (existsSync(certPath)) {
        resolveOk();
      }
      // Otherwise let the poll timer or overall timer handle completion.
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// cloudflared tunnel list
// ─────────────────────────────────────────────────────────────────────

/**
 * Runs `cloudflared tunnel list --output=json` and parses. Returns [] on
 * "no tunnels" (exit 0 + empty list). Throws on binary/cert problems.
 */
export function listNamedTunnels(options: {
  configDir: string;
  binaryPath?: string;
  dependencies?: { spawn?: SpawnFn };
}): Promise<NamedTunnelSummary[]> {
  return new Promise<NamedTunnelSummary[]>((resolve, reject) => {
    const binaryPath = options.binaryPath ?? getTunnelBinaryPath(options.configDir);
    try {
      assertBinaryExists(binaryPath);
    } catch (err) {
      reject(err as Error);
      return;
    }
    const spawnImpl = options.dependencies?.spawn ?? nodeSpawn;
    const child = spawnImpl(binaryPath, ["tunnel", "list", "--output=json"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));

    child.on("error", (err) => {
      reject(new Error(`cloudflared list failed to start: ${err.message}`));
    });
    child.on("exit", (code) => {
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      if (code !== 0) {
        reject(new Error(`cloudflared tunnel list exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const trimmed = stdout.trim();
      if (trimmed === "" || trimmed === "null") {
        resolve([]);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        reject(
          new Error(
            `cloudflared output not parseable: ${trimmed.slice(0, 200)}`,
          ),
        );
        return;
      }
      if (!Array.isArray(parsed)) {
        resolve([]);
        return;
      }
      const summaries: NamedTunnelSummary[] = parsed
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .map((entry) => {
          const id = typeof entry.id === "string" ? entry.id : "";
          const name = typeof entry.name === "string" ? entry.name : "";
          const createdAt = typeof entry.created_at === "string" ? entry.created_at : undefined;
          const connArr = Array.isArray(entry.connections) ? entry.connections : [];
          return { uuid: id, name, createdAt, connections: connArr.length };
        })
        .filter((entry) => entry.uuid.length > 0);
      resolve(summaries);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// cloudflared tunnel create + DNS route
// ─────────────────────────────────────────────────────────────────────

const CREATE_ID_REGEX = /Created tunnel\s+(\S+)\s+with id\s+([0-9a-f-]{8,})/i;
// Matches everything up to the end-of-line period cloudflared prints. Paths
// can contain dots, so we only strip a trailing `.` followed by whitespace /
// line end, not the first dot we see.
const CREDENTIALS_REGEX = /Tunnel credentials written to\s+(.+?)\.?(?:\r?\n|$)/i;

/**
 * Runs `cloudflared tunnel create <name>`, parses the UUID + credentials
 * path out of stdout, then runs `cloudflared tunnel route dns <uuid>
 * <hostname>` to install the CNAME record.
 */
export async function createNamedTunnel(options: {
  configDir: string;
  name: string;
  hostname: string;
  binaryPath?: string;
  signal?: AbortSignal;
  dependencies?: { spawn?: SpawnFn };
}): Promise<CreatedTunnel> {
  if (!options.name) throw new Error("createNamedTunnel: name is required.");
  if (!options.hostname) throw new Error("createNamedTunnel: hostname is required.");
  const binaryPath = options.binaryPath ?? getTunnelBinaryPath(options.configDir);
  assertBinaryExists(binaryPath);

  const spawnImpl = options.dependencies?.spawn ?? nodeSpawn;

  return runCapture(spawnImpl, binaryPath, ["tunnel", "create", options.name], options.signal)
    .then(({ code, stdout, stderr }) => {
      if (code !== 0) {
        throw new Error(
          `cloudflared tunnel create exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
        );
      }
      const idMatch = stdout.match(CREATE_ID_REGEX) ?? stderr.match(CREATE_ID_REGEX);
      if (!idMatch) {
        throw new Error(
          `cloudflared create output missing tunnel id line. Output: ${(stdout + stderr).slice(0, 400)}`,
        );
      }
      const credMatch = stdout.match(CREDENTIALS_REGEX) ?? stderr.match(CREDENTIALS_REGEX);
      if (!credMatch) {
        throw new Error(
          `cloudflared create output missing credentials path line. Output: ${(stdout + stderr).slice(0, 400)}`,
        );
      }
      const uuid = idMatch[2];
      const credentialsPath = credMatch[1].trim();
      const parsedName = idMatch[1];
      return { uuid, name: parsedName || options.name, credentialsPath };
    })
    .then(async (tunnel) => {
      const { code, stdout, stderr } = await runCapture(
        spawnImpl,
        binaryPath,
        ["tunnel", "route", "dns", tunnel.uuid, options.hostname],
        options.signal,
      );
      if (code !== 0) {
        throw new Error(
          `cloudflared route dns exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
        );
      }
      return tunnel;
    });
}

function runCapture(
  spawnImpl: SpawnFn,
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => stderr.push(chunk.toString("utf8")));

    const onAbort = () => killChild(child);
    if (signal) {
      if (signal.aborted) {
        killChild(child);
        reject(new Error("cloudflared command aborted by caller."));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(new Error(`cloudflared command failed to start: ${err.message}`));
    });
    child.on("exit", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Named-tunnel config.yml read/write
// ─────────────────────────────────────────────────────────────────────

export function getNamedTunnelConfigPath(configDir: string): string {
  return join(configDir, CONFIG_FILENAME);
}

/**
 * Writes `<configDir>/cloudflared-named.yml` describing the tunnel ->
 * localhost mapping. Uses the temp-file + rename pattern from ngrok-config.ts
 * and locks file mode to 0600 (POSIX) / user-only ACL (Windows).
 */
export function writeTunnelConfig(options: {
  configDir: string;
  uuid: string;
  hostname: string;
  port: number;
  credentialsPath: string;
}): NamedTunnelConfig {
  if (!options.uuid) throw new Error("writeTunnelConfig: uuid is required.");
  if (!options.hostname) throw new Error("writeTunnelConfig: hostname is required.");
  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error("writeTunnelConfig: port must be a positive number.");
  }
  if (!options.credentialsPath) {
    throw new Error("writeTunnelConfig: credentialsPath is required.");
  }

  const configPath = getNamedTunnelConfigPath(options.configDir);
  mkdirSync(dirname(configPath), { recursive: true });

  const yaml = serializeConfigYaml({
    uuid: options.uuid,
    hostname: options.hostname,
    port: options.port,
    credentialsPath: options.credentialsPath,
  });

  const tempPath = `${configPath}.tmp`;
  writeFileSync(tempPath, yaml, { encoding: "utf8", mode: 0o600 });
  rmSync(configPath, { force: true });
  renameSync(tempPath, configPath);
  applyPrivatePermissions(configPath);

  return {
    uuid: options.uuid,
    hostname: options.hostname,
    port: options.port,
    configPath,
    credentialsPath: options.credentialsPath,
  };
}

/**
 * Reads + validates the config written by writeTunnelConfig. Returns null
 * if absent or malformed.
 */
export function readNamedTunnelConfig(configDir: string): NamedTunnelConfig | null {
  const configPath = getNamedTunnelConfigPath(configDir);
  if (!existsSync(configPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  const parsed = parseConfigYaml(raw);
  if (!parsed) return null;
  return {
    uuid: parsed.uuid,
    hostname: parsed.hostname,
    port: parsed.port,
    credentialsPath: parsed.credentialsPath,
    configPath,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function assertBinaryExists(binaryPath: string): void {
  if (!existsSync(binaryPath)) {
    throw new Error(
      `cloudflared not installed; run "daemon install-tunnel" first (expected at ${binaryPath}).`,
    );
  }
}

function defaultCertPath(): string {
  return join(homedir(), ".cloudflared", "cert.pem");
}

function killChild(child: ChildProcess): void {
  if (!child || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // best-effort
  }
}

function serializeConfigYaml(opts: {
  uuid: string;
  hostname: string;
  port: number;
  credentialsPath: string;
}): string {
  // Simple, stable YAML — cloudflared's ingress format is well-defined and
  // our values are mechanically generated (UUIDs, paths, hostnames). Full
  // YAML escape rules aren't needed for this keyspace.
  return [
    `tunnel: ${opts.uuid}`,
    `credentials-file: ${yamlQuoteIfNeeded(opts.credentialsPath)}`,
    "ingress:",
    `  - hostname: ${opts.hostname}`,
    `    service: http://127.0.0.1:${opts.port}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
}

function yamlQuoteIfNeeded(value: string): string {
  // Quote paths containing spaces, colons, or leading/trailing whitespace
  // chars so cloudflared's YAML parser picks up the full string.
  if (/^[A-Za-z0-9._/\\:-]+$/u.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface ParsedConfig {
  uuid: string;
  hostname: string;
  port: number;
  credentialsPath: string;
}

function parseConfigYaml(raw: string): ParsedConfig | null {
  const lines = raw.split(/\r?\n/);
  let uuid = "";
  let credentialsPath = "";
  let hostname = "";
  let port = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const tunnelMatch = trimmed.match(/^tunnel:\s*(.+)$/u);
    if (tunnelMatch) {
      uuid = unquoteYaml(tunnelMatch[1].trim());
      continue;
    }
    const credsMatch = trimmed.match(/^credentials-file:\s*(.+)$/u);
    if (credsMatch) {
      credentialsPath = unquoteYaml(credsMatch[1].trim());
      continue;
    }
    const hostnameMatch = trimmed.match(/^- hostname:\s*(.+)$/u);
    if (hostnameMatch) {
      hostname = unquoteYaml(hostnameMatch[1].trim());
      continue;
    }
    const serviceMatch = trimmed.match(/^service:\s*http:\/\/127\.0\.0\.1:(\d+)\s*$/u);
    if (serviceMatch) {
      port = Number.parseInt(serviceMatch[1], 10);
      continue;
    }
  }
  if (!uuid || !hostname || !credentialsPath || !Number.isFinite(port) || port <= 0) {
    return null;
  }
  return { uuid, hostname, port, credentialsPath };
}

function unquoteYaml(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function applyPrivatePermissions(path: string): void {
  if (process.platform === "win32") {
    const username = process.env.USERNAME;
    const domain = process.env.USERDOMAIN;
    const target = domain && username ? `${domain}\\${username}` : username ?? "";
    if (!target) return;
    spawnSync("icacls", [path, "/inheritance:r", "/grant:r", `${target}:(R,W)`], {
      encoding: "utf8",
      windowsHide: true,
    });
    return;
  }
  chmodSync(path, 0o600);
}
