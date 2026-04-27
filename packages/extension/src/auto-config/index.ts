import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
  IDE_METADATA,
  MCP_TRANSPORT_DEFAULT,
  PERPLEXITY_MCP_SERVER_KEY,
  PERPLEXITY_RULES_SECTION_START,
  PERPLEXITY_RULES_SECTION_END,
  type IdeStatus,
  type IdeTarget,
  type McpTransportId,
  type RulesStatus
} from "@perplexity-user-mcp/shared";
import { checkLauncherHealth } from "../launcher/write-launcher.js";
import { validateCommand } from "../launcher/validate-command.js";
import {
  getTransportBuilder,
  StabilityGateError,
  type McpServerEntry,
} from "./transports/index.js";

interface McpConfigFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface IdeConfigOptions {
  target: IdeTarget;
  serverPath: string;
  chromePath?: string;
  configPath?: string;
  nodePath?: string;
  serverName?: string;
  // Phase 8.6.4: transport picker. `undefined` defaults to the workspace-wide
  // MCP_TRANSPORT_DEFAULT so callers pre-dating the picker keep working.
  transportId?: McpTransportId;
}

/**
 * Phase 8.6.4 dispatch dependencies. All fields optional — omitted defaults
 * are safe-for-tests (no real VS Code, no real git spawn, no prompts) so any
 * call site that passes `undefined` won't accidentally reach out to the host.
 */
export interface ApplyIdeConfigDeps {
  confirmTransport?: (args: {
    ideTag: IdeTarget;
    transportId: McpTransportId;
    configPath: string;
  }) => Promise<boolean>;
  warnSyncFolder?: (args: {
    configPath: string;
    matchedPattern: string;
  }) => Promise<"override" | "cancel">;
  nudgePortPin?: (args: { ideTag: IdeTarget }) => void;
  auditGenerated?: (entry: {
    ideTag: IdeTarget;
    transportId: McpTransportId;
    configPath: string;
    bearerKind: "none" | "local" | "static";
    resultCode:
      | "ok"
      | "rejected-unsupported"
      | "rejected-sync"
      | "rejected-tunnel-unstable"
      | "rejected-cancelled"
      | "rejected-port-unavailable"
      | "error";
    ts: string;
  }) => void;
  issueLocalToken?: (input: { ideTag: string; label: string }) => {
    token: string;
    metadata: { id: string };
  };
  /** Reads the daemon's static bearer token. Loopback-only use — tunnel paths never embed this. Default: throws "not provided". */
  getDaemonBearer?: () => Promise<string | null>;
  getDaemonPort?: () => number | null;
  getActiveTunnel?: () => {
    providerId: "cf-quick" | "ngrok" | "cf-named";
    url: string;
    reservedDomain: boolean;
  } | null;
  syncFolderPatterns?: readonly string[];
  homeDir?: () => string;
  isGitTracked?: (dir: string) => boolean;
}

export type ApplyIdeConfigResult =
  | {
      ok: true;
      path: string;
      bearerKind: "none" | "local" | "static";
      transportId: McpTransportId;
      warnings: string[];
    }
  | {
      ok: false;
      reason:
        | "unsupported"
        | "cancelled"
        | "sync-folder"
        | "tunnel-unstable"
        | "port-unavailable"
        | "error";
      message: string;
      transportId: McpTransportId;
    };

export function getIdeConfigPath(target: IdeTarget, options?: { homeDir?: string; platform?: NodeJS.Platform }): string {
  const home = options?.homeDir ?? homedir();
  const platform = options?.platform ?? process.platform;
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");

  switch (target) {
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "windsurf":
      return join(home, ".codeium", "windsurf", "mcp_config.json");
    case "windsurfNext":
      return join(home, ".codeium", "windsurf-next", "mcp_config.json");
    case "claudeDesktop":
      if (platform === "win32") return join(appData, "Claude", "claude_desktop_config.json");
      if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      return join(home, ".config", "Claude", "claude_desktop_config.json");
    case "claudeCode":
      return join(home, ".claude.json");
    case "cline":
      return join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    case "amp":
      if (platform === "win32") return join(appData, "amp", "settings.json");
      return join(home, ".config", "amp", "settings.json");
    case "rooCode":
      return join(home, ".roo", "mcp.json");
    case "codexCli":
      return join(home, ".codex", "config.toml");
    case "continueDev":
      return join(home, ".continue", "config.yaml");
    case "copilot":
      return join(home, ".github", "copilot-instructions.md");
    case "zed":
      if (platform === "darwin") return join(home, "Library", "Application Support", "Zed", "settings.json");
      return join(home, ".local", "share", "zed", "settings.json");
    case "geminiCli":
      return join(home, ".gemini", "settings.json");
    case "aider":
      return join(home, ".aider.conf.yml");
    case "augment":
      return join(home, ".augment", "rules");
  }
}

/**
 * Resolve a working Node.js executable path.
 * In VSCode/Windsurf extension host, `process.execPath` returns the IDE binary
 * (e.g. "Windsurf - Next.exe"), NOT node. We need to find actual node.
 *
 * Exported so the staleness auto-regen path in `regenerateStaleIdes` can reuse
 * the same resolution rules without duplicating the candidate ladder.
 */
export function resolveNodePath(): string {
  const log = (msg: string) => { try { console.error(`[resolveNodePath] ${msg}`); } catch {} };

  log(`process.execPath = ${process.execPath}`);
  log(`process.platform = ${process.platform}`);
  log(`PROGRAMFILES = ${process.env.PROGRAMFILES}`);

  // 1. Explicit override
  if (process.env.PERPLEXITY_NODE_PATH && existsSync(process.env.PERPLEXITY_NODE_PATH)) {
    log(`Using PERPLEXITY_NODE_PATH: ${process.env.PERPLEXITY_NODE_PATH}`);
    return process.env.PERPLEXITY_NODE_PATH;
  }

  // 2. Check if process.execPath is actually node (standalone MCP usage)
  const execName = process.execPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  log(`execName = ${execName}`);
  if (execName.startsWith("node")) {
    log(`process.execPath is node: ${process.execPath}`);
    return process.execPath;
  }

  // 3. Well-known node locations
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const pf = process.env.PROGRAMFILES ?? "C:\\Program Files";
    candidates.push(
      join(pf, "nodejs", "node.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "node.exe"),
      join(process.env.APPDATA ?? "", "nvm", "current", "node.exe"),
    );
  } else {
    candidates.push(
      "/usr/local/bin/node",
      "/usr/bin/node",
      join(homedir(), ".nvm", "current", "bin", "node"),
    );
  }

  for (const p of candidates) {
    const found = existsSync(p);
    log(`Checking ${p} → ${found}`);
    if (p && found) return p;
  }

  // 4. Fallback — just "node" and hope it's on PATH
  log("Falling back to bare 'node'");
  return "node";
}

