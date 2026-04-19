import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  IDE_METADATA,
  PERPLEXITY_MCP_SERVER_KEY,
  PERPLEXITY_RULES_SECTION_START,
  PERPLEXITY_RULES_SECTION_END,
  type IdeStatus,
  type IdeTarget,
  type RulesStatus
} from "@perplexity/shared";
import { checkLauncherHealth } from "../launcher/write-launcher.js";

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
}

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
 */
function resolveNodePath(): string {
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
  return toml.includes(`[mcp_servers.${serverName}]`);
}

function buildTomlMcpBlock(serverName: string, serverConfig: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${serverName}]`);
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
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tempPath, configPath);
}

export function applyIdeConfig(options: IdeConfigOptions): string {
  const meta = IDE_METADATA[options.target];
  if (!meta?.autoConfigurable) {
    throw new Error(`${options.target} does not support automatic MCP configuration.`);
  }

  const configPath = options.configPath ?? getIdeConfigPath(options.target);
  const serverName = options.serverName ?? PERPLEXITY_MCP_SERVER_KEY;
  const serverConfig = buildServerConfig(options.serverPath, {
    nodePath: options.nodePath,
    chromePath: options.chromePath
  });

  if (existsSync(configPath)) {
    copyFileSync(configPath, `${configPath}.bak`);
  }

  if (meta.configFormat === "toml") {
    // TOML format (Codex CLI)
    const existing = readTomlFile(configPath);
    const merged = mergeTomlMcpServer(existing, serverName, serverConfig);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, merged, "utf8");
  } else {
    // JSON format (all other IDEs)
    const existingConfig = readExistingConfig(configPath);
    const mergedConfig = mergeMcpConfig(existingConfig, serverName, serverConfig);
    writeJsonAtomic(configPath, mergedConfig);
  }

  return configPath;
}

export function removeIdeConfig(target: IdeTarget, options?: { configPath?: string; serverName?: string }): void {
  const meta = IDE_METADATA[target];
  if (!meta?.autoConfigurable) return;

  const configPath = options?.configPath ?? getIdeConfigPath(target);
  const serverName = options?.serverName ?? PERPLEXITY_MCP_SERVER_KEY;

  if (!existsSync(configPath)) return;
  copyFileSync(configPath, `${configPath}.bak`);

  if (meta.configFormat === "toml") {
    const existing = readTomlFile(configPath);
    const cleaned = removeTomlMcpServer(existing, serverName);
    writeFileSync(configPath, cleaned, "utf8");
  } else {
    const existingConfig = readExistingConfig(configPath);
    const cleaned = removeMcpEntry(existingConfig, serverName);
    writeJsonAtomic(configPath, cleaned);
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

    if (meta.configFormat === "toml") {
      const toml = readFileSync(configPath, "utf8");
      configured = tomlHasMcpServer(toml, serverName);
      if (configured) {
        // Extract args from TOML: args = ["path/to/server"]
        const argsMatch = toml.match(/args\s*=\s*\[([^\]]*)\]/);
        if (argsMatch) {
          const argsStr = argsMatch[1];
          const argValues = [...argsStr.matchAll(/"([^"]*)"/g)].map(m => m[1]);
          configuredArgs = argValues;
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
        const serverEntry = config.mcpServers[serverName] as { args?: string[] } | undefined;
        if (serverEntry?.args && Array.isArray(serverEntry.args)) {
          configuredArgs = serverEntry.args;
        }
      }
    }

    const health: IdeStatus["health"] = configured
      ? checkLauncherHealth(configuredArgs)
      : "missing";

    return {
      ...base,
      configured,
      health,
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

export function configureTargets(
  target: IdeTarget | "all",
  serverPath: string,
  chromePath?: string
): Record<string, IdeStatus> {
  const targets: IdeTarget[] = target === "all"
    ? AUTO_CONFIGURABLE_IDES
    : [target];

  for (const item of targets) {
    const meta = IDE_METADATA[item];
    if (meta?.autoConfigurable) {
      try {
        applyIdeConfig({ target: item, serverPath, chromePath });
      } catch { /* skip on error */ }
    }
  }

  return getIdeStatuses(serverPath, chromePath);
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

function upsertSectionInFile(filePath: string, content: string): void {
  const startMarker = PERPLEXITY_RULES_SECTION_START;
  const endMarker = PERPLEXITY_RULES_SECTION_END;

  mkdirSync(dirname(filePath), { recursive: true });

  if (!existsSync(filePath)) {
    writeFileSync(filePath, content + "\n", "utf8");
    return;
  }

  const existing = readFileSync(filePath, "utf8");
  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + endMarker.length);
    writeFileSync(filePath, before + content + after, "utf8");
  } else {
    writeFileSync(filePath, existing.trimEnd() + "\n\n" + content + "\n", "utf8");
  }
}

function removeSectionFromFile(filePath: string): void {
  if (!existsSync(filePath)) return;

  const existing = readFileSync(filePath, "utf8");
  const startIdx = existing.indexOf(PERPLEXITY_RULES_SECTION_START);
  const endIdx = existing.indexOf(PERPLEXITY_RULES_SECTION_END);

  if (startIdx === -1 || endIdx === -1) return;

  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + PERPLEXITY_RULES_SECTION_END.length).trimStart();
  const result = before + (after ? "\n\n" + after : "\n");
  writeFileSync(filePath, result, "utf8");
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
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content + "\n", "utf8");
        break;
      case "md":
        if (target === "copilot") {
          content = getCopilotRulesContent();
        } else if (target === "windsurf") {
          content = getWindsurfRulesContent();
        } else {
          content = getPerplexityRulesContent();
        }
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content + "\n", "utf8");
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
