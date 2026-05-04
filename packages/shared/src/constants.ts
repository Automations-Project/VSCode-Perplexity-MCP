export const EXTENSION_ID = "Perplexity";
export const MCP_PROVIDER_ID = "Perplexity.server";
export const MCP_SERVER_LABEL = "Perplexity MCP";

export const MCP_TOOL_NAMES = [
  "perplexity_search",
  "perplexity_reason",
  "perplexity_research",
  "perplexity_ask",
  "perplexity_models",
  "perplexity_compute",
  "perplexity_retrieve",
  "perplexity_list_researches",
  "perplexity_get_research",
  "perplexity_login",
] as const;

export const MCP_CONFIG_FILE_NAMES = {
  cursor: ".cursor/mcp.json",
  windsurf: ".codeium/windsurf/mcp_config.json",
} as const;

export const HISTORY_LIMIT = 50;

export const PERPLEXITY_RULES_SECTION_START = "<!-- PERPLEXITY-MCP-START -->";
export const PERPLEXITY_RULES_SECTION_END = "<!-- PERPLEXITY-MCP-END -->";
export const PERPLEXITY_MCP_SERVER_KEY = "Perplexity";

// Phase 8.6: per-IDE MCP transport picker. The picker UI (8.6.5) and config
// generators (8.6.3, 8.6.4) consume these; 8.6.2 lands the shape only.
export type McpTransportId =
  | "stdio-in-process"
  | "stdio-daemon-proxy"
  | "http-loopback"
  | "http-tunnel";

export const MCP_TRANSPORT_DEFAULT: McpTransportId = "stdio-daemon-proxy";

export const MCP_TRANSPORT_IDS: ReadonlyArray<McpTransportId> = [
  "stdio-in-process",
  "stdio-daemon-proxy",
  "http-loopback",
  "http-tunnel",
] as const;

export interface IdeCapabilities {
  stdio: boolean;
  httpBearerLoopback: boolean;
  httpOAuthLoopback: boolean;
  httpOAuthTunnel: boolean;
  /** Required when any non-stdio capability is true. Values are URL paths to primary-source docs OR relative paths to smoke-evidence files. */
  evidence?: Partial<Record<Exclude<keyof IdeCapabilities, "stdio" | "evidence">, string>>;
}

export interface IdeMeta {
  displayName: string;
  configFormat: "json" | "toml" | "yaml" | "ui-only";
  /** JSON clients vary between mcpServers, servers, context_servers, and mcp. Defaults to mcpServers. */
  jsonConfigRootKey?: "mcpServers" | "servers" | "context_servers" | "mcp";
  /** Some clients require a type field in each JSON server entry. */
  jsonServerTypeField?: boolean;
  /** Some clients use a native JSON server entry shape instead of command+args. */
  jsonServerEntryFormat?: "standard" | "opencode";
  /** Workspace-scoped configs require an open folder; user-scoped configs live under homedir/appdata. */
  configScope?: "user" | "workspace";
  autoConfigurable: boolean;
  rulesFormat?: "mdc" | "md" | "md-section" | "yaml" | "toml" | "none";
  rulesPath?: string;
  capabilities: IdeCapabilities;
}