export function buildServerConfig(serverPath: string, options?: { nodePath?: string; chromePath?: string }): Record<string, unknown> {
  const env: Record<string, string> = {
    PERPLEXITY_HEADLESS_ONLY: "1"
  };

  if (options?.chromePath) {
    env.PERPLEXITY_CHROME_PATH = options.chromePath;
  }

  return {
    command: options?.nodePath ?? resolveNodePath(),
    args: [serverPath],
    env
  };
}

export function mergeMcpConfig(
  existingConfig: unknown,
  serverName: string,
  serverConfig: Record<string, unknown>
): McpConfigFile {
  const safeExisting =
    existingConfig && typeof existingConfig === "object" && !Array.isArray(existingConfig)
      ? (existingConfig as McpConfigFile)
      : {};

  const existingServers =
    safeExisting.mcpServers && typeof safeExisting.mcpServers === "object" && !Array.isArray(safeExisting.mcpServers)
      ? safeExisting.mcpServers
      : {};

  return {
    ...safeExisting,
    mcpServers: {
      ...existingServers,
      [serverName]: serverConfig
    }
  };
}

export function removeMcpEntry(
  existingConfig: unknown,
  serverName: string
): McpConfigFile {
  const safeExisting =
    existingConfig && typeof existingConfig === "object" && !Array.isArray(existingConfig)
      ? (existingConfig as McpConfigFile)
      : {};

  const existingServers =
    safeExisting.mcpServers && typeof safeExisting.mcpServers === "object" && !Array.isArray(safeExisting.mcpServers)
      ? { ...safeExisting.mcpServers }
      : {};

  delete existingServers[serverName];

  return {
    ...safeExisting,
    mcpServers: existingServers
  };
}