// HTTP caps start `false` everywhere: they are evidence-gated and only flip
// to `true` in follow-up commits accompanied by dated docs/smoke-evidence/*.md
// files. `stdio` is `false` for `ui-only` clients (they don't ingest mcp.json).
export const IDE_METADATA: Record<string, IdeMeta> = {
  cursor: {
    displayName: "Cursor",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "mdc",
    rulesPath: ".cursor/rules/perplexity-mcp.mdc",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  windsurf: {
    displayName: "Windsurf",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md",
    rulesPath: ".windsurf/rules/perplexity-mcp.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  windsurfNext: {
    displayName: "Windsurf Next",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md",
    rulesPath: ".windsurf/rules/perplexity-mcp.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  claudeDesktop: {
    displayName: "Claude Desktop",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "none",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  claudeCode: {
    displayName: "Claude Code",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "CLAUDE.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  cline: {
    displayName: "Cline",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md",
    rulesPath: ".clinerules/perplexity-mcp.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  amp: {
    displayName: "Amp (Sourcegraph)",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  rooCode: {
    displayName: "Roo Code",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "md",
    rulesPath: ".roo/rules/perplexity-mcp.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  codexCli: {
    displayName: "Codex CLI",
    configFormat: "toml",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  continueDev: {
    displayName: "Continue.dev",
    configFormat: "yaml",
    autoConfigurable: false,
    rulesFormat: "yaml",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  copilot: {
    displayName: "GitHub Copilot",
    configFormat: "ui-only",
    autoConfigurable: false,
    rulesFormat: "md",
    rulesPath: ".github/instructions/perplexity-mcp.instructions.md",
    capabilities: {
      // ui-only: client doesn't ingest mcp.json, so stdio is N/A.
      stdio: false,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  vscode: {
    displayName: "VS Code MCP",
    configFormat: "json",
    jsonConfigRootKey: "servers",
    jsonServerTypeField: true,
    configScope: "workspace",
    autoConfigurable: true,
    rulesFormat: "none",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  zed: {
    displayName: "Zed",
    configFormat: "json",
    jsonConfigRootKey: "context_servers",
    autoConfigurable: false,
    rulesFormat: "md-section",
    rulesPath: ".rules",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  geminiCli: {
    displayName: "Gemini CLI",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "GEMINI.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  antigravity: {
    // 2026-05: Path `~/.gemini/antigravity/mcp_config.json` only documented via
    // third-party guides (e.g. github-mcp-server install-antigravity.md). Keep
    // auto-config disabled until the path appears in official Antigravity docs
    // or we have a smoke-evidence file confirming write-then-load roundtrip.
    displayName: "Google Antigravity",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  kiro: {
    displayName: "Kiro",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md",
    rulesPath: ".kiro/steering/perplexity-mcp.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  firebaseStudio: {
    displayName: "Firebase Studio",
    configFormat: "json",
    configScope: "workspace",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "GEMINI.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  amazonQ: {
    displayName: "Amazon Q Developer",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "none",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  goose: {
    displayName: "Goose",
    configFormat: "yaml",
    autoConfigurable: false,
    rulesFormat: "none",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  warp: {
    // Warp's MCP servers are configured exclusively through the in-app
    // Settings UI; there is no documented file-based config. We only own the
    // AGENTS.md rules block — Warp does honour AGENTS.md project rules.
    displayName: "Warp",
    configFormat: "ui-only",
    autoConfigurable: false,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
    capabilities: {
      stdio: false,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  trae: {
    displayName: "Trae",
    configFormat: "json",
    configScope: "workspace",
    autoConfigurable: false,
    rulesFormat: "none",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  aider: {
    displayName: "Aider",
    configFormat: "yaml",
    autoConfigurable: false,
    rulesFormat: "none",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  augment: {
    displayName: "Augment Code",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "md",
    rulesPath: ".augment/rules/perplexity-mcp.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  // 2026-05 expansion. Each entry below cites a primary-source doc URL inline
  // so future audits can re-verify path + root-key without re-discovering the
  // upstream reference.
  vs2022: {
    // https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers?view=vs-2022
    // Root key is `servers` (matches VS Code MCP). Workspace-preferred path is
    // `<sln>/.mcp.json` (source-controllable). User-global is `~/.mcp.json`.
    displayName: "Visual Studio 2022",
    configFormat: "json",
    jsonConfigRootKey: "servers",
    jsonServerTypeField: true,
    configScope: "workspace",
    autoConfigurable: true,
    rulesFormat: "none",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  copilotCli: {
    // https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
    // User-level config at `~/.copilot/mcp-config.json`, project overrides at
    // `.mcp.json` or `.github/mcp.json`. Root key is `mcpServers`.
    displayName: "GitHub Copilot CLI",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  openCode: {
    // https://opencode.ai/docs/config/ and https://opencode.ai/docs/mcp-servers/
    // Root key is `mcp` (NOT mcpServers). Global at
    // `~/.config/opencode/opencode.json`; project at `opencode.json`.
    // Local servers use `{ type:"local", command:[...], environment:{...} }`.
    // Rules are `AGENTS.md`; opencode also supports `instructions` globs.
    displayName: "OpenCode",
    configFormat: "json",
    jsonConfigRootKey: "mcp",
    jsonServerEntryFormat: "opencode",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  factoryDroid: {
    // https://docs.factory.ai/cli/configuration/mcp — `~/.factory/mcp.json`
    // (user) or `.factory/mcp.json` (project). Root key `mcpServers`.
    displayName: "Factory Droid",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  qwenCode: {
    // https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/ — settings
    // file at `~/.qwen/settings.json` (user) or `.qwen/settings.json` (project).
    // Root key is `mcpServers`.
    displayName: "Qwen Code",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  kiloCode: {
    // https://kilo.ai/docs/features/mcp/using-mcp-in-kilo-code — uses `kilo.jsonc`
    // (JSON-with-comments) with root key `mcp`. Our writer is JSON-only and
    // would strip user comments, so keep auto-config off until JSONC support
    // lands. Path-detection only for now.
    displayName: "Kilo Code",
    configFormat: "json",
    jsonConfigRootKey: "mcp",
    autoConfigurable: false,
    rulesFormat: "none",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  lmStudio: {
    // https://lmstudio.ai/docs/app/plugins/mcp — `mcp.json` is GUI-managed via
    // "Program → Edit mcp.json"; the on-disk path isn't stably documented.
    // Treat as ui-only; LM Studio doesn't read project-level rules.
    displayName: "LM Studio",
    configFormat: "ui-only",
    autoConfigurable: false,
    rulesFormat: "none",
    capabilities: {
      stdio: false,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
};