function readExistingConfig(configPath: string): McpConfigFile {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as McpConfigFile;
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${(error as Error).message}`);
  }
}

/* ─── Minimal TOML helpers for Codex CLI config ─── */

function readTomlFile(configPath: string): string {
  if (!existsSync(configPath)) return "";
  return readFileSync(configPath, "utf8");
}

function tomlHasMcpServer(toml: string, serverName: string): boolean {
  return extractTomlMcpServerBlock(toml, serverName) !== null;
}

function extractTomlMcpServerBlock(toml: string, serverName: string): string | null {
  const sectionHeader = `[mcp_servers.${serverName}]`;
  const startIdx = toml.indexOf(sectionHeader);
  if (startIdx === -1) return null;

  const afterHeader = startIdx + sectionHeader.length;
  const remaining = toml.slice(afterHeader);
  const lines = remaining.split("\n");
  let endOffset = remaining.length;
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("[") &&
      trimmed.endsWith("]") &&
      !trimmed.startsWith(`[mcp_servers.${serverName}.`)
    ) {
      endOffset = offset;
      break;
    }
    offset += line.length + 1;
  }

  return remaining.slice(0, endOffset);
}

function buildTomlMcpBlock(serverName: string, serverConfig: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${serverName}]`);

  if (typeof serverConfig.url === "string") {
    lines.push(`url = ${JSON.stringify(serverConfig.url)}`);
    const bearer = extractBearerToken(serverConfig.headers);
    const envVarName = `${serverName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MCP_BEARER`;
    if (bearer) {
      lines.push(`bearer_token_env_var = ${JSON.stringify(envVarName)}`);
    }
    lines.push(`enabled = true`);
    if (bearer) {
      lines.push("");
      lines.push(`[mcp_servers.${serverName}.env_http_headers]`);
      lines.push(`${envVarName} = ${JSON.stringify(bearer)}`);
    }
    return lines.join("\n");
  }

  lines.push(`command = ${JSON.stringify(serverConfig.command)}`);

  const args = serverConfig.args as string[] | undefined;
  if (args?.length) {
    lines.push(`args = [${args.map(a => JSON.stringify(a)).join(", ")}]`);
  }

  lines.push(`enabled = true`);

  const env = serverConfig.env as Record<string, string> | undefined;
  if (env && Object.keys(env).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${serverName}.env]`);
    for (const [k, v] of Object.entries(env)) {
      lines.push(`${k} = ${JSON.stringify(v)}`);
    }
  }

  return lines.join("\n");
}

function extractBearerToken(headers: unknown): string | null {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return null;
  }
  const authorization = (headers as Record<string, unknown>).Authorization;
  if (typeof authorization !== "string") {
    return null;
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function mergeTomlMcpServer(
  toml: string,
  serverName: string,
  serverConfig: Record<string, unknown>,
): string {
  const block = buildTomlMcpBlock(serverName, serverConfig);

  if (tomlHasMcpServer(toml, serverName)) {
    // Replace existing block: find [mcp_servers.<name>] and replace up to next [section] or EOF
    const sectionHeader = `[mcp_servers.${serverName}]`;
    const envHeader = `[mcp_servers.${serverName}.env]`;
    const startIdx = toml.indexOf(sectionHeader);
    if (startIdx === -1) return toml + "\n\n" + block + "\n";

    // Find the end: next top-level section that isn't our .env sub-section
    let endIdx = toml.length;
    const searchFrom = startIdx + sectionHeader.length;
    const nextSectionRegex = /^\[(?!mcp_servers\.\S+\.env\b)/m;
    // Find all [...] headers after our section
    const remaining = toml.slice(searchFrom);
    const lines = remaining.split("\n");
    let offset = searchFrom;
    let passedEnv = false;
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed === envHeader) {
        passedEnv = true;
        offset += line.length + 1;
        continue;
      }
      if (trimmed.startsWith("[") && !trimmed.startsWith(`[mcp_servers.${serverName}`)) {
        endIdx = offset;
        break;
      }
      offset += line.length + 1;
    }

    const before = toml.slice(0, startIdx).trimEnd();
    const after = toml.slice(endIdx).trimStart();
    return (before ? before + "\n\n" : "") + block + "\n" + (after ? "\n" + after : "");
  }

  // Append new block
  const trimmed = toml.trimEnd();
  return (trimmed ? trimmed + "\n\n" : "") + block + "\n";
}

function removeTomlMcpServer(toml: string, serverName: string): string {
  if (!tomlHasMcpServer(toml, serverName)) return toml;

  const sectionHeader = `[mcp_servers.${serverName}]`;
  const startIdx = toml.indexOf(sectionHeader);
  if (startIdx === -1) return toml;

  // Find end of this server's block
  const searchFrom = startIdx + sectionHeader.length;
  const remaining = toml.slice(searchFrom);
  const lines = remaining.split("\n");
  let offset = searchFrom;
  let endIdx = toml.length;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("[") && !trimmed.startsWith(`[mcp_servers.${serverName}`)) {
      endIdx = offset;
      break;
    }
    offset += line.length + 1;
  }

  const before = toml.slice(0, startIdx).trimEnd();
  const after = toml.slice(endIdx).trimStart();
  return (before ? before + "\n" : "") + (after ? "\n" + after : "");
}

function writeJsonAtomic(configPath: string, data: McpConfigFile): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp`;
  // H3 invariant: the tempfile may transiently contain a bearer token during
  // http-loopback bearer-kind writes. `writeFileSync`'s default mode is 0o666
  // minus umask (typically 0o644, world-readable) — unacceptable for secrets.
  // Match `writeTextAtomic` and the `.bak` hygiene: open at 0o600 on POSIX,
  // then run `applyPrivatePermissions` (chmod/icacls) BEFORE the rename so the
  // target inherits the hardened ACL.
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  applyPrivatePermissions(tempPath);
  renameSync(tempPath, configPath);
}

/**
 * Phase 8.6.4 dispatch pipeline. The pre-phase applyIdeConfig synchronously
 * merged a fixed stdio server entry; this version routes through the transport
 * registry with H3–H8 security prechecks (capability gate, sync-folder detection,
 * confirmation modal, port-pin nudge, sanitized .bak, audit sink). Callers that
 * used the v1 sync signature must migrate to `await`; tests silently accept
 * via the injectable `deps` defaults.
 */
export async function applyIdeConfig(
  options: IdeConfigOptions,
  deps: ApplyIdeConfigDeps = {}
): Promise<ApplyIdeConfigResult> {
  const target = options.target;
  const transportId: McpTransportId = options.transportId ?? MCP_TRANSPORT_DEFAULT;
  const meta = IDE_METADATA[target];
  const configPath = options.configPath ?? getIdeConfigPath(target);
  const serverName = options.serverName ?? PERPLEXITY_MCP_SERVER_KEY;
  const homeDir = deps.homeDir ?? (() => homedir());
  const auditSink = deps.auditGenerated ?? (() => {});
  const confirm = deps.confirmTransport ?? (async () => true);
  const warnSync = deps.warnSyncFolder ?? (async () => "cancel" as const);
  const nudgePort = deps.nudgePortPin ?? (() => {});
  const getDaemonPort = deps.getDaemonPort ?? (() => null);
  const getActiveTunnel = deps.getActiveTunnel ?? (() => null);
  const syncFolderPatterns = deps.syncFolderPatterns ?? [];
  const isGitTracked = deps.isGitTracked ?? defaultIsGitTracked;
  const issueLocalToken = deps.issueLocalToken ?? defaultIssueLocalToken;

  const audit = (
    resultCode: Parameters<NonNullable<ApplyIdeConfigDeps["auditGenerated"]>>[0]["resultCode"],
    bearerKind: "none" | "local" | "static"
  ): void => {
    auditSink({
      ideTag: target,
      transportId,
      configPath: redactHome(configPath, homeDir()),
      bearerKind,
      resultCode,
      ts: new Date().toISOString(),
    });
  };

  if (!meta) {
    const message = `Unknown IDE target "${target}".`;
    audit("rejected-unsupported", "none");
    return { ok: false, reason: "unsupported", message, transportId };
  }

  // H3 guard — legacy callers relied on `autoConfigurable` as a whole-IDE gate.
  // Keep respecting it: if the IDE isn't auto-configurable at all, refuse.
  if (!meta.autoConfigurable) {
    const message = `${meta.displayName} does not support automatic MCP configuration.`;
    audit("rejected-unsupported", "none");
    return { ok: false, reason: "unsupported", message, transportId };
  }

  // H3 — capability gate. Each transport maps to one or more capability flags.
  // No flag is ever flipped `true` without smoke evidence (see shared/constants.ts).
  const caps = meta.capabilities;
  const capabilityOk =
    transportId === "stdio-in-process" || transportId === "stdio-daemon-proxy"
      ? caps.stdio
      : transportId === "http-loopback"
        ? caps.httpOAuthLoopback || caps.httpBearerLoopback
        : transportId === "http-tunnel"
          ? caps.httpOAuthTunnel
          : false;
  if (!capabilityOk) {
    const message =
      `${meta.displayName} does not support transport ${transportId}. ` +
      `Enable the capability in constants.ts (requires smoke evidence).`;
    audit("rejected-unsupported", "none");
    return { ok: false, reason: "unsupported", message, transportId };
  }

  // Format gate. Builders declare which native config formats they can emit;
  // http-loopback supports JSON clients and Codex's streamable-HTTP TOML shape.
  const builder = getTransportBuilder(transportId);
  const configFormat = meta.configFormat;
  if (configFormat !== "json" && configFormat !== "toml") {
    // Non-JSON/TOML formats (yaml, ui-only) are outside 8.6.4 scope.
    const message = `${meta.displayName} config format "${configFormat}" is not supported by transport ${transportId}.`;
    audit("rejected-unsupported", "none");
    return { ok: false, reason: "unsupported", message, transportId };
  }
  if (!builder.supportedFormats.includes(configFormat)) {
    const message = `Transport ${transportId} cannot emit ${configFormat} (supported: ${builder.supportedFormats.join(", ")}).`;
    audit("rejected-unsupported", "none");
    return { ok: false, reason: "unsupported", message, transportId };
  }

  // Decide bearer fate BEFORE any prompt so the sync-folder warning below
  // can accurately skip for the no-secret-written paths.
  //
  // Priority order for http-loopback:
  //   1. httpOAuthLoopback → "none" (OAuth variant; no IDE has this flag yet,
  //      but the branch stays so a future evidence-gated flip lights up cleanly).
  //   2. httpBearerLoopback → "static" (v0.8.4 pragmatic default — embeds the
  //      daemon's shared static bearer; accepted on loopback by the daemon).
  //   3. fallback → "local" (per-IDE scoped; primitives stay for future flip).
  const bearerKind: "none" | "local" | "static" =
    transportId === "http-loopback"
      ? caps.httpOAuthLoopback
        ? "none"
        : caps.httpBearerLoopback
          ? "static"
          : "local"
      : "none";

  // H4 — sync-folder detection. Only http-loopback with a secret-bearing bearer
  // kind actually writes a secret to disk; stdio stores no secret at all, and
  // http-tunnel intentionally refuses to bake a bearer into a public-URL config.
  const syncFolderApplies =
    transportId === "http-loopback" &&
    (bearerKind === "local" || bearerKind === "static");
  if (syncFolderApplies) {
    const match = detectSyncFolder(
      configPath,
      syncFolderPatterns,
      isGitTracked
    );
    if (match) {
      const decision = await warnSync({
        configPath,
        matchedPattern: match,
      });
      if (decision === "cancel") {
        audit("rejected-sync", bearerKind);
        return {
          ok: false,
          reason: "sync-folder",
          message: `Config path is inside a sync folder (${match}). Writing a bearer here would propagate the secret. Cancelled.`,
          transportId,
        };
      }
    }
  }

  // H5 — first-time confirmation modal. Default accepts in tests; caller in
  // extension.ts wires the real VS Code prompt and remembers per-pair acceptance.
  const accepted = await confirm({
    ideTag: target,
    transportId,
    configPath,
  });
  if (!accepted) {
    audit("rejected-cancelled", bearerKind);
    return {
      ok: false,
      reason: "cancelled",
      message: "User cancelled the transport confirmation.",
      transportId,
    };
  }

  // H6 — port-pin nudge. The caller uses workspace state to only call this
  // once per session; here we only fire when the builder is actually going to
  // bake the port into a config and the port is ephemeral (0 ⇒ OS-assigned).
  if (transportId === "http-loopback" && getDaemonPort() === 0) {
    try {
      nudgePort({ ideTag: target });
    } catch {
      // Non-blocking by contract. Ignore handler failures.
    }
  }

  // Issue the local token AFTER confirmation (don't mint a secret we may throw
  // away) and BEFORE the builder runs (builder needs the token in its input).
  let localToken: string | undefined;
  let staticBearer: string | undefined;
  if (bearerKind === "local") {
    try {
      const result = issueLocalToken({
        ideTag: target,
        label: meta.displayName,
      });
      localToken = result.token;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit("error", bearerKind);
      return {
        ok: false,
        reason: "error",
        message,
        transportId,
      };
    }
  }
  if (bearerKind === "static") {
    try {
      const bearer = await (deps.getDaemonBearer?.() ?? Promise.reject(new Error("getDaemonBearer not provided")));
      if (!bearer) {
        audit("error", bearerKind);
        return {
          ok: false,
          reason: "error",
          message: "Daemon bearer unavailable — start the daemon first.",
          transportId,
        };
      }
      staticBearer = bearer;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit("error", bearerKind);
      return {
        ok: false,
        reason: "error",
        message,
        transportId,
      };
    }
  }

  const activeTunnel = getActiveTunnel();

  let entry: McpServerEntry;
  try {
    entry = builder.build({
      launcherPath: options.serverPath,
      daemonPort: getDaemonPort() ?? null,
      tunnelUrl: activeTunnel?.url ?? null,
      tunnelProviderId: activeTunnel?.providerId ?? null,
      tunnelReservedDomain: activeTunnel?.reservedDomain ?? false,
      bearerKind,
      ...(localToken !== undefined ? { localToken } : {}),
      ...(staticBearer !== undefined ? { staticBearer } : {}),
      ...(options.chromePath !== undefined ? { chromePath: options.chromePath } : {}),
      ...(options.nodePath !== undefined ? { nodePath: options.nodePath } : {}),
    });
  } catch (err) {
    if (err instanceof StabilityGateError) {
      audit("rejected-tunnel-unstable", bearerKind);
      return {
        ok: false,
        reason: "tunnel-unstable",
        message: err.reason,
        transportId,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    audit("error", bearerKind);
    return { ok: false, reason: "error", message, transportId };
  }

  // H3 — sanitized .bak + atomic write.
  const hadExisting = existsSync(configPath);
  let bakPath: string | null = null;
  if (hadExisting) {
    bakPath = `${configPath}.bak`;
    try {
      const raw = readFileSync(configPath, "utf8");
      const sanitized = sanitizeConfigForBackup(raw, configFormat);
      writeFileSync(bakPath, sanitized, { encoding: "utf8", mode: 0o600 });
      applyPrivatePermissions(bakPath);
    } catch (err) {
      // If we can't even read the existing file, surface a structured error
      // rather than silently clobbering it.
      const message = err instanceof Error ? err.message : String(err);
      audit("error", bearerKind);
      return { ok: false, reason: "error", message, transportId };
    }
  }

  try {
    if (configFormat === "toml") {
      const existing = readTomlFile(configPath);
      const merged = mergeTomlMcpServer(
        existing,
        serverName,
        entry as Record<string, unknown>
      );
      writeTextAtomic(configPath, merged);
    } else {
      const existingConfig = readExistingConfig(configPath);
      const mergedConfig = mergeMcpConfig(
        existingConfig,
        serverName,
        entry as Record<string, unknown>
      );
      writeJsonAtomic(configPath, mergedConfig);
    }
  } catch (err) {
    // H3 rollback — restore the sanitized .bak over target then remove it.
    if (bakPath && existsSync(bakPath)) {
      try {
        copyFileSync(bakPath, configPath);
        rmSync(bakPath, { force: true });
      } catch {
        // Best-effort rollback; surface the original error.
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    audit("error", bearerKind);
    return { ok: false, reason: "error", message, transportId };
  }

  // Success — clean up .bak. A stale .bak on disk is a weaker redaction target
  // than a freshly-written one; deleting keeps the blast radius minimal.
  if (bakPath && existsSync(bakPath)) {
    try {
      rmSync(bakPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  audit("ok", bearerKind);
  return {
    ok: true,
    path: configPath,
    bearerKind,
    transportId,
    warnings: [],
  };
}

function redactHome(p: string, home: string): string {
  if (!home) return p;
  // Case-sensitive normalize on POSIX; case-insensitive on Windows where
  // file paths are not case-sensitive in practice.
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const normP = norm(p);
  const normHome = norm(home);
  if (normP === normHome) return "~";
  if (normP.startsWith(normHome + "/") || normP.startsWith(normHome + "\\")) {
    return "~" + p.slice(home.length);
  }
  return p;
}

const SYNC_FOLDER_BUILTIN = /^(icloud|onedrive|dropbox|google\s*drive|syncthing|pcloud)/i;

function detectSyncFolder(
  configPath: string,
  userPatterns: readonly string[],
  isGitTracked: (dir: string) => boolean
): string | null {
  // Walk ancestor directory names for the built-in sync-folder name list.
  const parts = configPath.split(/[\\/]/).filter((s) => s.length > 0);
  for (const part of parts) {
    if (SYNC_FOLDER_BUILTIN.test(part)) {
      const m = part.match(SYNC_FOLDER_BUILTIN);
      return m ? normalizeMatch(m[0]) : part;
    }
  }

  // Git-tracked check — only the containing directory, not the whole tree.
  try {
    const parent = dirname(configPath);
    if (isGitTracked(parent)) {
      return "git-tracked";
    }
  } catch {
    // Never let git detection failures leak through as a false positive.
  }

  // User-supplied regex patterns. Invalid regexes are ignored silently — the
  // settings UI may predate validation, and a broken pattern shouldn't DOS the
  // entire config-generate flow.
  for (const raw of userPatterns) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    let re: RegExp;
    try {
      re = new RegExp(raw, "i");
    } catch {
      continue;
    }
    if (re.test(configPath)) {
      return raw;
    }
  }

  return null;
}

function normalizeMatch(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t.startsWith("icloud")) return "iCloud";
  if (t.startsWith("onedrive")) return "OneDrive";
  if (t.startsWith("dropbox")) return "Dropbox";
  if (t.startsWith("google")) return "Google Drive";
  if (t.startsWith("syncthing")) return "Syncthing";
  if (t.startsWith("pcloud")) return "pCloud";
  return raw;
}

// Keys redacted case-insensitively anywhere in the tree. "Authorization" is
// separate from "bearerToken"/"token" because some clients write it nested
// under `headers`; the scanner visits both shapes.
const REDACT_KEYS = new Set(["bearertoken", "token", "secret", "authorization"]);
const LOCAL_TOKEN_RE = /^pplx_(local|at|rt|ac)_/;

function sanitizeConfigForBackup(raw: string, format: "json" | "toml"): string {
  if (format === "json") {
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(redactTree(parsed), null, 2) + "\n";
    } catch {
      // If existing file was non-JSON garbage, write a regex-scrubbed copy so
      // we never persist a plaintext bearer in the .bak even on malformed input.
      return scrubTextBearer(raw);
    }
  }
  // TOML — regex-scrub. We don't round-trip-parse TOML here.
  return scrubTextBearer(raw);
}

function scrubTextBearer(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, "Bearer <redacted>")
    .replace(/pplx_(local|at|rt|ac)_[A-Za-z0-9_\-]+/g, "<redacted>");
}

function redactTree(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactTree);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k.toLowerCase())) {
        out[k] = "<redacted>";
        continue;
      }
      out[k] = redactTree(v);
    }
    return out;
  }
  if (typeof value === "string") {
    if (LOCAL_TOKEN_RE.test(value) || /\bBearer\s+/i.test(value)) {
      return "<redacted>";
    }
  }
  return value;
}

function writeTextAtomic(configPath: string, data: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp`;
  // H3 invariant: harden the tempfile identically to `writeJsonAtomic` — the
  // mode bit covers POSIX; `applyPrivatePermissions` adds the Windows icacls
  // lockdown before the rename so the final config inherits the ACL.
  writeFileSync(tempPath, data, { encoding: "utf8", mode: 0o600 });
  applyPrivatePermissions(tempPath);
  renameSync(tempPath, configPath);
}

// Inlined from daemon/local-tokens.ts / daemon/token.ts — see 8.6.1 note:
// both security-critical files duplicate this helper so a future refactor of
// one can never silently weaken the other.
function applyPrivatePermissions(path: string): void {
  if (process.platform === "win32") {
    restrictWindowsAcl(path);
    return;
  }
  chmodSync(path, 0o600);
}

function restrictWindowsAcl(path: string): void {
  const username = getWindowsUserName();
  if (!username) return;
  const grantTarget = `${username}:(R,W)`;
  spawnSync("icacls", [path, "/inheritance:r", "/grant:r", grantTarget], {
    encoding: "utf8",
    windowsHide: true,
  });
  // Best-effort: we don't fail the whole apply on icacls failure. The file is
  // already written atomically; ACL is belt-and-suspenders for .bak only.
}

function getWindowsUserName(): string | null {
  const username = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  if (domain && username) return `${domain}\\${username}`;
  if (username) return username;
  return null;
}

function defaultIsGitTracked(dir: string): boolean {
  // Silent failure on any error — git may be missing, the directory may not
  // exist, or it may not be a repo. None of those are sync-folder signals.
  try {
    const result = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 500,
      windowsHide: true,
    });
    return result.status === 0 && typeof result.stdout === "string" && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// The default tries a dynamic import of the shared daemon entry. Because
// `issueLocalToken` may not be re-exported on every build, the caller in
// extension.ts is expected to inject a concrete `deps.issueLocalToken`.
// Keep this synchronous: `await` would force every applyIdeConfig call to
// pay the cost of an import even when bearerKind is "none".
function defaultIssueLocalToken(_input: { ideTag: string; label: string }): {
  token: string;
  metadata: { id: string };
} {
  // The only path that reaches this is when caps.httpBearerLoopback === true.
  // As of 8.6.4 no IDE has that flag set, so the error here is a safety net
  // for future capability-flag flips that forget to inject the real helper.
  throw new Error(
    "issueLocalToken helper not injected — pass deps.issueLocalToken or do not select http-loopback bearer fallback."
  );
}

// Sep is imported for potential future cross-platform path normalizers. A
// static reference keeps the import from being tree-shaken by the bundler.
void sep;

export function removeIdeConfig(target: IdeTarget, options?: { configPath?: string; serverName?: string }): void {
  const meta = IDE_METADATA[target];
  if (!meta?.autoConfigurable) return;

  const configPath = options?.configPath ?? getIdeConfigPath(target);
  const serverName = options?.serverName ?? PERPLEXITY_MCP_SERVER_KEY;

  if (!existsSync(configPath)) return;

  // H3 parity with applyIdeConfig: sanitize the .bak (redact bearers), harden
  // the permissions (0o600 + icacls), and delete it on success. A permanent
  // `.bak` written via raw `copyFileSync` would preserve a plaintext bearer on
  // disk forever — the pre-8.6.4 pattern that this branch eliminates.
  const configFormat: "json" | "toml" = meta.configFormat === "toml" ? "toml" : "json";
  const bakPath = `${configPath}.bak`;
  try {
    const raw = readFileSync(configPath, "utf8");
    const sanitized = sanitizeConfigForBackup(raw, configFormat);
    writeFileSync(bakPath, sanitized, { encoding: "utf8", mode: 0o600 });
    applyPrivatePermissions(bakPath);
  } catch {
    // If we can't read the existing file, don't proceed with a destructive
    // remove — leave the config untouched. Mirrors applyIdeConfig's fail-closed
    // stance on pre-write hazards.
    return;
  }

  try {
    if (configFormat === "toml") {
      const existing = readTomlFile(configPath);
      const cleaned = removeTomlMcpServer(existing, serverName);
      writeTextAtomic(configPath, cleaned);
    } else {
      const existingConfig = readExistingConfig(configPath);
      const cleaned = removeMcpEntry(existingConfig, serverName);
      writeJsonAtomic(configPath, cleaned);
    }
  } catch {
    // Rollback: restore the sanitized .bak over the target, then delete .bak.
    // The restored content is redacted (not the plaintext original); callers
    // that need the plaintext should re-apply, not inspect .bak.
    if (existsSync(bakPath)) {
      try {
        copyFileSync(bakPath, configPath);
      } catch {
        // Best-effort; surface nothing — removeIdeConfig is a void API.
      }
      try {
        rmSync(bakPath, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    return;
  }

  // Success — delete the sanitized .bak so no redacted artifact lingers.
  if (existsSync(bakPath)) {
    try {
      rmSync(bakPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

export function detectIdeStatus(
  target: IdeTarget,
  options?: { configPath?: string; serverName?: string }
): IdeStatus {
  const meta = IDE_METADATA[target];
  if (!meta) {
    return {
      detected: false,
      configured: false,
      health: "missing" as const,
      path: "",
      displayName: target,
      autoConfigurable: false,
      configFormat: "json"
    };
  }

  const configPath = options?.configPath ?? getIdeConfigPath(target);
  const serverName = options?.serverName ?? PERPLEXITY_MCP_SERVER_KEY;
  const detected = existsSync(dirname(configPath)) || existsSync(configPath);

  const base: IdeStatus = {
    detected,
    configured: false,
    health: "missing",
    path: configPath,
    displayName: meta.displayName,
    autoConfigurable: meta.autoConfigurable,
    configFormat: meta.configFormat
  };

  if (!existsSync(configPath)) {
    return base;
  }

  try {
    let configured = false;
    let configuredArgs: string[] = [];
    let configuredCommand: string | undefined;
    let configuredUrl: string | undefined;

    if (meta.configFormat === "toml") {
      const toml = readFileSync(configPath, "utf8");
      configured = tomlHasMcpServer(toml, serverName);
      if (configured) {
        // Extract args/command/url only from this server's TOML table. A URL
        // transport has no command field and must not inherit another server's
        // command when the config contains multiple MCP entries.
        const serverBlock = extractTomlMcpServerBlock(toml, serverName) ?? "";
        const argsMatch = serverBlock.match(/args\s*=\s*\[([^\]]*)\]/);
        if (argsMatch) {
          const argsStr = argsMatch[1];
          const argValues = [...argsStr.matchAll(/"([^"]*)"/g)].map(m => m[1]);
          configuredArgs = argValues;
        }
        const commandMatch = serverBlock.match(/command\s*=\s*"((?:[^"\\]|\\.)*)"/);
        if (commandMatch) {
          // Unescape the simple JSON-style escapes our `buildTomlMcpBlock`
          // emits via JSON.stringify (\\, \", \n, \t etc.). `JSON.parse`
          // gives us back the literal string the file holds.
          try {
            configuredCommand = JSON.parse(`"${commandMatch[1]}"`) as string;
          } catch {
            configuredCommand = commandMatch[1];
          }
        }
        const urlMatch = serverBlock.match(/url\s*=\s*"((?:[^"\\]|\\.)*)"/);
        if (urlMatch) {
          try {
            configuredUrl = JSON.parse(`"${urlMatch[1]}"`) as string;
          } catch {
            configuredUrl = urlMatch[1];
          }
        }
      }
    } else if (meta.configFormat === "json") {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as McpConfigFile;
      configured =
        !!config.mcpServers &&
        typeof config.mcpServers === "object" &&
        !Array.isArray(config.mcpServers) &&
        Object.prototype.hasOwnProperty.call(config.mcpServers, serverName);
      if (configured && config.mcpServers) {
        const serverEntry = config.mcpServers[serverName] as
          | { args?: string[]; command?: string }
          | undefined;
        if (serverEntry?.args && Array.isArray(serverEntry.args)) {
          configuredArgs = serverEntry.args;
        }
        if (typeof serverEntry?.command === "string") {
          configuredCommand = serverEntry.command;
        }
        if (typeof (serverEntry as { url?: unknown } | undefined)?.url === "string") {
          configuredUrl = (serverEntry as { url: string }).url;
        }
      }
    }

    // Order of evaluation (docs/release-process note): a stale-args path
    // (the launcher script doesn't exist) is more urgent than a bad-command
    // warning (the runtime path is wrong). Stale wins so the doctor message
    // surfaces the higher-impact problem first.
    const health: IdeStatus["health"] = configured
      ? configuredUrl
        ? "configured"
        : checkLauncherHealth(configuredArgs)
      : "missing";

    const commandHealth = configured
      ? configuredUrl
        ? undefined
        : validateCommand(configuredCommand)
      : undefined;

    return {
      ...base,
      configured,
      health,
      ...(configuredCommand !== undefined ? { command: configuredCommand } : {}),
      ...(commandHealth !== undefined ? { commandHealth } : {}),
      lastConfiguredAt: statSync(configPath).mtime.toISOString()
    };
  } catch {
    return base;
  }
}

export function getIdeStatuses(_serverPath: string, _chromePath?: string): Record<string, IdeStatus> {
  const result: Record<string, IdeStatus> = {};
  for (const key of Object.keys(IDE_METADATA)) {
    result[key] = detectIdeStatus(key as IdeTarget);
  }
  return result;
}

const AUTO_CONFIGURABLE_IDES: IdeTarget[] = [
  "cursor", "windsurf", "windsurfNext", "claudeDesktop", "claudeCode", "codexCli", "cline", "amp"
];

export interface ConfigureTargetsOptions {
  transportByIde?: Partial<Record<IdeTarget, McpTransportId>>;
  deps?: ApplyIdeConfigDeps;
  nodePath?: string;
}

export async function configureTargets(
  target: IdeTarget | "all",
  serverPath: string,
  chromePath?: string,
  options?: ConfigureTargetsOptions
): Promise<{
  statuses: Record<string, IdeStatus>;
  results: Array<{ target: IdeTarget; result: ApplyIdeConfigResult }>;
}> {
  const targets: IdeTarget[] = target === "all"
    ? AUTO_CONFIGURABLE_IDES
    : [target];

  const transportByIde = options?.transportByIde ?? {};
  const deps = options?.deps;
  // Resolve a real Node binary once. The stdio transport builders fall back to
  // `process.execPath` when no nodePath is supplied, but inside the VS Code
  // extension host that's the Electron binary (e.g. `/usr/share/code/code`),
  // which produces a non-functional `command` field. An explicit caller-supplied
  // `options.nodePath` still wins so future code paths can pin a specific
  // interpreter (e.g. native-deps detection).
  const nodePath = options?.nodePath ?? resolveNodePath();
  const results: Array<{ target: IdeTarget; result: ApplyIdeConfigResult }> = [];

  for (const item of targets) {
    const meta = IDE_METADATA[item];
    if (!meta?.autoConfigurable) continue;
    try {
      const transportId = transportByIde[item] ?? MCP_TRANSPORT_DEFAULT;
      const result = await applyIdeConfig(
        {
          target: item,
          serverPath,
          ...(chromePath !== undefined ? { chromePath } : {}),
          nodePath,
          transportId,
        },
        deps
      );
      results.push({ target: item, result });
    } catch (err) {
      // applyIdeConfig never throws — it returns { ok:false, reason:"error" }.
      // Catch defensively for future callers that bypass the contract.
      results.push({
        target: item,
        result: {
          ok: false,
          reason: "error",
          message: err instanceof Error ? err.message : String(err),
          transportId: transportByIde[item] ?? MCP_TRANSPORT_DEFAULT,
        },
      });
    }
  }

  return {
    statuses: getIdeStatuses(serverPath, chromePath),
    results,
  };
}

export function removeTarget(target: IdeTarget): void {
  removeIdeConfig(target);
}

function getPerplexityRulesContent(): string {
  return [
    PERPLEXITY_RULES_SECTION_START,
    "# Perplexity MCP Server",
    "",
    "## Available Tools",
    "",
    "- **perplexity_search** — Fast web search with source citations. Use for quick factual lookups. Works with or without authentication.",
    "- **perplexity_reason** — Step-by-step reasoning with web context. Requires Pro account.",
    "- **perplexity_research** — Deep multi-section research reports (30-120s). Requires Pro account.",
    "- **perplexity_ask** — Flexible queries with explicit model/mode/follow-up control.",
    "- **perplexity_compute** — ASI/Computer mode for complex multi-step tasks. Requires Max account.",
    "- **perplexity_models** — List available models, account tier, and rate limits.",
    "- **perplexity_retrieve** — Poll results from pending research/compute tasks.",
    "- **perplexity_list_researches** — List saved research history with status.",
    "- **perplexity_get_research** — Fetch full content of a saved research.",
    "- **perplexity_login** — Open browser for Perplexity authentication.",
    "",
    "## Usage Guidelines",
    "",
    "1. **Start with perplexity_search** for quick questions. Only escalate to research or reason when depth is needed.",
    "2. **Check rate limits** with perplexity_models before batch operations.",
    "3. **Always cite sources** from search results in your responses.",
    "4. **For multi-turn conversations**, pass the follow_up_context JSON from perplexity_ask responses back in subsequent calls.",
    "5. **Long-running research**: perplexity_compute may time out. Use perplexity_retrieve with the returned research_id to poll for results.",
    "6. **Language parameter**: Defaults to en-US. Set explicitly for non-English queries.",
    "",
    "## Model Selection",
    "",
    "| Tool | Default Model | Best For |",
    "|------|--------------|----------|",
    "| perplexity_search | pplx_pro | General web search |",
    "| perplexity_reason | claude46sonnetthinking | Step-by-step analysis |",
    "| perplexity_research | pplx_alpha | Deep research reports |",
    "| perplexity_compute | pplx_asi | Complex multi-step tasks |",
    PERPLEXITY_RULES_SECTION_END
  ].join("\n");
}

function getCursorRulesContent(): string {
  return [
    "---",
    'description: Perplexity MCP server usage guidelines',
    'alwaysApply: true',
    "---",
    "",
    getPerplexityRulesContent()
  ].join("\n");
}

function getWindsurfRulesContent(): string {
  return [
    "---",
    'trigger: always',
    'description: Perplexity MCP server usage guidelines',
    "---",
    "",
    getPerplexityRulesContent()
  ].join("\n");
}

function getCopilotRulesContent(): string {
  return [
    "---",
    'applyTo: "**/*"',
    "---",
    "",
    getPerplexityRulesContent()
  ].join("\n");
}

/**
 * Classifies how the Perplexity-managed marker block appears in `existing`.
 *
 * - `missing`:   no start marker AND no end marker — safe to append a fresh block.
 * - `found`:     exactly one start marker and exactly one end marker, in the
 *                correct order (`startIdx < endIdx`). Safe to replace in-place.
 * - `malformed`: anything else — reversed markers, unmatched count, or
 *                duplicate pairs. The file is already damaged; callers must
 *                NOT attempt to "fix" it by slicing, because that silently
 *                deletes whatever the user wrote between the tangled markers.
 *                Upsert should append fresh; remove should bail out.
 *
 * Pulled out of `upsertSectionInFile`/`removeSectionFromFile` so the two
 * call sites stay in sync and the classification is unit-testable on its own.
 */
type MarkerBlockState =
  | { state: "missing" }
  | { state: "found"; startIdx: number; endIdx: number }
  | { state: "malformed"; reason: "reversed" | "unmatched" | "duplicate" };

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

export function findMarkerBlock(
  existing: string,
  startMarker: string,
  endMarker: string
): MarkerBlockState {
  const startCount = countOccurrences(existing, startMarker);
  const endCount = countOccurrences(existing, endMarker);

  if (startCount === 0 && endCount === 0) return { state: "missing" };
  if (startCount !== 1 || endCount !== 1) {
    // Either only one side is present (unmatched) or the user (or a prior
    // buggy write) left multiple pairs. Either way, don't slice.
    const reason: "unmatched" | "duplicate" =
      startCount > 1 || endCount > 1 ? "duplicate" : "unmatched";
    return { state: "malformed", reason };
  }

  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx > endIdx) {
    return { state: "malformed", reason: "reversed" };
  }
  return { state: "found", startIdx, endIdx };
}

export function upsertSectionInFile(filePath: string, content: string): void {
  const startMarker = PERPLEXITY_RULES_SECTION_START;
  const endMarker = PERPLEXITY_RULES_SECTION_END;

  mkdirSync(dirname(filePath), { recursive: true });

  if (!existsSync(filePath)) {
    writeTextAtomic(filePath, content + "\n");
    return;
  }

  const existing = readFileSync(filePath, "utf8");
  const block = findMarkerBlock(existing, startMarker, endMarker);

  if (block.state === "found") {
    const before = existing.slice(0, block.startIdx);
    const after = existing.slice(block.endIdx + endMarker.length);
    writeTextAtomic(filePath, before + content + after);
    return;
  }

  if (block.state === "malformed") {
    // Don't slice — that would drop whatever the user wrote between the
    // tangled markers. Append a fresh, well-formed block at the end and
    // leave the broken one alone for the user to clean up manually.
    console.warn(
      `[perplexity-mcp] ${filePath}: existing Perplexity marker block is malformed (${block.reason}); appending a fresh block instead of overwriting.`
    );
  }

  // `missing` or `malformed` — both fall through to append-fresh.
  writeTextAtomic(filePath, existing.trimEnd() + "\n\n" + content + "\n");
}

export function removeSectionFromFile(filePath: string): void {
  if (!existsSync(filePath)) return;

  const existing = readFileSync(filePath, "utf8");
  const block = findMarkerBlock(
    existing,
    PERPLEXITY_RULES_SECTION_START,
    PERPLEXITY_RULES_SECTION_END
  );

  if (block.state === "missing") return;

  if (block.state === "malformed") {
    // The file is already broken — don't make it worse by guessing at
    // which pair to strip. Leave it for the user.
    console.warn(
      `[perplexity-mcp] ${filePath}: existing Perplexity marker block is malformed (${block.reason}); leaving file untouched.`
    );
    return;
  }

  const before = existing.slice(0, block.startIdx).trimEnd();
  const after = existing
    .slice(block.endIdx + PERPLEXITY_RULES_SECTION_END.length)
    .trimStart();
  const result = before + (after ? "\n\n" + after : "\n");
  writeTextAtomic(filePath, result);
}

export function syncRulesForIde(target: IdeTarget, workspaceRoot?: string): RulesStatus {
  const meta = IDE_METADATA[target];
  const base: RulesStatus = { ide: target, rulesPath: "", hasPerplexitySection: false };
  if (!meta?.rulesPath || meta.rulesFormat === "none") return base;

  const root = workspaceRoot ?? process.cwd();
  const fullPath = join(root, meta.rulesPath);
  base.rulesPath = fullPath;

  try {
    let content: string;
    switch (meta.rulesFormat) {
      case "mdc":
        content = getCursorRulesContent();
        writeTextAtomic(fullPath, content + "\n");
        break;
      case "md":
        if (target === "copilot") {
          content = getCopilotRulesContent();
        } else if (target === "windsurf") {
          content = getWindsurfRulesContent();
        } else {
          content = getPerplexityRulesContent();
        }
        writeTextAtomic(fullPath, content + "\n");
        break;
      case "md-section":
        upsertSectionInFile(fullPath, getPerplexityRulesContent());
        break;
      default:
        return base;
    }
    base.hasPerplexitySection = true;
    base.lastUpdated = new Date().toISOString();
  } catch { /* skip on error */ }

  return base;
}

export function removeRulesForIde(target: IdeTarget, workspaceRoot?: string): void {
  const meta = IDE_METADATA[target];
  if (!meta?.rulesPath || meta.rulesFormat === "none") return;

  const root = workspaceRoot ?? process.cwd();
  const fullPath = join(root, meta.rulesPath);

  if (!existsSync(fullPath)) return;

  if (meta.rulesFormat === "md-section") {
    removeSectionFromFile(fullPath);
  } else {
    const content = readFileSync(fullPath, "utf8");
    if (content.includes(PERPLEXITY_RULES_SECTION_START)) {
      removeTarget(target);
    }
  }
}

export function getRulesStatuses(workspaceRoot?: string): RulesStatus[] {
  const root = workspaceRoot ?? process.cwd();
  const result: RulesStatus[] = [];

  for (const [key, meta] of Object.entries(IDE_METADATA)) {
    if (!meta.rulesPath || meta.rulesFormat === "none") continue;

    const fullPath = join(root, meta.rulesPath);
    const status: RulesStatus = {
      ide: key as IdeTarget,
      rulesPath: fullPath,
      hasPerplexitySection: false
    };

    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf8");
        status.hasPerplexitySection = content.includes(PERPLEXITY_RULES_SECTION_START);
        status.lastUpdated = statSync(fullPath).mtime.toISOString();
      } catch { /* skip */ }
    }

    result.push(status);
  }

  return result;
}
